//! Windows-клиент Obsidian: тонкая обвязка вокруг obsidian-core.
//!
//! Здесь нет ни криптографии, ни ключей, ни сетевого протокола — всё это живёт
//! в ядре. Задача этого файла ровно две: открыть базу под введённым паролем и
//! перекладывать команды и события между WebView и ядром.
//!
//! Словарь тот же, что у Android-обвязки (`command.rs`): новая кнопка в
//! интерфейсе — это новый вариант команды, а не новый Rust-код здесь.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use obsidian_core::client::Engine;
use obsidian_core::command::Command;
use rand_core::{OsRng, RngCore};
use tauri::{AppHandle, Emitter, Manager, State};
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Канал, по которому события ядра доезжают до окна.
const EVENT_CHANNEL: &str = "obsidian:event";

#[derive(Default)]
struct Core {
    engine: Mutex<Option<Engine>>,
}

fn data_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let db = match std::env::var("OBSIDIAN_DB") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|err| format!("нет каталога данных: {err}"))?
            .join("obsidian.db"),
    };
    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("не создать каталог данных: {err}"))?;
    }
    let key = db.with_extension("key.dpapi");
    Ok((db, key))
}

fn protect_for_current_user(secret: &[u8]) -> Result<Vec<u8>, String> {
    let input_len = u32::try_from(secret.len()).map_err(|_| "ключ слишком длинный")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: secret.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &input,
            windows::core::w!("Obsidian database key"),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| format!("Windows не защитила ключ: {err}"))?;

        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(protected)
    }
}

fn unprotect_for_current_user(protected: &[u8]) -> Result<Vec<u8>, String> {
    let input_len = u32::try_from(protected.len()).map_err(|_| "файл ключа слишком большой")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: protected.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| format!("Windows не открыла ключ: {err}"))?;

        let secret = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(secret)
    }
}

fn save_protected_key(path: &PathBuf, secret: &[u8]) -> Result<(), String> {
    let protected = protect_for_current_user(secret)?;
    let temporary = path.with_extension("key.dpapi.tmp");
    std::fs::write(&temporary, protected).map_err(|err| format!("не сохранить ключ: {err}"))?;
    std::fs::rename(&temporary, path).map_err(|err| format!("не зафиксировать ключ: {err}"))
}

/// Убирает старую базу из рабочего профиля, не уничтожая её безвозвратно.
/// Пользователь видит это как сброс, а файлы остаются в `legacy-backups`,
/// если позже всё-таки вспомнится пароль.
fn archive_legacy_database(db: &PathBuf) -> Result<PathBuf, String> {
    let parent = db.parent().ok_or("у базы нет родительского каталога")?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "системное время некорректно")?
        .as_secs();
    let backup = parent.join("legacy-backups").join(timestamp.to_string());
    std::fs::create_dir_all(&backup).map_err(|err| format!("не создать резервную папку: {err}"))?;

    let companions = [
        db.clone(),
        PathBuf::from(format!("{}-wal", db.display())),
        PathBuf::from(format!("{}-shm", db.display())),
    ];
    for source in companions {
        if !source.exists() {
            continue;
        }
        let name = source.file_name().ok_or("не разобрать имя файла базы")?;
        std::fs::rename(&source, backup.join(name))
            .map_err(|err| format!("не убрать старую базу: {err}"))?;
    }
    Ok(backup)
}

fn verify_database_key(db: &PathBuf, secret: &[u8]) -> Result<(), String> {
    let store = obsidian_core::store::Store::open(&db.to_string_lossy(), secret).map_err(
        |err| match err {
            obsidian_core::CoreError::StoreLocked => "неверный пароль".to_string(),
            other => other.to_string(),
        },
    )?;
    if store.has_credentials().map_err(|err| err.to_string())? {
        store.load_credentials().map_err(|err| match err {
            obsidian_core::CoreError::StoreLocked => "неверный пароль".to_string(),
            other => other.to_string(),
        })?;
    }
    Ok(())
}

fn start_engine(app: &AppHandle, core: &Arc<Core>, password: Vec<u8>) -> Result<(), String> {
    let mut slot = core.engine.lock().map_err(|_| "core lock poisoned")?;
    if slot.is_some() {
        return Ok(());
    }
    let (db, _) = data_paths(app)?;
    verify_database_key(&db, &password)?;
    let window = app.clone();
    let engine = Engine::start(
        db.to_string_lossy().into_owned(),
        password,
        Arc::new(move |event| {
            if let Ok(json) = serde_json::to_string(&event) {
                let _ = window.emit(EVENT_CHANNEL, json);
            }
        }),
    )
    .map_err(|err| match err {
        obsidian_core::CoreError::StoreLocked => "неверный пароль".to_string(),
        other => other.to_string(),
    })?;
    *slot = Some(engine);
    Ok(())
}

/// Автоматически открывает базу. `false` означает старую базу без DPAPI-ключа:
/// интерфейс один раз попросит прежний пароль и сохранит его защищённо.
#[tauri::command]
fn auto_unlock(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<bool, String> {
    if core
        .engine
        .lock()
        .map_err(|_| "core lock poisoned")?
        .is_some()
    {
        return Ok(true);
    }
    let (db, key_path) = data_paths(&app)?;
    if key_path.exists() {
        let protected =
            std::fs::read(&key_path).map_err(|err| format!("не прочитать ключ: {err}"))?;
        let secret = unprotect_for_current_user(&protected)?;
        start_engine(&app, &core, secret)?;
        return Ok(true);
    }
    if db.exists() {
        return Ok(false);
    }

    let mut secret = vec![0u8; 32];
    OsRng.fill_bytes(&mut secret);
    save_protected_key(&key_path, &secret)?;
    start_engine(&app, &core, secret)?;
    Ok(true)
}

/// Однократная миграция базы, созданной старой версией приложения.
#[tauri::command]
fn unlock_existing(
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    password: String,
) -> Result<(), String> {
    let (db, key_path) = data_paths(&app)?;
    let secret = password.into_bytes();
    // Проверяем пароль по зашифрованному keyring до записи DPAPI-файла.
    verify_database_key(&db, &secret)?;
    save_protected_key(&key_path, &secret)?;
    start_engine(&app, &core, secret)
}

/// Сбрасывает неизвестную старую базу и сразу создаёт новую с DPAPI-ключом.
#[tauri::command]
fn reset_legacy_database(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<String, String> {
    if core
        .engine
        .lock()
        .map_err(|_| "core lock poisoned")?
        .is_some()
    {
        return Err("база уже открыта".to_string());
    }
    let (db, key_path) = data_paths(&app)?;
    if key_path.exists() {
        return Err("защищённую базу нельзя сбросить с этого экрана".to_string());
    }

    let backup = archive_legacy_database(&db)?;
    let mut secret = vec![0u8; 32];
    OsRng.fill_bytes(&mut secret);
    save_protected_key(&key_path, &secret)?;
    start_engine(&app, &core, secret)?;
    Ok(backup.to_string_lossy().into_owned())
}

/// Единственная точка входа для интерфейса: команда в JSON — как в FFI.
#[tauri::command]
fn submit(core: State<'_, Arc<Core>>, json: String) -> Result<(), String> {
    let command: Command =
        serde_json::from_str(&json).map_err(|err| format!("команда не разобрана: {err}"))?;
    let slot = core.engine.lock().map_err(|_| "core lock poisoned")?;
    slot.as_ref()
        .ok_or("база ещё не открыта")?
        .submit(command)
        .map_err(|err| err.to_string())
}

/// Заперта ли база. Окно спрашивает при загрузке, чтобы понять, какой экран
/// показывать после перезагрузки WebView.
/// Кнопки собственной полосы заголовка.
///
/// Своими командами, а не через глобальный объект окна в JS: набор
/// пространств имён в `withGlobalTauri` собирается по фичам, и надеяться на
/// то, что нужное там окажется, — значит получить кнопки, которые молча ничего
/// не делают. Проверено: именно так и было.
#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|err| err.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|err| err.to_string())? {
        window.unmaximize().map_err(|err| err.to_string())
    } else {
        window.maximize().map_err(|err| err.to_string())
    }
}

#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|err| err.to_string())
}

/// Тянет окно за пустое место полосы заголовка.
#[tauri::command]
fn window_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|err| err.to_string())
}

#[tauri::command]
fn open_update(url: String) -> Result<(), String> {
    if !url.starts_with("https://getobsidian.xyz/downloads/") {
        return Err("недопустимый адрес обновления".into());
    }
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("не открыть загрузку: {err}"))
}

#[tauri::command]
fn is_unlocked(core: State<'_, Arc<Core>>) -> bool {
    core.engine
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                allow_microphone(&window);
            }
            Ok(())
        })
        .manage(Arc::new(Core::default()))
        .invoke_handler(tauri::generate_handler![
            auto_unlock,
            unlock_existing,
            reset_legacy_database,
            submit,
            is_unlocked,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_drag,
            open_update
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить окно");
}

/// Разрешает WebView2 микрофон и запрещает всё остальное.
///
/// Без этого голосовые не записываются вовсе: WebView2 по умолчанию отклоняет
/// `getUserMedia`, и запрос возвращается с `NotAllowedError`, ничего не
/// спросив у человека.
///
/// Разрешение выдаётся молча, потому что спрашивать здесь нечего: микрофон
/// открывается только на время записи и только после нажатия кнопки — она и
/// есть согласие. Всё прочее — камера, геопозиция, уведомления, буфер обмена —
/// отклоняется явно: страница в этом окне одна, своя, и просить остальное ей
/// незачем.
fn allow_microphone(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let result = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        // Токен отписки в этой привязке — просто i64.
        let mut token = 0i64;
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = Default::default();
            args.PermissionKind(&mut kind)?;
            args.SetState(if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                COREWEBVIEW2_PERMISSION_STATE_ALLOW
            } else {
                COREWEBVIEW2_PERMISSION_STATE_DENY
            })
        }));
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });

    if result.is_err() {
        // Не повод не запускаться: без разрешения перестанут работать только
        // голосовые, а переписка и всё остальное — нет.
        eprintln!("не удалось подписаться на запросы разрешений WebView2");
    }
}

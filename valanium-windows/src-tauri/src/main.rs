//! Windows-клиент Valanium: тонкая обвязка вокруг valanium-core.
//!
//! Здесь нет ни криптографии, ни ключей, ни сетевого протокола — всё это живёт
//! в ядре. Задача этого файла ровно две: открыть базу под введённым паролем и
//! перекладывать команды и события между WebView и ядром.
//!
//! Словарь тот же, что у Android-обвязки (`command.rs`): новая кнопка в
//! интерфейсе — это новый вариант команды, а не новый Rust-код здесь.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod badge;
mod onionize;

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use valanium_core::client::Engine;
use valanium_core::command::Command;
use rand_core::{OsRng, RngCore};
use tauri::{AppHandle, Emitter, Manager, State};
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Не показывать консоль при запуске сторонней программы.
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Канал, по которому события ядра доезжают до окна.
const EVENT_CHANNEL: &str = "valanium:event";

/// Окно-карточка уведомления. Одно на все уведомления, см. `show_desktop_notification`.
const NOTIFICATION_LABEL: &str = "notification";

/// Канал, по которому карточке приезжает следующее уведомление.
const NOTIFICATION_CHANNEL: &str = "valanium:notification";

/// Канал, по которому карточка просит открыть беседу.
const OPEN_CHAT_CHANNEL: &str = "valanium:open-chat";

#[derive(Default)]
struct Core {
    engine: Mutex<Option<Engine>>,
}

fn data_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let db = match std::env::var("VALANIUM_DB") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => {
            let root = app
                .path()
                .app_data_dir()
                .map_err(|err| format!("нет каталога данных: {err}"))?;
            std::fs::create_dir_all(&root)
                .map_err(|err| format!("не создать каталог данных: {err}"))?;
            let selected = std::fs::read_to_string(root.join("active-profile"))
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|name| {
                    name.starts_with("valanium-session-")
                        && name.ends_with(".db")
                        && name.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
                });
            root.join(selected.as_deref().unwrap_or("valanium.db"))
        }
    };
    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("не создать каталог данных: {err}"))?;
    }
    let key = db.with_extension("key.dpapi");
    Ok((db, key))
}

/*
   Замок приложения на Windows.

   DPAPI привязывает файл ключа к учётной записи Windows — этого хватает
   против «унесли диск», но не против чего-либо, работающего под этой же
   учёткой: расшифровать файл сможет любая программа пользователя.

   Второй аргумент DPAPI — «энтропия», произвольные байты, без которых файл не
   открыть. Мы кладём туда ключ, выведенный Argon2id из пароля человека, и
   пароль этот нигде не хранится. Дальше действует то же правило, что и на
   Android: без него база не открывается, и не открывается ни для кого.

   Формат файла: `OBSL1` + 16 байт соли + защищённый блоб. Файла без метки
   касается прежний путь — заголовка там нет, замка тоже.
*/
const LOCK_MAGIC: &[u8] = b"OBSL1";
const LOCK_SALT_LEN: usize = 16;

/// Энтропия DPAPI из пароля. Argon2id, те же параметры, что и у базы.
fn lock_entropy(password: &str, salt: &[u8]) -> Result<Vec<u8>, String> {
    valanium_core::crypto::MasterKey::derive(password.as_bytes(), salt)
        .map(|key| key.into_bytes().to_vec())
        .map_err(|err| format!("не вывести ключ из пароля: {err}"))
}

/// Стоит ли на файле ключа замок.
fn key_is_locked(path: &PathBuf) -> bool {
    std::fs::read(path)
        .map(|raw| raw.starts_with(LOCK_MAGIC))
        .unwrap_or(false)
}

/// Достаёт ключ базы из файла. `password` нужен, только если стоит замок.
fn read_key_file(path: &PathBuf, password: Option<&str>) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(path).map_err(|err| format!("не прочитать ключ: {err}"))?;
    if !raw.starts_with(LOCK_MAGIC) {
        return unprotect_for_current_user(&raw);
    }

    let head = LOCK_MAGIC.len() + LOCK_SALT_LEN;
    if raw.len() <= head {
        return Err("файл ключа повреждён".into());
    }
    let password = password.ok_or("нужен пароль запуска")?;
    let entropy = lock_entropy(password, &raw[LOCK_MAGIC.len()..head])?;
    // Неверный пароль здесь неотличим от порчи файла — так и должно быть:
    // DPAPI не рассказывает, что именно не сошлось.
    unprotect_with_entropy(&raw[head..], Some(&entropy))
        .map_err(|_| "неверный пароль запуска".to_string())
}

/// Кладёт ключ базы в файл. `password` — включить замок, `None` — снять.
fn write_key_file(path: &PathBuf, secret: &[u8], password: Option<&str>) -> Result<(), String> {
    let body = match password {
        None => protect_for_current_user(secret)?,
        Some(password) => {
            let mut salt = vec![0u8; LOCK_SALT_LEN];
            OsRng.fill_bytes(&mut salt);
            let entropy = lock_entropy(password, &salt)?;
            let protected = protect_with_entropy(secret, Some(&entropy))?;

            let mut out = Vec::with_capacity(LOCK_MAGIC.len() + salt.len() + protected.len());
            out.extend_from_slice(LOCK_MAGIC);
            out.extend_from_slice(&salt);
            out.extend_from_slice(&protected);
            out
        }
    };

    // Через временный файл: обрыв посреди записи не должен оставить человека
    // с базой, которую нечем открыть.
    let temporary = path.with_extension("key.dpapi.tmp");
    std::fs::write(&temporary, &body).map_err(|err| format!("не записать ключ: {err}"))?;
    std::fs::rename(&temporary, path).map_err(|err| format!("не заменить ключ: {err}"))
}

fn protect_for_current_user(secret: &[u8]) -> Result<Vec<u8>, String> {
    protect_with_entropy(secret, None)
}

fn protect_with_entropy(secret: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut entropy_blob = entropy.map(|bytes| CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    });
    let entropy_blob = entropy_blob.take();
    let input_len = u32::try_from(secret.len()).map_err(|_| "ключ слишком длинный")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: secret.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &input,
            windows::core::w!("Valanium database key"),
            entropy_blob.as_ref().map(|blob| blob as *const _),
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
    unprotect_with_entropy(protected, None)
}

fn unprotect_with_entropy(protected: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut entropy_blob = entropy.map(|bytes| CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    });
    let entropy_blob = entropy_blob.take();
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
            entropy_blob.as_ref().map(|blob| blob as *const _),
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

/// Кладёт ключ без замка. Осталось для путей, где замка быть не может:
/// переезд старой базы, сброс неизвестной базы и выход из аккаунта.
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
    let store = valanium_core::store::Store::open(&db.to_string_lossy(), secret).map_err(
        |err| match err {
            valanium_core::CoreError::StoreLocked => "неверный пароль".to_string(),
            other => other.to_string(),
        },
    )?;
    if store.has_credentials().map_err(|err| err.to_string())? {
        store.load_credentials().map_err(|err| match err {
            valanium_core::CoreError::StoreLocked => "неверный пароль".to_string(),
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
        valanium_core::CoreError::StoreLocked => "неверный пароль".to_string(),
        other => other.to_string(),
    })?;
    *slot = Some(engine);
    Ok(())
}

/// Автоматически открывает базу. `false` означает старую базу без DPAPI-ключа:
/// интерфейс один раз попросит прежний пароль и сохранит его защищённо.
/// Что делать окну при запуске.
///
/// Три состояния вместо прежнего «да/нет»: база открыта, база под замком и
/// ждёт пароль, база старая и просит однократного переезда.
#[tauri::command]
fn auto_unlock(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<&'static str, String> {
    if core
        .engine
        .lock()
        .map_err(|_| "core lock poisoned")?
        .is_some()
    {
        return Ok("opened");
    }
    let (db, key_path) = data_paths(&app)?;
    if key_path.exists() {
        if key_is_locked(&key_path) {
            return Ok("locked");
        }
        let secret = read_key_file(&key_path, None)?;
        start_engine(&app, &core, secret)?;
        return Ok("opened");
    }
    if db.exists() {
        return Ok("legacy");
    }

    let mut secret = vec![0u8; 32];
    OsRng.fill_bytes(&mut secret);
    write_key_file(&key_path, &secret, None)?;
    start_engine(&app, &core, secret)?;
    Ok("opened")
}

/// Открывает базу паролем запуска.
#[tauri::command]
fn unlock_with_password(
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    password: String,
) -> Result<(), String> {
    let (_, key_path) = data_paths(&app)?;
    let secret = read_key_file(&key_path, Some(&password))?;
    start_engine(&app, &core, secret)
}

/// Стоит ли пароль на запуске.
#[tauri::command]
fn app_lock_enabled(app: AppHandle) -> Result<bool, String> {
    let (_, key_path) = data_paths(&app)?;
    Ok(key_is_locked(&key_path))
}

/// Включает, меняет или снимает пароль запуска.
///
/// `current` нужен, когда замок уже стоит: снять его, не зная пароля, нельзя —
/// иначе замок был бы украшением. `next` пустой означает «снять».
#[tauri::command]
fn set_app_lock(app: AppHandle, current: String, next: String) -> Result<bool, String> {
    let (_, key_path) = data_paths(&app)?;
    let locked = key_is_locked(&key_path);
    if locked && current.is_empty() {
        return Err("нужен текущий пароль запуска".into());
    }

    let secret = read_key_file(&key_path, if locked { Some(&current) } else { None })?;
    let next = if next.is_empty() { None } else { Some(next.as_str()) };
    write_key_file(&key_path, &secret, next)?;
    Ok(next.is_some())
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

/// Выходит только на этом компьютере. Старую базу не перемещаем: её может
/// держать другая копия приложения в трее. Вместо этого атомарно выбираем новый
/// пустой локальный профиль, а прежние файлы остаются нетронутыми.
#[tauri::command]
fn logout_local_account(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<String, String> {
    if std::env::var("VALANIUM_DB").is_ok_and(|path| !path.is_empty()) {
        return Err("выход недоступен при запуске с VALANIUM_DB".to_string());
    }

    let engine = core
        .engine
        .lock()
        .map_err(|_| "core lock poisoned")?
        .take();
    if let Some(engine) = engine {
        engine.shutdown();
    }

    let (previous_db, _) = data_paths(&app)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("нет каталога данных: {err}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "системное время некорректно")?
        .as_millis();
    let filename = format!("valanium-session-{timestamp}-{}.db", std::process::id());
    let db = root.join(&filename);
    let key_path = db.with_extension("key.dpapi");

    let mut secret = vec![0u8; 32];
    OsRng.fill_bytes(&mut secret);
    save_protected_key(&key_path, &secret)?;
    verify_database_key(&db, &secret)?;
    std::fs::write(root.join("active-profile"), &filename)
        .map_err(|err| format!("не переключить локальный профиль: {err}"))?;
    start_engine(&app, &core, secret)?;
    Ok(previous_db.to_string_lossy().into_owned())
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

/// Крестик в полосе заголовка прячет окно, как и системный: приложение
/// остаётся на связи, выйти можно из меню значка в трее.
#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())
}

/// Тянет окно за пустое место полосы заголовка.
#[tauri::command]
fn window_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|err| err.to_string())
}

/// Отдельное always-on-top окно: уведомление видно поверх рабочего стола и
/// других программ, даже когда главное окно Valanium находится сзади.
///
/// Окно одно на все уведомления и переиспользуется: второе сообщение меняет
/// содержимое уже открытой карточки, а не заводит рядом ещё одну. Так карточки
/// не наползают друг на друга, а WebView2 создаётся один раз за сеанс.
///
/// **Команда обязана быть `async`.** Синхронную Tauri выполняет на главном
/// потоке, а `build()` там встаёт намертво: он ждёт ответа от цикла сообщений,
/// который сам же и держит. Окно при этом создаётся, но остаётся скрытым и
/// никогда не показывается — проверено, выглядит как «уведомления молчат».
#[tauri::command]
async fn show_desktop_notification(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let card = CardGeometry::from(&payload);

    if let Some(window) = app.get_webview_window(NOTIFICATION_LABEL) {
        // Размер и угол могли поменяться в настройках, пока карточка висела.
        place_notification(&window, card)?;
        return window
            .emit_to(NOTIFICATION_LABEL, NOTIFICATION_CHANNEL, payload)
            .map_err(|err| format!("не обновить уведомление: {err}"));
    }

    // Полезная нагрузка уезжает в окно скриптом инициализации, а не событием:
    // событие пришлось бы ловить уже после загрузки страницы, и первая карточка
    // успела бы мигнуть пустой.
    let script = format!(
        "window.__VALANIUM_NOTIFICATION__ = {};",
        serde_json::to_string(&payload).map_err(|err| err.to_string())?
    );
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        NOTIFICATION_LABEL,
        tauri::WebviewUrl::App("notification.html".into()),
    )
    .title("Valanium")
    .inner_size(card.width, card.height)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    // Карточка не забирает фокус: уведомление не должно перебивать набор текста
    // в том окне, где человек сейчас работает.
    .focused(false)
    .visible(false)
    .initialization_script(&script)
    .build()
    .map_err(|err| format!("не открыть уведомление: {err}"))?;

    place_notification(&window, card)?;
    window
        .show()
        .map_err(|err| format!("не показать уведомление: {err}"))
}

/// Открыть беседу, о которой было уведомление.
///
/// Зовёт карточка по щелчку. Одного события мало: главное окно может быть
/// свёрнуто или закрыто другими программами — сначала поднимаем его, иначе
/// беседа откроется там, куда человек не смотрит.
#[tauri::command]
async fn open_chat_from_notification(app: AppHandle, device: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        window
            .emit(OPEN_CHAT_CHANNEL, device)
            .map_err(|err| err.to_string())?;
    }
    // Карточка своё дело сделала — убираем, чтобы не висела поверх беседы.
    if let Some(card) = app.get_webview_window(NOTIFICATION_LABEL) {
        let _ = card.close();
    }
    Ok(())
}

/// Закрывает карточку. Зовёт её же страница — после того как доиграет анимация
/// ухода: закрывать окно из Rust по таймеру значило бы обрывать её на середине.
#[tauri::command]
async fn dismiss_desktop_notification(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(NOTIFICATION_LABEL) {
        Some(window) => window
            .close()
            .map_err(|err| format!("не закрыть уведомление: {err}")),
        // Уже закрыто — например, вторым щелчком по крестику.
        None => Ok(()),
    }
}

#[derive(Clone, Copy)]
struct CardGeometry {
    width: f64,
    height: f64,
    bottom: bool,
}

impl CardGeometry {
    fn from(payload: &serde_json::Value) -> Self {
        // Те же границы, что у ползунка в настройках.
        let scale = payload
            .get("size")
            .and_then(|value| value.as_f64())
            .unwrap_or(100.0)
            .clamp(85.0, 130.0)
            / 100.0;
        Self {
            width: 370.0 * scale,
            // Высота строки беседы: аватар 41 плюс поля — карточка повторяет
            // ту же плотность, что список бесед в приложении.
            height: 96.0 * scale,
            bottom: payload.get("position").and_then(|value| value.as_str()) == Some("bottom"),
        }
    }
}

/// Ставит карточку в угол рабочей области — то есть не под панель задач.
fn place_notification(window: &tauri::WebviewWindow, card: CardGeometry) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(card.width, card.height))
        .map_err(|err| err.to_string())?;

    let monitor = window
        .primary_monitor()
        .map_err(|err| err.to_string())?
        .ok_or("не найден основной монитор")?;
    let area = monitor.work_area();
    let factor = monitor.scale_factor();

    // Работаем в физических пикселях: work_area отдаётся в них, и переводить
    // его в логические, чтобы тут же вернуть обратно, незачем.
    let margin = (18.0 * factor).round() as i32;
    let width = (card.width * factor).round() as i32;
    let height = (card.height * factor).round() as i32;
    let x = area.position.x + area.size.width as i32 - width - margin;
    let y = if card.bottom {
        area.position.y + area.size.height as i32 - height - margin
    } else {
        area.position.y + margin
    };

    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|err| err.to_string())
}

/// Кладёт файл переноса аккаунта рядом с документами человека.
///
/// Содержимое приходит уже запечатанным: ядро отдало его строкой, и здесь оно
/// только пишется на диск. Разбирать или проверять его тут нечем и незачем —
/// граница доверия проходит по ядру.
#[tauri::command]
fn save_account_export(app: AppHandle, contents: String) -> Result<String, String> {
    let folder = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|err| format!("нет каталога для файла: {err}"))?;
    std::fs::create_dir_all(&folder).map_err(|err| format!("не создать каталог: {err}"))?;

    // Имя со временем: второй экспорт не должен молча затирать первый — по
    // нему человек ещё может восстанавливаться.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    let path = folder.join(format!("valanium-account-{stamp}.valanium"));
    std::fs::write(&path, contents).map_err(|err| format!("не записать файл: {err}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Сколько непрочитанных — в заголовок окна, на панель задач и в подсказку
/// значка.
///
/// Три места, потому что человек смотрит в разные: свёрнутое окно видно только
/// по иконке на панели, а наведя на значок в трее, ждут словами.
#[tauri::command]
fn set_unread(app: AppHandle, window: tauri::Window, count: u32) -> Result<(), String> {
    let title = if count == 0 { "Valanium".to_owned() } else { format!("Valanium ({count})") };
    window.set_title(&title).map_err(|err| err.to_string())?;

    let overlay = if count == 0 {
        None
    } else {
        Some(tauri::image::Image::new_owned(badge::render(count), badge::size(), badge::size()))
    };
    window.set_overlay_icon(overlay).map_err(|err| err.to_string())?;

    if let Some(tray) = app.tray_by_id("main") {
        let tooltip = if count == 0 {
            "Valanium".to_owned()
        } else {
            format!("Valanium — непрочитанных: {count}")
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
    Ok(())
}

/// Запускать ли Valanium вместе с Windows.
///
/// Через реестр, а не через ярлык в «Автозагрузке»: ярлык человек однажды
/// перенесёт или потеряет вместе с профилем, а ключ переживает и то и другое.
/// Пишем только в HKCU — для машины целиком нужны права администратора,
/// которых у мессенджера быть не должно.
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Valanium";

#[tauri::command]
fn autostart_enabled() -> bool {
    let output = std::process::Command::new("reg")
        .args(["query", &format!("HKCU\\{RUN_KEY}"), "/v", RUN_VALUE])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    matches!(output, Ok(result) if result.status.success())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|err| format!("не найти себя: {err}"))?
        .to_string_lossy()
        .into_owned();

    let status = if enabled {
        // Кавычки обязательны: путь почти всегда содержит пробелы, и без них
        // Windows запустит первое слово, а остальное сочтёт аргументами.
        std::process::Command::new("reg")
            .args([
                "add", &format!("HKCU\\{RUN_KEY}"), "/v", RUN_VALUE,
                "/t", "REG_SZ", "/d", &format!("\"{exe}\" --hidden"), "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    } else {
        std::process::Command::new("reg")
            .args(["delete", &format!("HKCU\\{RUN_KEY}"), "/v", RUN_VALUE, "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    };

    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(_) if !enabled => Ok(()), // удалять нечего — значит уже выключено
        Ok(code) => Err(format!("реестр ответил {code}")),
        Err(err) => Err(format!("не выполнить reg: {err}")),
    }
}

/// Версия клиента. Единственный её источник — `version` в `Cargo.toml`: окно
/// спрашивает номер здесь, а не хранит свою копию, иначе строка в настройках
/// разъезжается с собранным бинарём — и обновление предлагается вечно.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Открыть ссылку из переписки в системном браузере.
///
/// Схема проверяется здесь, а не в окне: окно показывает чужой текст, и
/// решение «что считать ссылкой» нельзя оставлять тому, кто этот текст
/// отображает. Пропускаем только http и https — `file:`, `javascript:` и
/// прочие схемы из сообщения открывать нечего.
///
/// Открываем именно в браузере, а не внутри окна: страница из переписки не
/// должна оказаться в том же WebView, где лежит расшифрованная переписка.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let lowered = url.to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err("ссылка не по http(s)".into());
    }
    // Управляющие символы в аргументе командной строки — повод отказаться, а
    // не гадать, чем это обернётся.
    if url.chars().any(|c| c.is_control()) {
        return Err("в ссылке управляющие символы".into());
    }
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("не открыть ссылку: {err}"))
}

/*
   Ключ, которым подписан манифест обновлений.

   Открытая половина ключа, приватная лежит офлайн и на сервере её нет
   (см. deploy/sign-release.mjs). Смысл ровно один: сервер может назвать любую
   версию и любую ссылку, но не может подделать подпись — а клиент без неё
   обновление не предлагает.

   Меняется только вместе с новой сборкой клиента. Если ключ потерян, старые
   клиенты перестанут подтверждать обновления и попросят скачать вручную —
   это неприятно, но честно, в отличие от «доверяем чему пришлют».
*/
const RELEASE_PUBLIC_KEY: &str =
    "a14e480c6926a1379f0d5bb4362f2c7bf214643b016edf6a7b008db0752388ec";

/// Проверяет подпись манифеста обновлений.
///
/// Проверяется ровно та строка, которую отдал сервер, — поэтому она и приходит
/// строкой, а не разобранным объектом: любая пересборка JSON расходится с
/// подписанными байтами.
#[tauri::command]
fn verify_release(manifest: String, signature: String) -> bool {
    let (Ok(signature), Ok(public)) = (
        hex::decode(signature.trim()),
        hex::decode(RELEASE_PUBLIC_KEY),
    ) else {
        return false;
    };
    valanium_core::keys::verify(&signature, manifest.as_bytes(), &public)
}

#[tauri::command]
fn open_update(url: String) -> Result<(), String> {
    if !url.starts_with("https://valanium.com/downloads/") {
        return Err("недопустимый адрес обновления".into());
    }
    // CREATE_NO_WINDOW: запуск чужой программы из оконного приложения иначе
    // моргает консолью поверх всего. Уведомления от этого уже избавились —
    // здесь та же причина.
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .creation_flags(CREATE_NO_WINDOW)
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

/*
  Значок в трее.

  Без него крестик означал «выйти», а выход — «перестать получать сообщения».
  Мессенджер, который молчит, пока его не открыли, мессенджером не работает.

  Крестик теперь прячет окно, а не закрывает приложение. Выйти по-настоящему
  можно из меню значка — там это названо прямо, чтобы «свернул» и «вышел» не
  оказались одной и той же кнопкой.
*/
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{TrayIconBuilder, TrayIconEvent};

    let open = MenuItemBuilder::with_id("open", "Открыть Valanium").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Выйти").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("значок окна не задан".into())
        })?)
        .tooltip("Valanium")
        .menu(&menu)
        // Левая кнопка не должна открывать меню: по значку в трее щёлкают,
        // чтобы вернуть окно, а не чтобы выбрать пункт.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                allow_microphone(&window);
            }
            install_tray(app)?;
            // При автозапуске окно не показываем: человек включал компьютер,
            // а не мессенджер. Оно ждёт в трее.
            if std::env::args().any(|arg| arg == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Крестик прячет окно. Соединение при этом живёт: сообщения
            // продолжают приходить, и значок в трее показывает, что их ждут.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(Arc::new(Core::default()))
        .invoke_handler(tauri::generate_handler![
            auto_unlock,
            unlock_existing,
            reset_legacy_database,
            logout_local_account,
            submit,
            is_unlocked,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_drag,
            show_desktop_notification,
            dismiss_desktop_notification,
            open_chat_from_notification,
            open_link,
            autostart_enabled,
            set_autostart,
            set_unread,
            app_version,
            verify_release,
            onionize::onionize_status,
            onionize::onionize_install,
            onionize::onionize_start,
            onionize::onionize_stop,
            unlock_with_password,
            app_lock_enabled,
            set_app_lock,
            save_account_export,
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

//! JNI-обвязка над valanium-core.
//!
//! Тонкая по замыслу: четыре функции, всё остальное ходит командами и
//! событиями в JSON. Тот же словарь, что у Windows-клиента (`command.rs`), —
//! новая кнопка в интерфейсе добавляется в ядре, а не здесь.
//!
//! **События забираются опросом.** Колбэк из Rust-потока в JVM потребовал бы
//! `AttachCurrentThread` и `GlobalRef` и легко даёт UB при ошибке; один
//! фоновый Java-поток, крутящий `nativePoll`, не требует ничего.
//!
//! Имена символов обязаны точно соответствовать `app.valanium.core.Core` —
//! иначе `UnsatisfiedLinkError` вылезет уже на устройстве. Сверяется скриптом
//! `check-jni.sh`, который генерирует заголовок через `javac -h`.

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jint, jlong, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;

use valanium_core::ffi::Session;
use valanium_core::store::Store;

const RELEASE_PUBLIC_KEY: &str =
    "a14e480c6926a1379f0d5bb4362f2c7bf214643b016edf6a7b008db0752388ec";

fn verify_release(manifest: &str, signature: &str) -> bool {
    let (Ok(signature), Ok(public)) = (
        hex::decode(signature.trim()), hex::decode(RELEASE_PUBLIC_KEY),
    ) else { return false };
    valanium_core::keys::verify(&signature, manifest.as_bytes(), &public)
}

/// `jlong`, в котором Java носит указатель на сессию. 0 — сессии нет.
type Handle = jlong;

/// Паника не имеет права пересечь границу JNI: разворачивание стека в JVM —
/// неопределённое поведение. Ловим и превращаем в безопасный результат.
fn guard<T>(fallback: T, body: impl FnOnce() -> T) -> T {
    catch_unwind(AssertUnwindSafe(body)).unwrap_or(fallback)
}

/// Открывает базу и поднимает ядро. Возвращает 0, если не вышло, — чаще всего
/// это неверный пароль.
#[no_mangle]
pub extern "system" fn Java_app_valanium_core_Core_nativeInit(
    mut env: JNIEnv,
    _class: JClass,
    db_path: JString,
    password: JString,
) -> Handle {
    guard(0, move || {
        let (Ok(path), Ok(secret)) = (env.get_string(&db_path), env.get_string(&password)) else {
            return 0;
        };
        let path: String = path.into();
        let secret: String = secret.into();

        match Session::open(&path, secret.into_bytes()) {
            Ok(session) => Box::into_raw(Box::new(session)) as Handle,
            Err(_) => 0,
        }
    })
}

/// Проверяет пароль существующей базы до того, как Java сохранит его в
/// Android Keystore. Само открытие SQLite ещё не доказывает правильность
/// пароля: проверкой служит расшифровка keyring, если он уже существует.
#[no_mangle]
pub extern "system" fn Java_app_valanium_core_Core_nativeVerifyDatabaseKey(
    mut env: JNIEnv,
    _class: JClass,
    db_path: JString,
    password: JString,
) -> jboolean {
    guard(JNI_FALSE, move || {
        let (Ok(path), Ok(secret)) = (env.get_string(&db_path), env.get_string(&password)) else {
            return JNI_FALSE;
        };
        let path: String = path.into();
        let secret: String = secret.into();
        let Ok(store) = Store::open(&path, secret.as_bytes()) else {
            return JNI_FALSE;
        };
        match store.has_credentials() {
            Ok(true) if store.load_credentials().is_ok() => JNI_TRUE,
            Ok(false) => JNI_TRUE,
            _ => JNI_FALSE,
        }
    })
}

#[no_mangle]
pub extern "system" fn Java_app_valanium_core_Core_nativeVerifyRelease(
    mut env: JNIEnv,
    _class: JClass,
    manifest: JString,
    signature: JString,
) -> jboolean {
    guard(JNI_FALSE, move || {
        let (Ok(manifest), Ok(signature)) = (env.get_string(&manifest), env.get_string(&signature)) else {
            return JNI_FALSE;
        };
        let manifest: String = manifest.into();
        let signature: String = signature.into();
        if verify_release(&manifest, &signature) {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    })
}

/// Команда в формате JSON. 0 — принято, отрицательное — нет.
#[no_mangle]
pub extern "system" fn Java_app_valanium_core_Core_nativeSubmit(
    mut env: JNIEnv,
    _class: JClass,
    handle: Handle,
    json: JString,
) -> jint {
    guard(-1, move || {
        let Some(session) = session(handle) else {
            return -1;
        };
        let Ok(text) = env.get_string(&json) else {
            return -2;
        };
        let text: String = text.into();

        match session.submit(&text) {
            Ok(()) => 0,
            Err(_) => {
                // Нераспознанная команда — ошибка интерфейса, и она должна
                // быть видна в общем потоке событий, а не только в коде возврата.
                session.report("bad_command", "command json is not recognised");
                -3
            }
        }
    })
}

/// Одно событие в формате JSON; ждёт до `timeout_ms`. `null` — ничего не пришло.
#[no_mangle]
pub extern "system" fn Java_app_valanium_core_Core_nativePoll(
    env: JNIEnv,
    _class: JClass,
    handle: Handle,
    timeout_ms: jint,
) -> jstring {
    let null = std::ptr::null_mut();
    guard(null, move || {
        let Some(session) = session(handle) else {
            return null;
        };
        let Some(event) = session.poll(timeout_ms.max(0) as u32) else {
            return null;
        };
        let Ok(text) = String::from_utf8(event) else {
            return null;
        };

        match env.new_string(text) {
            Ok(java) => java.into_raw(),
            Err(_) => null,
        }
    })
}

/// Закрывает ядро. После вызова handle невалиден, повторный вызов запрещён.
#[no_mangle]
pub extern "system" fn Java_app_valanium_core_Core_nativeShutdown(
    _env: JNIEnv,
    _class: JClass,
    handle: Handle,
) {
    guard((), move || {
        if handle == 0 {
            return;
        }
        // SAFETY: указатель выдан nativeInit и, по контракту Core.java,
        // передаётся сюда ровно один раз.
        drop(unsafe { Box::from_raw(handle as *mut Session) });
    })
}

/// Заимствует сессию, не забирая владение.
fn session<'a>(handle: Handle) -> Option<&'a Session> {
    if handle == 0 {
        return None;
    }
    // SAFETY: ненулевой handle выдан nativeInit и жив до nativeShutdown.
    Some(unsafe { &*(handle as *const Session) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_handle_is_not_dereferenced() {
        assert!(session(0).is_none());
    }

    #[test]
    fn release_signature_is_bound_to_the_exact_manifest() {
        // Историческая фикстура: имена в ней намеренно старые. Подпись считается
        // по точным байтам манифеста, поэтому переименовать их внутри строки
        // нельзя — это сломало бы ровно то свойство, которое тест и проверяет.
        // Новый манифест появится при первом релизе под новым именем.
        let manifest = r#"{"v":1,"channel":"public-beta","publishedAt":"2026-08-30T12:46:34.734Z","windows":{"version":"0.11.0","url":"https://getobsidian.xyz/downloads/Obsidian-0.11.0.exe","sha256":"3b888edd896dc242fc9f6e0d521761fef1e63a12fda16757c1b809d1528cf4b0","bytes":16199680},"android":{"version":"0.6.2","url":"https://getobsidian.xyz/downloads/Obsidian-0.6.2.apk","sha256":"02e8ecf8375b4c551e93d04ad958a0935807499d7b8738e9b2765608f34a73f7","bytes":5218987}}"#;
        let signature = "b0a3bb4c87e177b3aeaf9ea7d92b3d2a8635c43539cb4d35b2888e7968fab0402b55a4f75f551ef4a13dab95c1870bac77a5abccf75e804862ce0f7a4ab4ff00";
        assert!(verify_release(manifest, signature));
        assert!(!verify_release(&(manifest.to_owned() + " "), signature));
    }

    #[test]
    fn guard_swallows_panic_instead_of_crossing_jni() {
        assert_eq!(guard(-1, || panic!("boom")), -1);
        assert_eq!(guard(-1, || 7), 7);
    }
}

/*
  Встроенный Tor.

  На Windows он приезжает отдельной программой, здесь — внутри библиотеки:
  система с Android 10 запрещает исполнять файлы из каталога данных
  приложения, и скачанный бинарь просто не запустится.

  Возвращает "127.0.0.1:порт" — адрес локального SOCKS5, который ядро уже
  умеет использовать. Пустая строка означает, что цепь не построилась;
  различать причины наружу незачем, они все выглядят как «Tor недоступен».

  Вызывать только из фонового потока: построение первой цепи занимает около
  минуты, и на главном потоке это ANR.
*/
#[cfg(feature = "tor-embedded")]
#[no_mangle]
pub extern "system" fn Java_app_valanium_core_Core_nativeStartTor(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let Ok(dir) = env.get_string(&data_dir) else { return String::new() };
        let dir: String = dir.into();

        // Среду выполнения заводит и держит само ядро: слушатель SOCKS живёт
        // на её потоках и обязан пережить возврат отсюда.
        match valanium_core::tor::start(std::path::Path::new(&dir)) {
            Ok(address) => {
                // Ядро читает переменную в момент подключения, поэтому
                // достаточно выставить её здесь.
                std::env::set_var("VALANIUM_TOR_SOCKS", address.to_string());
                address.to_string()
            }
            Err(_) => String::new(),
        }
    }))
    .unwrap_or_default();

    env.new_string(result).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

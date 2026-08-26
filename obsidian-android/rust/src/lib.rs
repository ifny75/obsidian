//! JNI-обвязка над obsidian-core.
//!
//! Тонкая по замыслу: четыре функции, всё остальное ходит командами и
//! событиями в JSON. Тот же словарь, что у Windows-клиента (`command.rs`), —
//! новая кнопка в интерфейсе добавляется в ядре, а не здесь.
//!
//! **События забираются опросом.** Колбэк из Rust-потока в JVM потребовал бы
//! `AttachCurrentThread` и `GlobalRef` и легко даёт UB при ошибке; один
//! фоновый Java-поток, крутящий `nativePoll`, не требует ничего.
//!
//! Имена символов обязаны точно соответствовать `app.obsidian.core.Core` —
//! иначе `UnsatisfiedLinkError` вылезет уже на устройстве. Сверяется скриптом
//! `check-jni.sh`, который генерирует заголовок через `javac -h`.

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jint, jlong, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;

use obsidian_core::ffi::Session;
use obsidian_core::store::Store;

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
pub extern "system" fn Java_app_obsidian_core_Core_nativeInit(
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
pub extern "system" fn Java_app_obsidian_core_Core_nativeVerifyDatabaseKey(
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

/// Команда в формате JSON. 0 — принято, отрицательное — нет.
#[no_mangle]
pub extern "system" fn Java_app_obsidian_core_Core_nativeSubmit(
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
pub extern "system" fn Java_app_obsidian_core_Core_nativePoll(
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
pub extern "system" fn Java_app_obsidian_core_Core_nativeShutdown(
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
    fn guard_swallows_panic_instead_of_crossing_jni() {
        assert_eq!(guard(-1, || panic!("boom")), -1);
        assert_eq!(guard(-1, || 7), 7);
    }
}

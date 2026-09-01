//! Граница между ядром и интерфейсом.
//!
//! События забираются опросом, а не колбэком. Колбэк из чужого потока в JVM
//! требует `AttachCurrentThread` и `GlobalRef` и легко даёт UB при ошибке;
//! блокирующий `poll` из одного фонового Java-потока не требует ничего.
//!
//! [`Session`] — то же самое для Rust-вызывающих: на ней построены и пять
//! C-функций ниже, и JNI-обвязка в `valanium-android`. Очередь событий живёт
//! здесь в одном экземпляре, а не копируется под каждую платформу.

use std::collections::VecDeque;
use std::ffi::{c_char, c_int, CStr};
use std::sync::{Arc, Condvar, Mutex};

use crate::client::Engine;
use crate::command::{Command, Event};
use crate::error::{CoreError, Result};

/// Потолок очереди на случай, если интерфейс перестал забирать события: рвём
/// самое старое, а не растём в памяти бесконечно.
const MAX_QUEUED_EVENTS: usize = 4096;

struct Queue {
    items: Mutex<VecDeque<Vec<u8>>>,
    ready: Condvar,
}

impl Queue {
    fn push(&self, event: &Event) {
        let Ok(bytes) = serde_json::to_vec(event) else { return };
        if let Ok(mut items) = self.items.lock() {
            if items.len() >= MAX_QUEUED_EVENTS {
                items.pop_front();
            }
            items.push_back(bytes);
            self.ready.notify_one();
        }
    }

    fn pop(&self, timeout_ms: u32) -> Option<Vec<u8>> {
        let mut items = self.items.lock().ok()?;
        if items.is_empty() {
            let (next, _) = self
                .ready
                .wait_timeout(items, std::time::Duration::from_millis(timeout_ms as u64))
                .ok()?;
            items = next;
        }
        items.pop_front()
    }
}

/// Открытая база плюс работающее ядро. Безопасная обёртка для любой платформы.
pub struct Session {
    engine: Engine,
    queue: Arc<Queue>,
}

impl Session {
    pub fn open(db_path: &str, password: Vec<u8>) -> Result<Self> {
        let queue = Arc::new(Queue {
            items: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
        });
        let sink = Arc::clone(&queue);
        let engine = Engine::start(
            db_path.to_owned(),
            password,
            Arc::new(move |event| sink.push(&event)),
        )?;
        Ok(Self { engine, queue })
    }

    /// Команда в формате JSON — см. `command.rs`.
    pub fn submit(&self, json: &str) -> Result<()> {
        let command: Command = serde_json::from_str(json).map_err(CoreError::Encoding)?;
        self.engine.submit(command)
    }

    /// Одно событие; ждёт до `timeout_ms`, `None` — за это время ничего.
    pub fn poll(&self, timeout_ms: u32) -> Option<Vec<u8>> {
        self.queue.pop(timeout_ms)
    }

    /// Кладёт событие в очередь напрямую. Нужно, чтобы сообщить интерфейсу об
    /// ошибке, которая случилась до ядра — например, о неразобранной команде.
    pub fn report(&self, code: &str, message: &str) {
        self.queue.push(&Event::Failed { code: code.to_owned(), message: message.to_owned() });
    }
}

// --- C ABI --------------------------------------------------------------------

pub struct Handle(Session);

/// Открывает базу и поднимает ядро. `NULL` — не удалось (обычно неверный пароль).
///
/// # Safety
/// `db_path` и `password` — валидные C-строки в UTF-8.
#[no_mangle]
pub unsafe extern "C" fn obs_init(db_path: *const c_char, password: *const c_char) -> *mut Handle {
    let (Some(path), Some(secret)) = (cstr(db_path), cstr(password)) else {
        return std::ptr::null_mut();
    };
    match Session::open(&path, secret.into_bytes()) {
        Ok(session) => Box::into_raw(Box::new(Handle(session))),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Отправляет команду в формате JSON (см. `command.rs`). 0 — принято.
///
/// # Safety
/// `handle` получен из `obs_init` и ещё не освобождён; `json` — валидная C-строка.
#[no_mangle]
pub unsafe extern "C" fn obs_send(handle: *mut Handle, json: *const c_char) -> c_int {
    let Some(handle) = handle.as_ref() else { return -1 };
    let Some(text) = cstr(json) else { return -2 };

    match handle.0.submit(&text) {
        Ok(()) => 0,
        Err(CoreError::Encoding(_)) => {
            // Неизвестная команда — ошибка интерфейса, и она должна быть видна.
            handle.0.report("bad_command", "command json is not recognised");
            -3
        }
        Err(_) => -4,
    }
}

/// Забирает одно событие, ожидая до `timeout_ms`. `NULL` — за это время ничего
/// не пришло. Результат обязан быть освобождён `obs_free`.
///
/// # Safety
/// `handle` получен из `obs_init` и ещё не освобождён.
#[no_mangle]
pub unsafe extern "C" fn obs_poll(handle: *mut Handle, timeout_ms: u32, len: *mut usize) -> *mut u8 {
    let Some(handle) = handle.as_ref() else { return std::ptr::null_mut() };
    let Some(event) = handle.0.poll(timeout_ms) else { return std::ptr::null_mut() };

    let mut boxed = event.into_boxed_slice();
    let pointer = boxed.as_mut_ptr();
    if let Some(out) = len.as_mut() {
        *out = boxed.len();
    }
    std::mem::forget(boxed);
    pointer
}

/// Освобождает буфер, выданный `obs_poll`.
///
/// # Safety
/// `pointer` и `len` — ровно то, что вернул `obs_poll`, и ещё не освобождены.
#[no_mangle]
pub unsafe extern "C" fn obs_free(pointer: *mut u8, len: usize) {
    if pointer.is_null() {
        return;
    }
    drop(Vec::from_raw_parts(pointer, len, len));
}

/// Закрывает ядро и освобождает handle. После вызова handle невалиден.
///
/// # Safety
/// `handle` получен из `obs_init` и не освобождался ранее.
#[no_mangle]
pub unsafe extern "C" fn obs_shutdown(handle: *mut Handle) {
    if handle.is_null() {
        return;
    }
    drop(Box::from_raw(handle));
}

unsafe fn cstr(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    CStr::from_ptr(pointer).to_str().ok().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> Queue {
        Queue { items: Mutex::new(VecDeque::new()), ready: Condvar::new() }
    }

    #[test]
    fn events_come_out_in_order() {
        let queue = queue();
        queue.push(&Event::QueueDone);
        queue.push(&Event::Failed { code: "x".into(), message: "y".into() });

        assert_eq!(queue.pop(0).unwrap(), br#"{"type":"queue_done"}"#);
        assert!(String::from_utf8(queue.pop(0).unwrap()).unwrap().contains("failed"));
        assert!(queue.pop(1).is_none());
    }

    #[test]
    fn queue_drops_oldest_instead_of_growing() {
        let queue = queue();
        for _ in 0..MAX_QUEUED_EVENTS + 900 {
            queue.push(&Event::QueueDone);
        }
        assert_eq!(queue.items.lock().unwrap().len(), MAX_QUEUED_EVENTS);
    }

    #[test]
    fn null_pointers_do_not_crash() {
        unsafe {
            assert!(obs_init(std::ptr::null(), std::ptr::null()).is_null());
            assert_eq!(obs_send(std::ptr::null_mut(), std::ptr::null()), -1);
            let mut len = 0usize;
            assert!(obs_poll(std::ptr::null_mut(), 0, &mut len).is_null());
            obs_free(std::ptr::null_mut(), 0);
            obs_shutdown(std::ptr::null_mut());
        }
    }

    /// Нераспознанная команда не молчит: интерфейс узнаёт о своей ошибке.
    #[test]
    fn bad_command_is_reported_to_the_ui() {
        let mut path = std::env::temp_dir();
        path.push(format!("valanium-ffi-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let session = Session::open(&path.to_string_lossy(), b"pw".to_vec()).unwrap();
        assert!(session.submit(r#"{"type":"launch_missiles"}"#).is_err());
        session.report("bad_command", "command json is not recognised");

        let event = String::from_utf8(session.poll(100).unwrap()).unwrap();
        assert!(event.contains("bad_command"), "{event}");

        drop(session);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.to_string_lossy()));
        }
    }
}

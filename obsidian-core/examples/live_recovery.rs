//! Проверка восстановления против **живого** сервера.
//!
//!   cargo run --example live_recovery -- wss://getobsidian.xyz/ws
//!
//! Отличается от `tests/cross_language.rs` тем, что там сервер поднимается
//! рядом из исходников, а здесь — тот, что действительно работает. Это разные
//! вопросы: первый про код, второй про то, что выложено.
//!
//! Заводит настоящий аккаунт со случайным именем `qa_*`. Посылку восстановления
//! снимает за собой; сам аккаунт остаётся — команды «удалить личность» в
//! протоколе нет.

use std::process::{Command as Proc, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use obsidian_core::client::Engine;
use obsidian_core::command::Command;

fn main() {
    let url = std::env::args().nth(1).unwrap_or_else(|| "wss://getobsidian.xyz/ws".into());
    let suffix = hex::encode(random_bytes(4));
    let handle = format!("qa_{suffix}");
    let login = format!("qa-login-{suffix}");
    let password = "достаточно длинный пароль для проверки";

    let workdir = std::env::temp_dir().join(format!("obsidian-live-{}", std::process::id()));
    std::fs::create_dir_all(&workdir).expect("temp dir");
    println!("сервер: {url}\nимя:    {handle}\n");

    // --- 1. Регистрация ------------------------------------------------------
    let (sink, events) = event_sink();
    let first = Engine::start(db(&workdir, "first.db"), b"pw".to_vec(), sink).expect("core");
    first
        .submit(Command::Register {
            url: url.clone(),
            handle: Some(handle.clone()),
            invite: None,
            payment_ref: None,
        })
        .expect("submit");
    wait(&events, "authenticated").expect("регистрация не прошла");
    let registered = wait(&events, "registered").expect("нет события registered");
    let identity = field(&registered, "identity").expect("нет identity");
    println!("1. зарегистрирован, личность {}…{}", &identity[..8], &identity[56..]);

    // --- 2. Фраза из 24 слов -------------------------------------------------
    first.submit(Command::RecoveryCode).expect("submit");
    let record = wait(&events, "recovery_code").expect("нет записи восстановления");
    let words = field(&record, "words").expect("нет фразы");
    let count = words.split_whitespace().count();
    assert_eq!(count, 24, "слов должно быть 24, а не {count}");
    println!("2. фраза из {count} слов получена");

    // --- 3. Запасной вход со вторым фактором ---------------------------------
    let secret = obsidian_core::totp::new_secret(&login).base32;
    let code = totp_code(&secret).expect("не посчитать одноразовый код (нужен node)");
    first
        .submit(Command::RecoverySetup {
            login: login.clone(),
            password: password.into(),
            totp: Some(secret.clone()),
            code: Some(code),
        })
        .expect("submit");
    let saved = wait(&events, "recovery_saved").expect("сервер не принял посылку");
    assert!(saved.contains("\"totp\":true"), "второй фактор не включился: {saved}");
    println!("3. запасной вход включён, второй фактор принят");

    // --- 4. Чужой пароль ----------------------------------------------------
    let refusal = try_recover(&workdir, "wrong.db", &url, &login, "совсем другой пароль", None);
    assert!(refusal.contains("recovery_not_found"), "неверный пароль прошёл: {refusal}");
    println!("4. неверный пароль отвергнут");

    // --- 5. Верный пароль, но без кода ---------------------------------------
    let refusal = try_recover(&workdir, "nocode.db", &url, &login, password, None);
    assert!(refusal.contains("recovery_totp_required"), "посылка отдана без кода: {refusal}");
    println!("5. без одноразового кода посылка не отдана");

    // --- 6. Чужой код --------------------------------------------------------
    let refusal = try_recover(&workdir, "badcode.db", &url, &login, password, Some("000000"));
    assert!(refusal.contains("recovery_totp_wrong"), "посылка отдана по чужому коду: {refusal}");
    println!("6. чужой код отвергнут");

    // --- 7. Верный код -------------------------------------------------------
    let fresh_code = totp_code(&secret).expect("код");
    let (sink, restored_events) = event_sink();
    let restored = Engine::start(db(&workdir, "restored.db"), b"other".to_vec(), sink).expect("core");
    restored
        .submit(Command::RecoverPassword {
            url: url.clone(),
            login: login.clone(),
            password: password.into(),
            code: Some(fresh_code),
        })
        .expect("submit");
    wait(&restored_events, "authenticated").expect("верный код не пустил");
    let again = wait(&restored_events, "registered").expect("нет registered");
    assert_eq!(field(&again, "identity").unwrap(), identity, "личность не совпала");
    println!("7. по паролю и коду личность восстановлена — та же");

    // --- 8. По фразе из 24 слов ---------------------------------------------
    let (sink, by_words_events) = event_sink();
    let by_words = Engine::start(db(&workdir, "words.db"), b"third".to_vec(), sink).expect("core");
    by_words
        .submit(Command::Recover { url: url.clone(), code: words.clone() })
        .expect("submit");
    wait(&by_words_events, "authenticated").expect("фраза не пустила");
    let third = wait(&by_words_events, "registered").expect("нет registered");
    assert_eq!(field(&third, "identity").unwrap(), identity, "личность не совпала");
    println!("8. по фразе из 24 слов личность восстановлена — та же");

    // --- 9. Убираем за собой -------------------------------------------------
    restored.submit(Command::RecoveryForget).expect("submit");
    wait(&restored_events, "recovery_forgotten").expect("посылка не снята");
    println!("9. посылка снята с сервера");

    let _ = std::fs::remove_dir_all(&workdir);
    println!("\nвсё сошлось. аккаунт @{handle} остался на сервере: удалять личность протокол не умеет");
}

// --- вспомогательное ---------------------------------------------------------

fn event_sink() -> (obsidian_core::client::EventSink, Receiver<String>) {
    let (tx, rx) = channel();
    let sink: obsidian_core::client::EventSink = Arc::new(move |event| {
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = tx.send(json);
        }
    });
    (sink, rx)
}

/// Ждёт событие с нужным типом или кодом ошибки. Возвращает его целиком.
fn wait(events: &Receiver<String>, needle: &str) -> Option<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        match events.recv_timeout(left) {
            Ok(line) => {
                if line.contains(needle) {
                    return Some(line);
                }
            }
            Err(RecvTimeoutError::Timeout) => return None,
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

fn field(json: &str, name: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    Some(value.get(name)?.as_str()?.to_owned())
}

/// Пробует восстановиться и возвращает первое сообщение об отказе.
fn try_recover(
    workdir: &std::path::Path,
    db: &str,
    url: &str,
    login: &str,
    password: &str,
    code: Option<&str>,
) -> String {
    let (sink, events) = event_sink();
    let engine = Engine::start(db_path(workdir, db), b"pw".to_vec(), sink).expect("core");
    engine
        .submit(Command::RecoverPassword {
            url: url.into(),
            login: login.into(),
            password: password.into(),
            code: code.map(str::to_owned),
        })
        .expect("submit");
    wait(&events, "\"type\":\"failed\"").unwrap_or_else(|| "отказа не было".into())
}

/// Код считает реализация сервера — сверенная с эталонными векторами RFC 6238.
fn totp_code(secret_base32: &str) -> Option<String> {
    let script = format!(
        "import {{ codeFor, decodeBase32, STEP_SECONDS }} from './src/auth/totp.ts';\n\
         const s = decodeBase32('{secret_base32}');\n\
         process.stdout.write(codeFor(s, Math.floor(Date.now() / 1000 / STEP_SECONDS)));",
    );
    let output = Proc::new("node")
        .args(["--input-type=module", "-e", &script])
        .current_dir("../obsidian-server")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let code = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (code.len() == 6).then_some(code)
}

fn db(dir: &std::path::Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}

fn db_path(dir: &std::path::Path, name: &str) -> String {
    db(dir, name)
}

fn random_bytes(n: usize) -> Vec<u8> {
    use rand_core::{OsRng, RngCore};
    let mut out = vec![0u8; n];
    OsRng.fill_bytes(&mut out);
    out
}

//! Сквозная проверка против настоящего obsidian-server: два клиента, реальный
//! сокет, реальный MLS.
//!
//! Юнит-тесты обеих сторон могут быть согласованно неправы: доменный префикс
//! подписи, порядок полей, раскладка кадра, порядок доставки. Ловится это
//! только здесь. Заодно тест смотрит в базу сервера и убеждается, что там
//! лежит шифротекст, а не переписка.
//!
//!   cargo test --test cross_language -- --nocapture
//!
//! Если node или зависимости сервера не установлены, тест сообщает об этом и
//! завершается без падения.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as Proc, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use obsidian_core::client::Engine;
use obsidian_core::command::Command;

const CHAT_PORT: u16 = 18999;
const RECOVERY_PORT: u16 = 18998;
const PASSWORD_PORT: u16 = 18997;
const SECRET: &str = "переписка, которой сервер видеть не должен";

/// Убивает сервер, даже если тест упал по assert.
struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn two_clients_exchange_an_encrypted_message() {
    let Some(server_dir) = server_dir() else {
        return skip("obsidian-server рядом не найден");
    };
    if !server_dir.join("node_modules").exists() {
        return skip("в obsidian-server не установлены зависимости (npm ci)");
    }

    let workdir = std::env::temp_dir().join(format!("obsidian-xlang-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&workdir);
    std::fs::create_dir_all(&workdir).expect("temp dir");
    let server_db = workdir.join("server.db");

    // Инвайты выписываем тем же CLI, что и в проде.
    let (Some(alice_invite), Some(bob_invite)) = (
        issue_invite(&server_dir, &server_db, CHAT_PORT),
        issue_invite(&server_dir, &server_db, CHAT_PORT),
    ) else {
        return skip("не удалось выпустить инвайты (нет node?)");
    };

    let Some(server) = start_server(&server_dir, &server_db, &workdir, CHAT_PORT) else {
        return skip("сервер не стартовал");
    };
    let _guard = Server(server);
    assert!(wait_for_port(CHAT_PORT), "сервер не открыл порт");

    let url = format!("ws://127.0.0.1:{CHAT_PORT}/ws");

    // --- Боб заходит первым: при подключении он выкладывает KeyPackages, без
    // них Алисе нечем завести с ним шифрованный диалог.
    let (bob_sink, bob_events) = event_sink("bob");
    let bob = Engine::start(path(&workdir, "bob.db"), b"bob-password".to_vec(), bob_sink)
        .expect("bob core");
    bob.submit(Command::Register {
        url: url.clone(),
        handle: Some("bob".into()),
        invite: Some(bob_invite),
        payment_ref: None,
    })
    .unwrap();
    wait_for(&bob_events, "authenticated").expect("Боб не прошёл AUTH");
    let bob_device = extract(&wait_for(&bob_events, "registered").unwrap(), "device").unwrap();

    // Уходим в оффлайн: так конверты Алисы задержатся в очереди сервера, и мы
    // сможем заглянуть в неё до доставки.
    bob.submit(Command::Disconnect).unwrap();
    wait_for(&bob_events, "disconnected").expect("Боб не отключился");

    // --- Алиса пишет Бобу, которого нет в сети.
    let (alice_sink, alice_events) = event_sink("alice");
    let alice = Engine::start(path(&workdir, "alice.db"), b"alice-password".to_vec(), alice_sink)
        .expect("alice core");
    alice
        .submit(Command::Register {
            url: url.clone(),
            handle: Some("alice".into()),
            invite: Some(alice_invite),
            payment_ref: None,
        })
        .unwrap();
    wait_for(&alice_events, "authenticated").expect("Алиса не прошла AUTH");
    let alice_device = extract(&wait_for(&alice_events, "registered").unwrap(), "device").unwrap();

    alice
        .submit(Command::Send { recipient_device: bob_device.clone(), body: SECRET.into() })
        .unwrap();

    // Два конверта: приглашение в группу и само сообщение.
    wait_for(&alice_events, "accepted").expect("сервер не принял первый конверт");
    wait_for(&alice_events, "accepted").expect("сервер не принял второй конверт");

    // --- Главная проверка: в очереди сервера лежит шифротекст.
    let payloads = queued_payloads(&server_db, &bob_device);
    assert_eq!(payloads.len(), 2, "ожидали приглашение и сообщение в очереди");
    for payload in &payloads {
        assert!(
            !contains(payload, SECRET.as_bytes()),
            "сервер хранит открытый текст — E2EE не работает"
        );
    }
    println!("в очереди сервера {} конверта, открытого текста в них нет", payloads.len());

    // --- Боб возвращается и разбирает очередь.
    bob.submit(Command::Connect { url }).unwrap();

    let started = wait_for(&bob_events, "conversation_started").expect("Боб не получил приглашение");
    assert_eq!(
        extract(&started, "peer_device").unwrap(),
        alice_device,
        "приглашение обязано быть привязано к устройству Алисы"
    );

    let message = wait_for(&bob_events, "\"type\":\"message\"").expect("сообщение не доехало");
    assert!(message.contains(SECRET), "текст исказился: {message}");
    assert_eq!(
        extract(&message, "sender_device").unwrap(),
        alice_device,
        "отправитель должен быть доказан, а не заявлен"
    );

    // --- Сверка: обе стороны обязаны видеть одно и то же.
    alice.submit(Command::Verify { peer_device: bob_device.clone() }).unwrap();
    bob.submit(Command::Verify { peer_device: alice_device.clone() }).unwrap();

    let alice_view = wait_for(&alice_events, "verification").expect("Алиса не получила сверку");
    let bob_view = wait_for(&bob_events, "verification").expect("Боб не получил сверку");

    assert_eq!(
        extract(&alice_view, "safety_number").unwrap(),
        extract(&bob_view, "safety_number").unwrap(),
        "код сверки обязан совпадать — иначе его нельзя сравнить вслух"
    );
    assert_eq!(
        extract(&alice_view, "epoch_code").unwrap(),
        extract(&bob_view, "epoch_code").unwrap(),
        "секрет эпохи разошёлся — стороны не в одном состоянии"
    );
    println!(
        "код сверки у обоих: {}",
        extract(&alice_view, "safety_number").unwrap()
    );

    // Посторонний код сверки не совпадает: пара считается от обоих ключей.
    alice.submit(Command::Verify { peer_device: "cc".repeat(32) }).unwrap();
    let unknown = wait_for(&alice_events, "no_conversation").expect("незнакомец должен дать отказ");
    assert!(unknown.contains("no_conversation"));

    let _ = std::fs::remove_dir_all(&workdir);
}


/// Потеря устройства: личность возвращается по коду, переписка — нет.
///
/// Проверяется главное свойство, ради которого код и нужен: новое устройство
/// заходит на сервер **без инвайта**, потому что личность серверу уже известна,
/// и остаётся тем же собеседником для тех, кто с ним уже переписывался.
#[test]
fn recovery_restores_identity_on_a_new_device() {
    let Some(server_dir) = server_dir() else {
        return skip("obsidian-server рядом не найден");
    };
    if !server_dir.join("node_modules").exists() {
        return skip("в obsidian-server не установлены зависимости (npm ci)");
    }

    let workdir = std::env::temp_dir().join(format!("obsidian-recovery-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&workdir);
    std::fs::create_dir_all(&workdir).expect("temp dir");
    let server_db = workdir.join("server.db");

    let Some(invite) = issue_invite(&server_dir, &server_db, RECOVERY_PORT) else {
        return skip("не удалось выпустить инвайт (нет node?)");
    };
    let Some(server) = start_server(&server_dir, &server_db, &workdir, RECOVERY_PORT) else {
        return skip("сервер не стартовал");
    };
    let _guard = Server(server);
    assert!(wait_for_port(RECOVERY_PORT), "сервер не открыл порт");
    let url = format!("ws://127.0.0.1:{RECOVERY_PORT}/ws");

    // --- Регистрируемся обычным путём и забираем код восстановления.
    let (sink, events) = event_sink("старое устройство");
    let old = Engine::start(path(&workdir, "old.db"), b"pw".to_vec(), sink).expect("core");
    old.submit(Command::Register {
        url: url.clone(),
        handle: Some("alice".into()),
        invite: Some(invite),
        payment_ref: None,
    })
    .unwrap();
    wait_for(&events, "authenticated").expect("регистрация не прошла");

    let registered = wait_for(&events, "registered").unwrap();
    let identity = extract(&registered, "identity").unwrap();
    let old_device = extract(&registered, "device").unwrap();

    old.submit(Command::RecoveryCode).unwrap();
    let code = extract(&wait_for(&events, "recovery_code").expect("кода нет"), "code").unwrap();
    println!("код восстановления: {code}");
    assert_eq!(code.split(' ').count(), 11, "код должен читаться группами");

    // --- Устройство «потеряно»: новая база, того же кода достаточно.
    let (fresh_sink, fresh_events) = event_sink("новое устройство");
    let fresh = Engine::start(path(&workdir, "fresh.db"), "другой пароль".as_bytes().to_vec(), fresh_sink)
        .expect("core");

    // Инвайта здесь нет намеренно: личность серверу известна, и он обязан
    // принять новое устройство по одному сертификату.
    fresh.submit(Command::Recover { url: url.clone(), code: code.clone() }).unwrap();
    wait_for(&fresh_events, "authenticated").expect("сервер не принял восстановленное устройство");

    let restored = wait_for(&fresh_events, "registered").unwrap();
    assert_eq!(
        extract(&restored, "identity").unwrap(),
        identity,
        "личность обязана совпасть — иначе контакты потеряют собеседника"
    );
    assert_ne!(
        extract(&restored, "device").unwrap(),
        old_device,
        "ключ устройства обязан быть новым: восстанавливается личность, а не устройство"
    );

    // --- Опечатка в коде не должна тихо создавать постороннюю личность.
    let (typo_sink, typo_events) = event_sink("опечатка");
    let typo = Engine::start(path(&workdir, "typo.db"), b"pw".to_vec(), typo_sink).expect("core");
    let broken = {
        let mut chars: Vec<char> = code.chars().collect();
        let position = chars.iter().position(|c| *c != ' ').unwrap();
        chars[position] = if chars[position] == 'A' { 'B' } else { 'A' };
        chars.into_iter().collect::<String>()
    };
    typo.submit(Command::Recover { url: url.clone(), code: broken }).unwrap();
    let refusal = wait_for(&typo_events, "bad_recovery_code").expect("опечатка прошла молча");
    assert!(refusal.contains("bad_recovery_code"), "{refusal}");

    // --- На подключённом клиенте восстановление вообще не к месту.
    old.submit(Command::Recover { url: url.clone(), code: code.clone() }).unwrap();
    let busy = wait_for(&events, "\"code\":\"busy\"").expect("подключённый клиент промолчал");
    assert!(busy.contains("busy"), "{busy}");

    // --- А отключённый обязан защитить занятую базу: иначе восстановление
    // затёрло бы личность, которая там уже живёт.
    old.submit(Command::Disconnect).unwrap();
    wait_for(&events, "disconnected").expect("не отключился");

    old.submit(Command::Recover { url, code }).unwrap();
    let occupied = wait_for(&events, "identity_exists").expect("занятая база не защищена");
    assert!(occupied.contains("identity_exists"), "{occupied}");

    let _ = std::fs::remove_dir_all(&workdir);
}


/// Восстановление по логину и паролю: сервер держит ключ, но открыть не может.
///
/// Проверяется и то, ради чего способ существует (новое устройство входит без
/// инвайта и без записанного кода), и то, чем за это заплачено: на сервере
/// лежит запечатанная посылка, и без пароля она бесполезна.
#[test]
fn a_password_restores_identity_and_the_server_never_sees_the_key() {
    let Some(server_dir) = server_dir() else {
        return skip("obsidian-server рядом не найден");
    };
    if !server_dir.join("node_modules").exists() {
        return skip("в obsidian-server не установлены зависимости (npm ci)");
    }

    let workdir = std::env::temp_dir().join(format!("obsidian-password-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&workdir);
    std::fs::create_dir_all(&workdir).expect("temp dir");
    let server_db = workdir.join("server.db");

    let Some(invite) = issue_invite(&server_dir, &server_db, PASSWORD_PORT) else {
        return skip("не удалось выпустить инвайт (нет node?)");
    };
    let Some(server) = start_server(&server_dir, &server_db, &workdir, PASSWORD_PORT) else {
        return skip("сервер не стартовал");
    };
    let _guard = Server(server);
    assert!(wait_for_port(PASSWORD_PORT), "сервер не открыл порт");
    let url = format!("ws://127.0.0.1:{PASSWORD_PORT}/ws");

    const LOGIN: &str = "alice";
    const PASSWORD: &str = "достаточно длинный пароль";

    // --- Обычная регистрация, затем включение восстановления.
    let (sink, events) = event_sink("старое устройство");
    let old = Engine::start(path(&workdir, "old.db"), b"pw".to_vec(), sink).expect("core");
    old.submit(Command::Register {
        url: url.clone(),
        handle: Some(LOGIN.into()),
        invite: Some(invite),
        payment_ref: None,
    })
    .unwrap();
    wait_for(&events, "authenticated").expect("регистрация не прошла");

    let registered = wait_for(&events, "registered").unwrap();
    let identity = extract(&registered, "identity").unwrap();
    let old_device = extract(&registered, "device").unwrap();

    old.submit(Command::RecoverySetup {
        login: LOGIN.into(),
        password: PASSWORD.into(),
        totp: None,
        code: None,
    })
    .unwrap();
    wait_for(&events, "recovery_saved").expect("сервер не принял посылку");

    // --- Сервер хранит шифротекст: identity-ключа в его базе нет ни в каком виде.
    let sealed = stored_recovery(&server_db);
    assert!(!sealed.is_empty(), "посылка не легла в базу");
    let identity_pub = hex_to_bytes(&identity);
    assert!(
        !contains(&sealed, &identity_pub),
        "в базе сервера видно ключ — посылка не запечатана"
    );
    assert!(
        !contains(&sealed, PASSWORD.as_bytes()) && !contains(&sealed, LOGIN.as_bytes()),
        "в базе сервера видно логин или пароль"
    );

    // --- Устройство потеряно: чистая база, ни инвайта, ни кода — только пароль.
    let (fresh_sink, fresh_events) = event_sink("новое устройство");
    let fresh = Engine::start(path(&workdir, "fresh.db"), "другой пароль".as_bytes().to_vec(), fresh_sink)
        .expect("core");
    fresh
        .submit(Command::RecoverPassword {
            url: url.clone(),
            login: "  ALICE  ".into(), // регистр и пробелы не должны решать
            password: PASSWORD.into(),
            code: None,
        })
        .unwrap();
    wait_for(&fresh_events, "authenticated").expect("сервер не принял восстановленное устройство");

    let restored = wait_for(&fresh_events, "registered").unwrap();
    assert_eq!(
        extract(&restored, "identity").unwrap(),
        identity,
        "личность обязана совпасть — иначе контакты потеряют собеседника"
    );
    assert_ne!(
        extract(&restored, "device").unwrap(),
        old_device,
        "ключ устройства обязан быть новым"
    );

    // --- Неверный пароль не должен ни доказать знание, ни открыть посылку.
    let (wrong_sink, wrong_events) = event_sink("неверный пароль");
    let wrong = Engine::start(path(&workdir, "wrong.db"), b"pw".to_vec(), wrong_sink).expect("core");
    wrong
        .submit(Command::RecoverPassword {
            url: url.clone(),
            login: LOGIN.into(),
            password: "совершенно другой пароль".into(),
            code: None,
        })
        .unwrap();
    let refusal = wait_for(&wrong_events, "recovery_not_found").expect("неверный пароль прошёл");
    assert!(refusal.contains("recovery_not_found"), "{refusal}");

    // --- Несуществующий логин отвечает тем же кодом: сервер не подсказывает,
    //     какие логины заняты.
    let (miss_sink, miss_events) = event_sink("чужой логин");
    let miss = Engine::start(path(&workdir, "miss.db"), b"pw".to_vec(), miss_sink).expect("core");
    miss.submit(Command::RecoverPassword {
        url: url.clone(),
        login: "nobody".into(),
        password: PASSWORD.into(),
        code: None,
    })
    .unwrap();
    assert!(
        wait_for(&miss_events, "recovery_not_found").is_some(),
        "ответ обязан быть неотличим от неверного пароля"
    );

    // --- Второй фактор: с ним посылку не отдают по одному паролю.
    //
    // Код считает сам сервер — его реализация сверена с эталонными векторами
    // RFC 6238. Считать его здесь второй раз значило бы проверять свою же
    // арифметику против неё самой.
    let secret = obsidian_core::totp::new_secret(LOGIN).base32;
    let Some(code) = totp_code(&server_dir, &secret) else {
        return skip("не удалось посчитать одноразовый код (нет node?)");
    };
    old.submit(Command::RecoverySetup {
        login: LOGIN.into(),
        password: PASSWORD.into(),
        totp: Some(secret.clone()),
        code: Some(code),
    })
    .unwrap();
    wait_for(&events, "recovery_saved").expect("сервер не принял посылку со вторым фактором");

    // Пароль верен, кода нет — посылку не отдают.
    let (nocode_sink, nocode_events) = event_sink("без кода");
    let nocode = Engine::start(path(&workdir, "nocode.db"), b"pw".to_vec(), nocode_sink)
        .expect("core");
    nocode
        .submit(Command::RecoverPassword {
            url: url.clone(),
            login: LOGIN.into(),
            password: PASSWORD.into(),
            code: None,
        })
        .unwrap();
    assert!(
        wait_for(&nocode_events, "recovery_totp_required").is_some(),
        "посылка отдана без одноразового кода"
    );

    // Чужой код — тоже нет.
    let (badcode_sink, badcode_events) = event_sink("чужой код");
    let badcode = Engine::start(path(&workdir, "badcode.db"), b"pw".to_vec(), badcode_sink)
        .expect("core");
    badcode
        .submit(Command::RecoverPassword {
            url: url.clone(),
            login: LOGIN.into(),
            password: PASSWORD.into(),
            code: Some("000000".into()),
        })
        .unwrap();
    assert!(
        wait_for(&badcode_events, "recovery_totp_wrong").is_some(),
        "посылка отдана по неверному коду"
    );

    // Верный код — отдают, и личность та же.
    let Some(fresh_code) = totp_code(&server_dir, &secret) else {
        return skip("не удалось посчитать одноразовый код");
    };
    let (totp_sink, totp_events) = event_sink("со вторым фактором");
    let with_totp = Engine::start(path(&workdir, "totp.db"), b"pw".to_vec(), totp_sink)
        .expect("core");
    with_totp
        .submit(Command::RecoverPassword {
            url,
            login: LOGIN.into(),
            password: PASSWORD.into(),
            code: Some(fresh_code),
        })
        .unwrap();
    wait_for(&totp_events, "authenticated").expect("верный код не пустил");
    let by_totp = wait_for(&totp_events, "registered").unwrap();
    assert_eq!(
        extract(&by_totp, "identity").unwrap(),
        identity,
        "личность обязана совпасть и на этом пути"
    );

    let _ = std::fs::remove_dir_all(&workdir);
}

/// Одноразовый код считает реализация сервера — та, что сверена с RFC 6238.
fn totp_code(server_dir: &Path, secret_base32: &str) -> Option<String> {
    let script = format!(
        "import {{ codeFor, decodeBase32, STEP_SECONDS }} from './src/auth/totp.ts';\n\
         const secret = decodeBase32('{secret_base32}');\n\
         process.stdout.write(codeFor(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)));",
    );
    let output = Proc::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .current_dir(server_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let code = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    if code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()) {
        Some(code)
    } else {
        None
    }
}

// --- вспомогательное ---------------------------------------------------------

/// Всё, что сервер хранит про восстановление, одним куском — чтобы искать в нём
/// то, чего там быть не должно.
fn stored_recovery(db: &Path) -> Vec<u8> {
    let connection = match rusqlite::Connection::open(db) {
        Ok(connection) => connection,
        Err(_) => return Vec::new(),
    };
    let mut statement = match connection
        .prepare("SELECT login_id, verifier, sealed FROM recoveries")
    {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = statement
        .query_map([], |row| {
            Ok([
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ]
            .concat())
        })
        .and_then(|rows| rows.collect::<std::result::Result<Vec<_>, _>>());
    rows.map(|rows| rows.concat()).unwrap_or_default()
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

fn skip(reason: &str) {
    eprintln!("cross_language пропущен: {reason}");
}

fn server_dir() -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?.join("obsidian-server");
    dir.join("src/index.ts").exists().then_some(dir)
}

fn path(dir: &Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}

fn node(server_dir: &Path, script: &str, db: &Path, port: u16) -> Proc {
    let mut proc = Proc::new(if cfg!(windows) { "node.exe" } else { "node" });
    proc.current_dir(server_dir)
        .arg(script)
        .env("OBSIDIAN_DB", db)
        .env("OBSIDIAN_PORT", port.to_string())
        .env("OBSIDIAN_LOG", "error");
    proc
}

fn issue_invite(server_dir: &Path, db: &Path, port: u16) -> Option<String> {
    let output = node(server_dir, "src/tools/invite.ts", db, port).output().ok()?;
    if !output.status.success() {
        eprintln!("invite: {}", String::from_utf8_lossy(&output.stderr));
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("invite: ").map(str::trim).map(str::to_owned))
}

fn start_server(server_dir: &Path, db: &Path, workdir: &Path, port: u16) -> Option<Child> {
    node(server_dir, "src/index.ts", db, port)
        .env("OBSIDIAN_BLOBS", workdir.join("blobs"))
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .ok()
}

fn wait_for_port(port: u16) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Читает очередь сервера напрямую из его базы — так видно ровно то, что там
/// лежит, а не то, что нам рассказывает протокол.
fn queued_payloads(db: &Path, recipient_device_hex: &str) -> Vec<Vec<u8>> {
    let device = hex::decode(recipient_device_hex).expect("device hex");
    let connection = rusqlite::Connection::open(db).expect("открыть базу сервера");
    let mut statement = connection
        .prepare("SELECT payload FROM envelopes WHERE recipient_device = ?1 ORDER BY seq")
        .expect("запрос очереди");
    let rows = statement
        .query_map(rusqlite::params![device], |row| row.get::<_, Vec<u8>>(0))
        .expect("чтение очереди");
    rows.map(|row| row.expect("строка очереди")).collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

type Sink = Arc<dyn Fn(obsidian_core::command::Event) + Send + Sync>;

/// События приходят из потока ядра — складываем их в канал как JSON.
fn event_sink(who: &'static str) -> (Sink, Receiver<String>) {
    let (tx, rx) = channel();
    let sink: Sink = Arc::new(move |event| {
        if let Ok(json) = serde_json::to_string(&event) {
            eprintln!("{who}: {json}");
            let _ = tx.send(json);
        }
    });
    (sink, rx)
}

fn wait_for(rx: &Receiver<String>, needle: &str) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        match rx.recv_timeout(left) {
            Ok(event) if event.contains(needle) => return Some(event),
            Ok(_) => continue,
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// Достаёт строковое поле из JSON без лишней зависимости на разбор.
fn extract(json: &str, field: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value.get(field)?.as_str().map(str::to_owned)
}

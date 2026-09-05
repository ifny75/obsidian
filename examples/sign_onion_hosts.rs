//! Подписывает список onion-входов офлайновым ключом.
//!
//! Подпись считается той же функцией, которой клиент её проверяет
//! (`onion::sign` / `onion::verify`). Это не мелочь: отдельная реализация в
//! скрипте однажды разошлась бы с ядром на порядке полей или на кодировке
//! длин, и обнаружилось бы это как «клиенты перестали видеть новые входы».
//!
//! Ключ здесь **не создаётся и никуда не отправляется**. Он живёт у владельца,
//! офлайн, и на серверы не попадает: сервер должен уметь показать подписанный
//! список, но не уметь подписать новый.
//!
//! Создать ключ один раз:
//!
//! ```text
//! cargo run --example sign_onion_hosts -- --new-key > ~/.valanium-release/onion.key
//! ```
//!
//! Подписать список (время выпуска — сейчас, в секундах эпохи):
//!
//! ```text
//! cargo run --example sign_onion_hosts -- aaa….onion bbb….onion
//! ```
//!
//! Адреса — **голые**, ровно как в `VALANIUM_ONION_HOSTS`: без `ws://` и без
//! `/ws`. В ws-адрес их заворачивает клиент, а подписывается то, что едет по
//! проводу. Подписать `ws://aaa.onion/ws` значило бы подписать строку, которой
//! сервер никогда не пришлёт, и клиент список не примет.
//!
//! Печатает три вещи: открытый ключ — его вписать в `onion.rs`; подпись и
//! время выпуска — их отдать серверу.

use std::time::{SystemTime, UNIX_EPOCH};

use valanium_core::keys::SecretKey;
use valanium_core::onion;

const KEY_ENV: &str = "VALANIUM_ONION_KEY";

fn read_key() -> SecretKey {
    let raw = std::env::var(KEY_ENV).unwrap_or_else(|_| {
        let path = std::env::var("VALANIUM_ONION_KEY_FILE").unwrap_or_else(|_| {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .expect("не знаю, где домашний каталог");
            format!("{home}/.valanium-release/onion.key")
        });
        std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("не прочитать ключ {path}: {err}"))
    });
    let bytes = hex::decode(raw.trim()).expect("ключ должен быть hex");
    SecretKey::from_bytes(&bytes).expect("ключ должен быть 32 байта")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--new-key") {
        // Печатается только приватная половина: открытую выведет подпись.
        // Перенаправьте в файл и уберите его с рабочей машины в надёжное место.
        let key = SecretKey::generate();
        println!("{}", hex::encode(key.to_bytes()));
        eprintln!("открытый ключ: {}", hex::encode(key.public()));
        eprintln!("Впишите открытый в onion.rs, приватный держите офлайн.");
        return;
    }

    let hosts: Vec<String> = args.into_iter().filter(|a| !a.starts_with("--")).collect();
    if hosts.is_empty() {
        eprintln!("usage: sign_onion_hosts [--new-key] <adres.onion> …");
        std::process::exit(2);
    }
    // Голые адреса, как в VALANIUM_ONION_HOSTS. Ловим здесь, а не в отчёте
    // «Tor перестал работать»: подписанный ws-адрес клиент не примет никогда,
    // потому что сервер такую строку не присылает.
    if let Some(wrong) = hosts.iter().find(|h| h.contains("://") || h.contains('/')) {
        eprintln!("адрес должен быть голым, без ws:// и /ws: {wrong}");
        std::process::exit(2);
    }

    let key = read_key();
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("часы до эпохи")
        .as_secs() as i64;

    let signature = onion::sign(&key, &hosts, issued_at);

    // Сразу проверяем тем же путём, которым проверит клиент. Подпись, которую
    // не принял бы клиент, лучше увидеть здесь, а не в отчёте «Tor не работает».
    let public = hex::encode(key.public());
    assert!(
        onion::verify(&signature, &hosts, issued_at, &public),
        "подпись не сходится собственной проверкой — не выкладывайте её",
    );

    println!("открытый ключ (в onion.rs):  {public}");
    println!("VALANIUM_ONION_SIG={signature}");
    println!("VALANIUM_ONION_ISSUED_AT={issued_at}");
    println!("VALANIUM_ONION_HOSTS={}", hosts.join(","));
    eprintln!();
    eprintln!("Порядок адресов входит в подпись: сервер обязан отдавать их");
    eprintln!("ровно в этом порядке, иначе клиент список не примет.");
}

//! Проверяет подписанный манифест той же криптографией, что и клиент.
//!
//! Подпись считает Node (@noble), проверяет Rust (ed25519-dalek). Расхождение
//! между библиотеками проявилось бы как «не удалось установить», и искать его
//! пришлось бы у пользователя. Дешевле убедиться здесь.
//!
//!   cargo run --example check_manifest -- deploy/onionize.json <открытый ключ>

fn main() {
    let path = std::env::args().nth(1).expect("укажите путь к json");
    let public = std::env::args().nth(2).expect("укажите открытый ключ");
    let raw = std::fs::read_to_string(&path).expect("не прочитать файл");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("не разобрать json");

    let manifest = value["manifest"].as_str().expect("нет поля manifest");
    let signature = value["signature"].as_str().expect("нет поля signature");

    let ok = valanium_core::keys::verify(
        &hex::decode(signature).expect("подпись не hex"),
        manifest.as_bytes(),
        &hex::decode(&public).expect("ключ не hex"),
    );
    println!("подпись {}", if ok { "СХОДИТСЯ" } else { "НЕ СХОДИТСЯ" });

    // И заодно: подделка обязана не проходить, иначе проверка выше ничего не значит.
    let tampered = manifest.replace("0.1.0", "0.1.1");
    let still = valanium_core::keys::verify(
        &hex::decode(signature).unwrap(),
        tampered.as_bytes(),
        &hex::decode(&public).unwrap(),
    );
    println!("подделка {}", if still { "ПРОШЛА — это плохо" } else { "отбита" });
    std::process::exit(if ok && !still { 0 } else { 1 });
}

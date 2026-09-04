//! Проба встроенного Tor (Arti): сколько ждать и сколько весит.
//!
//! # Зачем отдельной программой
//!
//! Решение про встроенный Tor упирается в два числа — время до готовности
//! цепи и прибавка к размеру сборки, — и оба надо получить **до** того, как
//! Arti окажется вплетён в клиент. Отдельная проба меряет их, ничего не ломая:
//! не понравятся числа — удаляется одним файлом.
//!
//! # Что меряем
//!
//! 1. Bootstrap — от запуска до готовности работать. Первый раз дороже: Tor
//!    качает консенсус каталога. Второй запуск обязан быть заметно быстрее за
//!    счёт кэша, и разница между первым и вторым — это и есть цена «холодного»
//!    старта, которую увидит человек, поставивший приложение.
//! 2. Соединение с нашим onion-входом: цепь построена — но дошли ли мы.
//!
//! # Как запускать
//!
//! Зависимость не входит в обычную сборку, поэтому сначала её надо добавить
//! (версию подберёт cargo — вписывать её сюда наугад нельзя):
//!
//! ```text
//! cargo add arti-client --optional --no-default-features \
//!     --features tokio,rustls,onion-service-client
//! cargo add tor-rtcompat --optional --features tokio,rustls
//! ```
//!
//! затем в Cargo.toml:
//!
//! ```toml
//! [features]
//! tor-embedded = ["dep:arti-client", "dep:tor-rtcompat"]
//!
//! [[example]]
//! name = "tor_probe"
//! required-features = ["tor-embedded"]
//! ```
//!
//! и наконец:
//!
//! ```text
//! cargo run --release --features tor-embedded --example tor_probe -- <адрес>.onion
//! ```
//!
//! Прибавку к размеру считать так: собрать `--release` без флага и с ним,
//! сравнить размер библиотеки. Мерить надо именно release: в debug числа
//! бессмысленны.
//!
//! # Оговорка
//!
//! Вызовы ниже написаны по памяти об API Arti и **не проверялись сборкой**.
//! Если что-то не сойдётся, ошибка будет в трёх строках, а не в клиенте — ради
//! этого проба и отдельная. Присылайте текст ошибки, поправим по факту.

use std::time::Instant;

use arti_client::{TorClient, TorClientConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = std::env::args()
        .nth(1)
        .expect("usage: tor_probe <адрес>.onion   (голый адрес, без ws:// и /ws)");
    assert!(host.ends_with(".onion"), "нужен onion-адрес, а не {host}");

    // Кэш каталога кладём в отдельное место и говорим об этом вслух: это новый
    // след на диске, который сообщает, что человек пользовался Tor. В боевом
    // клиенте ему место в запечатанном хранилище, а не в профиле пользователя.
    let config = TorClientConfig::default();

    let started = Instant::now();
    let client = TorClient::create_bootstrapped(config).await?;
    let bootstrap = started.elapsed();
    println!("готовность цепи: {:.1} с", bootstrap.as_secs_f64());

    let dialing = Instant::now();
    let _stream = client.connect((host.as_str(), 80)).await?;
    println!("соединение с {host}: {:.1} с", dialing.elapsed().as_secs_f64());
    println!("итого до первого байта: {:.1} с", started.elapsed().as_secs_f64());

    println!();
    println!("Запустите второй раз: разница с первым запуском — цена холодного");
    println!("старта, её и увидит человек, поставивший приложение впервые.");
    Ok(())
}

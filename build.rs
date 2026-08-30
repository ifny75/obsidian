//! Пересборка при смене service token'а Cloudflare Access.
//!
//! `option_env!` в `edge.rs` вычисляется при компиляции, а cargo сам по себе за
//! переменными окружения не следит: сменили токен, пересобрали — и получили
//! бинарь со старым, потому что «ничего не изменилось». Ошибка тем неприятнее,
//! что проявится она не на сборке, а на живом сервере, отказом Access пускать
//! свежий клиент.
fn main() {
    println!("cargo:rerun-if-env-changed=OBSIDIAN_ACCESS_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=OBSIDIAN_ACCESS_CLIENT_SECRET");
}

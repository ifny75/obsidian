//! obsidian-core — граница доверия клиента.
//!
//! Всё, что выше этой библиотеки, — UI, ему можно отдавать открытый текст.
//! Всё, что ниже, — враждебная среда: сервер, Cloudflare, сеть.
//!
//! Наружу торчит намеренно узкий интерфейс: команды внутрь, события наружу
//! (`command.rs`), четыре C-функции для JNI и Tauri (`ffi.rs`). Богатого API
//! здесь нет и не должно быть — его пришлось бы биндить дважды.

pub mod access;
pub mod client;
pub mod command;
pub mod crypto;
pub mod directory;
pub mod edge;
pub mod error;
pub mod ffi;
pub mod keys;
pub mod migrate;
pub mod mls;
pub mod passphrase;
pub mod pins;
pub mod privacy;
pub mod profile;
pub mod proto;
pub mod recovery;
pub mod store;
pub mod totp;

pub use error::{CoreError, Result};

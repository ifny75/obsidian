//! Подписанный список onion-входов.
//!
//! # Зачем
//!
//! Адреса входов клиент узнаёт из HELLO и запоминает — иначе смена узла или
//! потеря одного из них требовали бы новой сборки и рассылки всем. Плата за
//! удобство была такая: список приходил **от сервера и ничем не подтверждался**.
//!
//! Для Onion это хуже, чем для остальных маршрутов. Весь смысл Tor-режима в
//! том, что адреса пользователя не знает никто, включая нас. Но если сервер
//! может назвать любой адрес, он может назвать и свой — тот, что смотрит в
//! clearnet, — и человек, выбравший Tor, пойдёт мимо Tor, ничего не заметив.
//! Захваченный сервер тем более: один кадр HELLO уводит всех, кто ему поверил.
//!
//! Поэтому список подписывается офлайновым ключом, а клиент проверяет подпись
//! сам. Сервер по-прежнему решает, какой список показать, — но сочинить новый
//! не может.
//!
//! # Откат — отдельная забота
//!
//! Одной подписи мало. Подписанный список не перестаёт быть подписанным, когда
//! устаревает: сервер может отдать **старый** список и увести на узел, который
//! мы уже вывели из сети, — возможно, потому что его и изъяли. Подпись такое
//! пропустит, ведь она подлинная.
//!
//! Поэтому в подписываемое входит `issued_at`, а клиент помнит последний
//! принятый и не принимает более ранний. Это не защищает от того, что сервер
//! просто промолчит и оставит нас на прежнем списке, — молчание подписью не
//! ловится вообще, — но подменить свежее старым больше нельзя.
//!
//! # Пока ключ не заведён
//!
//! [`PUBLIC_KEY`] по умолчанию пустой, и тогда **не принимается ни один
//! список**: клиент остаётся на адресах, зашитых в сборку. Так выбрано
//! намеренно — «ключа нет, значит верим чему прислали» превратило бы защиту в
//! украшение. Запасных входов в сборке несколько, поэтому Onion продолжает
//! работать и без единого принятого списка.

use sha2::{Digest, Sha256};

use crate::keys::{self, SecretKey};

/// Привязка подписи к назначению: тем же ключом подписанное что-то другое
/// списком входов не станет.
const DOMAIN: &[u8] = b"valanium-onion-hosts-v1";

/// Ключ, которым подписан список входов, в hex.
///
/// Отдельный от ключа релизов намеренно. Разделение доменов защищает от
/// путаницы схем, но не от компрометации: один ключ на всё означает, что
/// утративший его теряет разом и обновления, и маршруты. Приватная половина
/// живёт офлайн, у владельца, и на серверы не попадает никогда.
///
/// Пустая строка = проверять нечем, списки не принимаются. См. шапку.
pub const PUBLIC_KEY: &str = "";

/// То, что подписывает владелец.
///
/// Длины перед полями обязательны: без них списки `["ab", "c"]` и `["a", "bc"]`
/// дали бы один хеш, а значит одну подпись — и переставить границы адресов смог
/// бы кто угодно. Число адресов тоже входит в хеш, иначе список можно было бы
/// безнаказанно укоротить до одного удобного узла.
fn digest(hosts: &[String], issued_at: i64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update((hosts.len() as u64).to_be_bytes());
    for host in hosts {
        hasher.update((host.len() as u64).to_be_bytes());
        hasher.update(host.as_bytes());
    }
    hasher.update(issued_at.to_be_bytes());
    hasher.finalize().into()
}

/// Подписывает список. Вызывается офлайн, при выпуске, а не на сервере.
pub fn sign(key: &SecretKey, hosts: &[String], issued_at: i64) -> String {
    hex::encode(key.sign(&digest(hosts, issued_at)))
}

/// Проверяет подпись списка заданным ключом.
///
/// `false` — не подтверждено: подписи нет, она не сходится, ключ не задан или
/// испорчен. Различать эти случаи наружу незачем — список либо принимается
/// целиком, либо не принимается вовсе.
pub fn verify(signature: &str, hosts: &[String], issued_at: i64, public_key: &str) -> bool {
    if public_key.is_empty() || hosts.is_empty() {
        return false;
    }
    let (Ok(signature), Ok(public)) = (hex::decode(signature), hex::decode(public_key)) else {
        return false;
    };
    keys::verify(&signature, &digest(hosts, issued_at), &public)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::SecretKey;

    fn hosts(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn key_pair() -> (SecretKey, String) {
        let key = SecretKey::generate();
        let public = hex::encode(key.public());
        (key, public)
    }

    #[test]
    fn a_signed_list_verifies() {
        let (key, public) = key_pair();
        let list = hosts(&["aaa.onion", "bbb.onion"]);
        let signature = sign(&key, &list, 1_700_000_000);
        assert!(verify(&signature, &list, 1_700_000_000, &public));
    }

    #[test]
    fn every_field_is_covered_by_the_signature() {
        let (key, public) = key_pair();
        let list = hosts(&["aaa.onion", "bbb.onion"]);
        let at = 1_700_000_000;
        let signature = sign(&key, &list, at);

        // Подменённый адрес.
        assert!(!verify(&signature, &hosts(&["evil.onion", "bbb.onion"]), at, &public));
        // Укороченный список: иначе сервер оставил бы один удобный ему узел.
        assert!(!verify(&signature, &hosts(&["aaa.onion"]), at, &public));
        // Дописанный адрес.
        assert!(!verify(
            &signature,
            &hosts(&["aaa.onion", "bbb.onion", "evil.onion"]),
            at,
            &public,
        ));
        // Другое время выпуска.
        assert!(!verify(&signature, &list, at + 1, &public));
    }

    #[test]
    fn borders_between_hosts_cannot_be_moved() {
        // Без длин перед полями эти два списка склеились бы в одну строку и
        // получили одинаковый хеш. Проверяем, что не получают.
        let (key, public) = key_pair();
        let one = hosts(&["ab", "c"]);
        let two = hosts(&["a", "bc"]);
        let signature = sign(&key, &one, 7);
        assert!(verify(&signature, &one, 7, &public));
        assert!(!verify(&signature, &two, 7, &public));
    }

    #[test]
    fn another_key_does_not_pass() {
        let (key, _) = key_pair();
        let (_, stranger) = key_pair();
        let list = hosts(&["aaa.onion"]);
        let signature = sign(&key, &list, 1);
        assert!(!verify(&signature, &list, 1, &stranger));
    }

    #[test]
    fn without_a_key_nothing_is_accepted() {
        // Главное свойство: пока ключ не заведён, подпись не «считается
        // верной по умолчанию» — она не принимается вовсе.
        let (key, _) = key_pair();
        let list = hosts(&["aaa.onion"]);
        let signature = sign(&key, &list, 1);
        assert!(!verify(&signature, &list, 1, ""));
    }

    #[test]
    fn garbage_does_not_panic() {
        let (_, public) = key_pair();
        let list = hosts(&["aaa.onion"]);
        for signature in ["", "zz", "нет", &"a".repeat(128)] {
            assert!(!verify(signature, &list, 1, &public));
        }
        assert!(!verify("00", &[], 1, &public), "пустой список принимать нечего");
    }
}

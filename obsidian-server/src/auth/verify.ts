import { ed25519 } from "@noble/curves/ed25519";
import { ascii, concat } from "../util/bytes.ts";

/**
 * Доменные префиксы обязательны: без них подпись, снятая в одном контексте,
 * переиспользуется в другом (ARCHITECTURE.md §6).
 */
const DOMAIN_AUTH = ascii("obsidian-auth-v1");
const DOMAIN_DEVICE = ascii("obsidian-device-v1");
const DOMAIN_REVOKE_OTHERS = ascii("obsidian-device-revoke-others-v1");

/** `sign(identity_priv, "obsidian-device-v1" || identity_pub || device_pub)` */
export function deviceCertMessage(identityPub: Uint8Array, devicePub: Uint8Array): Uint8Array {
  return concat(DOMAIN_DEVICE, identityPub, devicePub);
}

/** `sign(device_priv, "obsidian-auth-v1" || nonce || identity_pub || device_pub)` */
export function authMessage(
  nonce: Uint8Array,
  identityPub: Uint8Array,
  devicePub: Uint8Array,
): Uint8Array {
  return concat(DOMAIN_AUTH, nonce, identityPub, devicePub);
}

/** Доказательство identity-ключом: обычного ключа устройства для отзыва мало. */
export function revokeOtherDevicesMessage(
  identityPub: Uint8Array,
  keepDevicePub: Uint8Array,
): Uint8Array {
  return concat(DOMAIN_REVOKE_OTHERS, identityPub, keepDevicePub);
}

/**
 * Не бросает: любая кривая точка или подпись — просто false.
 *
 * `zip215: false` обязателен. В режиме по умолчанию noble следует правилам
 * ZIP-215, а они принимают точки малого порядка: ключ из одних нулей с подписью
 * из одних нулей проходит проверку. Такую личность может подписать кто угодно,
 * то есть её можно захватить вместе с оплаченным счётом. Строгий режим
 * (RFC 8032) отвергает все девять таких кодировок — это покрыто тестом.
 */
export function verify(sig: Uint8Array, message: Uint8Array, pub: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, pub, { zip215: false });
  } catch {
    return false;
  }
}

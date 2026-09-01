import { config } from "../config.ts";
import { log } from "../log.ts";

/**
 * Отправка ответа из панели.
 *
 * Через HTTPS-API провайдера, а не по SMTP, и это вынужденно: у хостеров порт
 * 25 закрыт почти всегда, а поднимать свой почтовый сервер на той же машине,
 * где лежит база мессенджера, — это лишний демон, слушающий интернет, ради
 * пары писем в неделю. Цена решения названа честно: провайдер видит адрес
 * получателя и текст ответа. Поэтому в поддержку и нельзя писать ничего, что
 * составляет тайну переписки, — там её и нет, туда пишут «не приходит код».
 *
 * Cloudflare Email Routing, которым письма принимаются, отправлять не умеет
 * вовсе — отсюда второй, отдельный канал наружу.
 */

export class MailError extends Error {}

/** Заголовок письма не должен содержать перевод строки: это инъекция. */
function cleanSubject(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").trim().slice(0, 200) || "Re: поддержка Valanium";
}

function assertAddress(address: string): void {
  // Намеренно нестрого: почтовые адреса бывают причудливыми, а мы всего лишь
  // не хотим пустить в поле управляющие символы и заведомый мусор.
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(address)) {
    throw new MailError("некорректный адрес получателя");
  }
}

/**
 * Отдаёт письмо провайдеру. Бросает, если он его не принял.
 *
 * Ответ в базу пишется только после успеха: показать в панели отправленным то,
 * что никуда не ушло, — худший из возможных исходов, потому что человек будет
 * ждать ответа, которого нет.
 */
export async function sendReply(to: string, subject: string, body: string): Promise<void> {
  assertAddress(to);
  if (!config.support.apiKey) throw new MailError("отправка не настроена: нет VALANIUM_SUPPORT_API_KEY");

  const response = await fetch(config.support.apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.support.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${config.support.fromName} <${config.support.address}>`,
      to: [to],
      subject: cleanSubject(subject),
      text: body,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    throw new MailError(`почтовый провайдер недоступен: ${String(error)}`);
  });

  if (!response.ok) {
    // Тело ответа провайдера в журнал не пишем целиком: там эхом бывает и
    // адрес, и текст письма, а журналы у нас без персональных данных.
    log.warn(`support reply rejected status=${response.status}`);
    throw new MailError(`провайдер отклонил письмо (${response.status})`);
  }
}

/*
  Cloudflare Email Worker: приём писем на support@valanium.com.

  Cloudflare Email Routing умеет принимать письма, но не умеет их отправлять и
  не умеет складывать никуда, кроме пересылки на другой ящик. Поэтому воркер:
  разбирает входящее, отдаёт его серверу по HTTPS и параллельно пересылает
  копию на обычный ящик.

  Пересылка копии обязательна, а не опциональна: отвечают именно из этого
  ящика. Сервер почту только принимает и показывает — Email Routing отправлять
  не умеет, а поднимать ради пары писем в неделю SMTP-провайдера с доменной
  подписью и репутацией несоразмерно. Панель отвечает на вопрос «что нам
  написали»; сам ответ уходит обычным «ответить» в почтовом клиенте.

  Заодно это страховка: если сервер лежит или секрет разошёлся, письмо не
  исчезнет. Поддержка, которая молча теряет обращения, хуже отсутствующей —
  на отсутствующую хотя бы не надеются.

  Развернуть:
    1. Cloudflare → Email → Email Routing, включить для valanium.com
       (добавятся MX и TXT-записи).
    2. Workers & Pages → Create → Worker, вставить этот файл.
    3. Settings → Variables:
         VALANIUM_INBOUND_URL   = https://valanium.com/v1/support/inbound
         VALANIUM_INBOUND_TOKEN = <тот же секрет, что VALANIUM_SUPPORT_INBOUND_TOKEN в .env>
         VALANIUM_FORWARD_TO    = <ваш обычный ящик>
       Токен заводить как Secret, а не как обычную переменную.
    4. Email Routing → Routes → support@valanium.com → Send to Worker → этот воркер.
    5. Адрес из VALANIUM_FORWARD_TO подтвердить в Email Routing → Destination
       addresses, иначе пересылка молча не поедет.
*/

/** Письмо больше этого — почти наверняка вложения, а их панель не показывает. */
const MAX_BYTES = 512 * 1024;

async function readText(message) {
  // Тело приходит потоком; читаем с потолком, чтобы мегабайтное письмо не
  // съело память воркера.
  const reader = message.raw.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) break;
    chunks.push(value);
  }
  const raw = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());

  // Разделитель заголовков и тела — пустая строка. Полноценный MIME-разбор
  // здесь не нужен и вреден: чем больше кода, тем больше поверхность.
  const split = raw.indexOf("\r\n\r\n");
  const body = split === -1 ? raw : raw.slice(split + 4);
  return body.trim().slice(0, MAX_BYTES);
}

export default {
  async email(message, env) {
    const subject = message.headers.get("subject") ?? "";
    let text = "";
    try {
      text = await readText(message);
    } catch {
      text = "";
    }

    // Сначала пересылка: это единственный путь, которым владелец сможет
    // ответить, и он не должен зависеть от живости нашего сервера.
    if (env.VALANIUM_FORWARD_TO) {
      try {
        await message.forward(env.VALANIUM_FORWARD_TO);
      } catch (error) {
        console.log(`forward failed: ${error}`);
      }
    }

    if (!env.VALANIUM_INBOUND_URL || !env.VALANIUM_INBOUND_TOKEN) return;
    try {
      const response = await fetch(env.VALANIUM_INBOUND_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.VALANIUM_INBOUND_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          subject,
          text: text || "(пустое письмо)",
        }),
      });
      // Адрес и тему в журнал не пишем: журналы Cloudflare — это ещё одно место,
      // где иначе осели бы персональные данные.
      if (!response.ok) console.log(`inbound rejected: ${response.status}`);
    } catch (error) {
      console.log(`inbound unreachable: ${error}`);
    }
  },
};

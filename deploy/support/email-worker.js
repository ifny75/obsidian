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
    2. Вписать свой ящик в FORWARD_TO ниже.
    3. Workers & Pages → Create → Worker, вставить этот файл.
    4. Settings → Variables → одна переменная:
         VALANIUM_INBOUND_TOKEN = <тот же секрет, что VALANIUM_SUPPORT_INBOUND_TOKEN в .env>
       Завести как Secret. Больше переменных не нужно.
    5. Email Routing → Routes → support@valanium.com → Send to Worker → этот воркер.
    6. Адрес из FORWARD_TO подтвердить в Email Routing → Destination addresses,
       иначе пересылка молча не поедет.

  Адрес сервера и ящик пересылки лежат здесь константами, а не переменными:
  секрета в них нет, а код воркера виден только владельцу аккаунта. В
  переменной остаётся ровно то, что обязано быть скрытым, — общий с сервером
  секрет.
*/

/** Куда сервер принимает письма. Публичный адрес, прятать нечего. */
const INBOUND_URL = "https://valanium.com/v1/support/inbound";

/**
 * Ящик, куда уходит копия каждого письма. ВПИСАТЬ СВОЙ.
 *
 * Это единственный путь, которым можно ответить: сервер почту только
 * принимает. Пустое значение = обращения видно в панели, но ответить нечем.
 */
const FORWARD_TO = "";

/** Письмо больше этого — почти наверняка вложения, а их панель не показывает. */
const MAX_BYTES = 512 * 1024;

/*
  Разбор письма: из сырого MIME — читаемый текст.

  Первая версия резала строку по первому пустому переводу и отдавала остаток
  как есть. На живом письме это дало в панели заголовки частей и base64:
  почти всякий почтовый клиент шлёт multipart/alternative, где текст лежит
  внутри части и закодирован. Поэтому разбор здесь настоящий, хоть и маленький.

  Библиотеку не берём: воркер вставляют в дашборд одним файлом, а сборщик ради
  одного разбора — лишний шаг в развёртывании.

  Держится на том, что письмо превращается в побайтовую строку: один байт —
  один символ. Тогда base64 и quoted-printable раскладываются в настоящие
  байты, которые уже потом читаются в объявленной кодировке. Прочитать сразу
  как UTF-8 значило бы испортить байты до разбора.

  Строка собирается вручную, а не через TextDecoder("latin1"): по стандарту
  кодирования "latin1" и "iso-8859-1" — это метки windows-1252, а он байты
  0x80..0x9F отображает не один к одному. Побайтовой строки от него не выйдет,
  и письмо с такими байтами разобралось бы в мусор.
*/

/** Заголовки части: продолжения строк складываются, имена — в нижний регистр. */
export function parseHeaders(block) {
  const headers = new Map();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

function paramOf(value, name) {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*([^;\\s]+)`, "i").exec(value ?? "");
  return match ? (match[1] ?? match[2]) : null;
}

function bytesFromBase64(raw) {
  const clean = raw.replace(/[^A-Za-z0-9+/=]/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesFromQuotedPrintable(raw) {
  // Мягкий перенос "=\n" склеивает строку и байтом не является.
  const text = raw.replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(text.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function decodePart(body, encoding, charset) {
  const how = (encoding ?? "7bit").toLowerCase();
  let bytes;
  if (how === "base64") bytes = bytesFromBase64(body);
  else if (how === "quoted-printable") bytes = bytesFromQuotedPrintable(body);
  else {
    bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    // Незнакомая кодировка — лучше показать как есть, чем не показать ничего.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Грубое превращение HTML в текст: нужно только когда текстовой части нет. */
function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n");
}

function splitParts(body, boundary) {
  const parts = [];
  const marker = `--${boundary}`;
  for (const chunk of body.split(marker)) {
    const trimmed = chunk.replace(/^\r?\n/, "");
    if (trimmed.startsWith("--") || trimmed.trim().length === 0) continue;
    parts.push(trimmed);
  }
  return parts;
}

/**
 * Возвращает читаемый текст письма.
 *
 * Предпочитается text/plain: он и есть то, что человек написал. HTML берётся
 * только когда текстовой части нет вовсе, и тогда разметка снимается — иначе
 * в панель приехали бы теги.
 */
export function extractText(rawMessage, depth = 0) {
  const split = rawMessage.search(/\r?\n\r?\n/);
  // Заголовков нет вовсе — значит всё письмо есть тело. Прочитать его всё
  // равно надо: на входе побайтовая строка, а не готовый текст.
  if (split === -1) return decodePart(rawMessage, null, "utf-8").trim();

  const headers = parseHeaders(rawMessage.slice(0, split));
  const body = rawMessage.slice(split).replace(/^\r?\n\r?\n/, "");
  const contentType = headers.get("content-type") ?? "text/plain";
  const encoding = headers.get("content-transfer-encoding");
  const charset = paramOf(contentType, "charset");

  if (/^multipart\//i.test(contentType)) {
    const boundary = paramOf(contentType, "boundary");
    // Вложенность бывает (mixed внутри alternative), но не бесконечная:
    // ограничение спасает от письма, собранного специально против нас.
    if (!boundary || depth > 8) return "";
    const parts = splitParts(body, boundary);

    let html = "";
    for (const part of parts) {
      const text = extractText(part, depth + 1);
      if (!text) continue;
      const partType = parseHeaders(part.slice(0, Math.max(0, part.search(/\r?\n\r?\n/)))).get("content-type") ?? "";
      if (/^text\/html/i.test(partType)) {
        if (!html) html = text;
        continue;
      }
      if (text.trim()) return text.trim();
    }
    return html.trim();
  }

  const decoded = decodePart(body, encoding, charset);
  if (/^text\/html/i.test(contentType)) return htmlToText(decoded).trim();
  return decoded.trim();
}

/** Сырые байты письма, побайтово в строку. Потолок — чтобы не съесть память. */
async function readRaw(message) {
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
  return binaryString(new Uint8Array(await new Blob(chunks).arrayBuffer()));
}

/** Байты в строку один к одному. Кусками: аргументов у apply не бесконечно. */
export function binaryString(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return out;
}

export default {
  async email(message, env) {
    const subject = message.headers.get("subject") ?? "";
    let text = "";
    try {
      text = extractText(await readRaw(message)).slice(0, MAX_BYTES);
    } catch (error) {
      // Разбор не должен ронять приём: лучше пустое тело и видимое обращение,
      // чем потерянное письмо. Тема и адрес в панели останутся.
      console.log(`parse failed: ${error}`);
    }

    // Сначала пересылка: это единственный путь, которым владелец сможет
    // ответить, и он не должен зависеть от живости нашего сервера.
    if (FORWARD_TO) {
      try {
        await message.forward(FORWARD_TO);
      } catch (error) {
        console.log(`forward failed: ${error}`);
      }
    }

    if (!env.VALANIUM_INBOUND_TOKEN) return;
    try {
      const response = await fetch(INBOUND_URL, {
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

/*
  Разбор письма проверяется на настоящих образцах.

  Повод конкретный: первая версия воркера резала MIME по первому пустому
  переводу строки, и в панель приехали заголовки частей вместе с base64 вместо
  текста. Такое видно только на живом письме, поэтому образцы здесь из
  настоящей почты, а не выдуманные.

  Второй повод: побайтовую строку нельзя получить через TextDecoder("latin1").
  По стандарту кодирования это метка windows-1252, и байты 0x80..0x9F он
  отображает не один к одному — письмо с ними разбиралось бы в мусор.

  Запуск: node deploy/support/mime.test.mjs
*/
import { extractText, binaryString } from "./email-worker.js";

// Воркер видит письмо побайтовой строкой. Тест обязан кормить парсер тем же,
// иначе проверяет не то, что работает в бою.
const asWorkerSees = (text) => binaryString(new TextEncoder().encode(text));
const CRLF = "\r\n";
const j = (...lines) => lines.join(CRLF);

let failed = 0;
function check(name, raw, expected) {
  const got = extractText(asWorkerSees(raw));
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "СБОЙ"} ${name}`);
  if (!ok) console.log(`      ждали: ${JSON.stringify(expected)}\n      вышло: ${JSON.stringify(got)}`);
}

const b = "b1=_cuyvI31Snbd";
check("Proton: multipart/alternative + base64",
  j("From: someone@proton.me", "Subject: Hi!", `Content-Type: multipart/alternative; boundary="${b}"`, "",
    `--${b}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    "U2VudCB3aXRoIFtQcm90b24gTWFpbF0oaHR0cHM6Ly9wcm90b24ubWUvbWFpbC9ob21lKSBzZWN1",
    "cmUgZW1haWwu", "",
    `--${b}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    "PGRpdj5IVE1MPC9kaXY+", "", `--${b}--`),
  "Sent with [Proton Mail](https://proton.me/mail/home) secure email.");

check("простой text/plain с кириллицей",
  j("From: a@b.c", "Content-Type: text/plain; charset=utf-8", "", "Привет, это обычное письмо."),
  "Привет, это обычное письмо.");

check("quoted-printable, кириллица",
  j("From: a@b.c", "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable", "",
    "=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82 =D0=BC=D0=B8=D1=80"),
  "Привет мир");

check("только HTML — разметка снимается",
  j("From: a@b.c", "Content-Type: text/html; charset=utf-8", "", "<div>Строка<br>вторая</div>"),
  "Строка\nвторая");

check("вложенный multipart: mixed -> alternative",
  j("From: a@b.c", 'Content-Type: multipart/mixed; boundary="out"', "",
    "--out", 'Content-Type: multipart/alternative; boundary="in"', "",
    "--in", "Content-Type: text/plain; charset=utf-8", "", "Текст изнутри.", "--in--", "--out--"),
  "Текст изнутри.");

check("письмо без заголовков не роняет разбор", "просто строка", "просто строка");

console.log(failed === 0 ? "\nвсе проверки прошли" : `\nсбоев: ${failed}`);
process.exit(failed === 0 ? 0 : 1);

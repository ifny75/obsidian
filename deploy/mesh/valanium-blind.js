/*
  Ослепление адреса клиента на входном узле.

  До сих пор настоящий адрес ехал через все узлы до main в заголовке
  `CF-Connecting-IP`: его клал Cloudflare, а мы честно передавали дальше.
  Значит, адрес знали три машины вместо одной, хотя нужен он ровно для одного —
  считать лимиты «на клиента».

  Считать их можно и по непрозрачному жетону. Здесь адрес превращается в
  HMAC и дальше не едет вовсе: второй узел и main видят строку, из которой
  ничего не восстановить. Сам адрес живёт доли секунды в памяти nginx и никуда
  не пишется — журналы мы от него уже очистили.

  У каждого ingress relay свой секрет. Общий ключ позволил бы downstream-узлу
  перебрать IPv4 за известный день и сопоставить наблюдаемый жетон с адресом.
  Разные жетоны компенсируются identity-wide и глобальными лимитами на main.

  В сообщение подмешивается дата, поэтому жетон **меняется каждые сутки**.
  Это намеренно: без ротации он стал бы долговременным псевдонимом, по
  которому нас же и попросили бы связать вчерашнюю активность с сегодняшней.
  Плата известна — в полночь счётчики лимитов начинаются заново.

  Обратного преобразования нет и не будет. Таблица «жетон → адрес» превратила
  бы «мы не знаем» в «мы знаем, но обещали не смотреть», и изъяли бы её первой.
*/

import crypto from 'crypto';
import fs from 'fs';

const KEY_PATH = '/etc/nginx/valanium-blind.key';

/** Секрет читается один раз при запуске: он не меняется без перезагрузки. */
let secret = null;
function key() {
    if (secret === null) {
        secret = fs.readFileSync(KEY_PATH, 'utf8').trim();
    }
    return secret;
}

/**
 * Схлопывает IPv6 до /64.
 *
 * Обязательно до хеширования: иначе владелец подсети получает новый жетон на
 * каждый адрес и обходит любой потолок, ни разу его не превысив. Для IPv4
 * берётся адрес целиком, отображённый IPv4 (`::ffff:1.2.3.4`) — это IPv4.
 */
function subnet(address) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) {
        return mapped[1];
    }
    if (address.indexOf(':') < 0) {
        return address;
    }

    const halves = address.split('::');
    if (halves.length > 2) {
        return address;
    }
    const head = halves[0] === '' ? [] : halves[0].split(':');
    const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

    let groups;
    if (halves.length === 1) {
        if (head.length !== 8) {
            return address;
        }
        groups = head;
    } else {
        const missing = 8 - head.length - tail.length;
        if (missing < 1) {
            return address;
        }
        groups = head.concat(new Array(missing).fill('0'), tail);
    }
    return groups.slice(0, 4).join(':') + '::/64';
}

/** Сегодняшний день в UTC: он же и есть срок жизни жетона. */
function today() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Жетон вместо адреса. Пустая строка — адреса не было (onion или прямой
 * запрос): решать, что с этим делать, будет приложение.
 */
function blindClient(r) {
    const address = r.headersIn['CF-Connecting-IP'];
    if (!address) {
        return '';
    }
    // Заголовок может прийти списком: первый в нём — исходный клиент.
    const first = address.split(',')[0].trim();
    if (first === '') {
        return '';
    }

    return crypto.createHmac('sha256', key())
        .update(today() + '|' + subnet(first))
        .digest('hex')
        .slice(0, 16);
}

export default { blindClient };

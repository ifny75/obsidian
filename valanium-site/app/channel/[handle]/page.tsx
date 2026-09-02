import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AndroidIcon, WindowsIcon } from '../../components/icons';
import { OG_IMAGE } from '../../layout';
import { RELEASES } from '../../releases';

/**
 * Страница публичного канала: `valanium.com/channel/notes`.
 *
 * Это не сам канал, а вход в него. Содержимого канала здесь нет намеренно:
 * читать ленту умеет клиент, у которого есть ключи и вход по инвайту, а
 * выкладывать посты ещё и открытым HTTP значило бы раздать их всему интернету
 * — решение куда более серьёзное, чем «сделать ссылку кликабельной».
 *
 * Поэтому страница делает ровно одно: подтверждает, что такая ссылка от
 * Valanium, и показывает, как её открыть.
 */

/** Тот же формат имени, что проверяет сервер (session.ts, HANDLE). */
const HANDLE = /^[a-z][a-z0-9_]{2,29}$/;

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const name = handle.toLowerCase();
  if (!HANDLE.test(name)) return { title: 'Канал не найден — Valanium' };

  // absolute: общий шаблон заголовка добавил бы «— Valanium» второй раз.
  const title = `@${name} — канал в Valanium`;
  const description =
    `Открытый канал @${name}. Чтобы читать его, нужен Valanium: ссылку достаточно ` +
    'вставить в поле поиска в приложении.';
  return {
    title: { absolute: title },
    description,
    /*
      В поиск эти страницы не идут — и дело не в скромности.

      Имя канала проверяется только по формату: сервер о существовании канала не
      спрашивают, и любое сочетание букв отвечает 200. Для краулера это
      бесконечное поле почти одинаковых страниц — он будет ходить по нему вместо
      главной и складывать в индекс тысячи пустышек.

      Страница нужна человеку, который получил ссылку, а не тому, кто ищет.
      Ссылки при этом продолжают работать и показывать нормальную карточку.
    */
    robots: { index: false, follow: true },
    // Ссылку кидают в переписки — карточка должна выглядеть прилично там же.
    openGraph: {
      title,
      description,
      url: `https://valanium.com/channel/${name}`,
      siteName: 'Valanium',
      locale: 'ru_RU',
      type: 'website',
      images: [OG_IMAGE],
    },
  };
}

export default async function ChannelPage({ params }: Props) {
  const { handle } = await params;
  const name = handle.toLowerCase();
  // Имя не по формату — это не канал, а мусор в адресной строке.
  if (!HANDLE.test(name)) notFound();

  const link = `valanium.com/channel/${name}`;

  return (
    <main>
      <header className="site-header">
        <nav className="nav shell">
          <a className="brand" href="/">
            <span className="brand-mark">
              <img src="/valanium.svg" alt="" />
            </span>
            <span>
              <b>Valanium</b>
              <small>Private access</small>
            </span>
          </a>
          <div className="nav-links">
            <a href="/messenger#server">Что видит сервер</a>
            <a href="/messenger#download">Скачать</a>
          </div>
        </nav>
      </header>

      <section className="shell channel-page">
        <p className="eyebrow">Открытый канал</p>
        <h1 className="channel-handle">@{name}</h1>
        <p className="hero-lead">
          Канал открывается в Valanium. Скопируйте ссылку и вставьте её в приложении
          в поле поиска — канал откроется во вкладке «Публичные».
        </p>

        <p className="channel-link">{link}</p>

        <div className="actions">
          <a className="button primary" href={RELEASES.windows.file}>
            <WindowsIcon />
            <span>
              <small>Скачать для</small>
              <b>Windows · {RELEASES.windows.version}</b>
            </span>
          </a>
          <a className="button" href={RELEASES.android.file}>
            <AndroidIcon />
            <span>
              <small>Скачать для</small>
              <b>Android · {RELEASES.android.version}</b>
            </span>
          </a>
        </div>

        <div className="channel-warning">
          <b>Канал — это лента, а не переписка.</b>
          <p>
            Посты открытого канала лежат на сервере <em>без шифрования</em>: у ленты,
            которую читают все, нет получателя, которому её можно зашифровать. Личная
            переписка работает иначе — она шифруется на устройстве, и сервер видит
            только запечатанный конверт.
          </p>
        </div>

        <p className="note">
          Страница не показывает посты канала: их читает приложение, а не сайт.
        </p>
      </section>
    </main>
  );
}

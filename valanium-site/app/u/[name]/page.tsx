import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AndroidIcon, WindowsIcon } from '../../components/icons';
import { OG_IMAGE } from '../../layout';
import { RELEASES } from '../../releases';

/**
 * Личная ссылка: `valanium.com/u/ifny`.
 *
 * Устроена так же, как страница канала, и по той же причине: сервер о человеке
 * не спрашивают. Имя проверяется только по формату — существует оно или нет,
 * страница не знает и знать не должна. Иначе она превратилась бы в способ
 * перебирать занятые имена, а каталог юзернеймов хранит их отпечатки именно
 * ради того, чтобы так нельзя было.
 */

/** Тот же формат, что проверяет сервер: [a-z0-9_]{3,20}. */
const NAME = /^[a-z][a-z0-9_]{2,19}$/;

type Props = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name: raw } = await params;
  const name = raw.toLowerCase();
  if (!NAME.test(name)) return { title: 'Ссылка не найдена — Valanium' };

  const title = `@${name} в Valanium`;
  const description =
    `Написать @${name} в Valanium — мессенджере со сквозным шифрованием. `
    + 'Ссылку достаточно вставить в поле поиска в приложении.';
  return {
    title: { absolute: title },
    description,
    // Как и у каналов: имён бесконечно много, и все отвечают 200. В индексе им
    // делать нечего — см. страницу канала.
    robots: { index: false, follow: true },
    openGraph: {
      title,
      description,
      url: `https://valanium.com/u/${name}`,
      siteName: 'Valanium',
      locale: 'ru_RU',
      type: 'website',
      images: [OG_IMAGE],
    },
  };
}

export default async function UserPage({ params }: Props) {
  const { name: raw } = await params;
  const name = raw.toLowerCase();
  if (!NAME.test(name)) notFound();

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
        <p className="eyebrow">Личная ссылка</p>
        <h1 className="channel-handle">@{name}</h1>
        <p className="hero-lead">
          Чтобы написать, нужен Valanium. Скопируйте ссылку и вставьте её в приложении
          в поле поиска — диалог откроется сам.
        </p>

        <p className="channel-link">valanium.com/u/{name}</p>

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
          <b>Страница не подтверждает, что такое имя занято.</b>
          <p>
            Она не спрашивает об этом сервер — и это <em>намеренно</em>: иначе по ней
            можно было бы перебирать занятые имена. Есть человек с таким именем или
            нет, покажет приложение, когда вы вставите ссылку.
          </p>
        </div>
      </section>
    </main>
  );
}

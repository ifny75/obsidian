/* eslint-disable @next/next/no-html-link-for-pages */
import type { Metadata } from 'next';
import { DynamicHeader } from './components/dynamic-header';
import { SupportDialog } from './components/support-dialog';
import { SERVICES } from './services';

const TITLE = 'Valanium — приватные сервисы: мессенджер, почта, VPN';
const DESCRIPTION =
  'Valanium — набор приватных сервисов с общей инфраструктурой: мессенджер со сквозным шифрованием, почта и VPN. Открытый код, собственные узлы, вход без номера телефона.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: 'https://valanium.com/' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: 'https://valanium.com/',
    siteName: 'Valanium',
    locale: 'ru_RU',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: TITLE }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og.png'] },
};

export default function Home() {
  return (
    <main className="hub" id="top">
      <DynamicHeader page="hub" />

      <section className="hub-hero shell">
        <span className="hub-eyebrow">Приватные сервисы</span>
        <h1>Одна инфраструктура.<br /><span>Три способа ей пользоваться.</span></h1>
        <p>
          Общие узлы, общий подход к данным и один принцип: сервер хранит
          столько, сколько нужно для работы, и ни байтом больше.
        </p>
      </section>

      <section className="hub-grid shell" aria-label="Сервисы Valanium">
        {SERVICES.map((service) => (
          <article
            key={service.id}
            className={`hub-card hub-card-${service.id}${service.ready ? '' : ' is-soon'}`}
          >
            <div className="hub-card-top">
              <span className="hub-mark" aria-hidden="true">
                {/* Логотипы сервисов ещё не нарисованы: пока метка из буквы. */}
                {service.letter}
              </span>
              <em>{service.ready ? service.badge : 'Скоро'}</em>
            </div>

            <div className="hub-card-copy">
              <h2>{service.name}</h2>
              <p className="hub-tagline">{service.tagline}</p>
              <p className="hub-about">{service.about}</p>
            </div>

            <ul className="hub-points">
              {service.points.map((point) => <li key={point}>{point}</li>)}
            </ul>

            <a className="hub-action" href={service.href}>
              {service.ready ? 'Открыть' : 'Подробнее'}
              <i aria-hidden="true">→</i>
            </a>
          </article>
        ))}
      </section>

      <section className="hub-shared shell">
        <h2>Что общего у всех трёх</h2>
        <div className="hub-shared-grid">
          <article>
            <h3>Свои узлы</h3>
            <p>Инфраструктура своя, не арендованная у платформы. Состояние каждого узла видно публично.</p>
          </article>
          <article>
            <h3>Минимум данных</h3>
            <p>Сервер не хранит того, что не нужно для доставки. Чего нет в базе — того нельзя ни потерять, ни выдать.</p>
          </article>
          <article>
            <h3>Открытый код</h3>
            <p>Клиенты, ядро и сервер опубликованы под AGPL-3.0. Проверить обещания можно самому.</p>
          </article>
        </div>
      </section>

      <footer className="site-footer shell">
        <span>© 2026 Valanium · AGPL-3.0</span>
        <nav aria-label="Служебные ссылки">
          <a href="/status">Статус сети</a>
          <a href="/privacy">Политика конфиденциальности</a>
          <a href="/terms">Соглашение</a>
          <SupportDialog />
          <a href="https://github.com/ifny75/valanium" target="_blank" rel="noreferrer noopener">GitHub</a>
        </nav>
      </footer>
    </main>
  );
}

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

/*
  Главная собрана из тех же блоков, что страница мессенджера: тот же hero,
  те же карточки `.feature-card`, тот же закрывающий блок.

  Это не экономия усилий, а требование: раньше выбор сервисов был написан
  своей вёрсткой и читался как соседний сайт. Общие классы означают, что
  разъехаться им негде — правка стиля в одном месте меняет всё разом.
*/
export default function Home() {
  return (
    <main id="top">
      <DynamicHeader page="hub" />

      <section className="hero shell">
        <div className="hero-copy">
          <h1>Одна инфраструктура<span>три способа ей пользоваться</span></h1>
          <p>Мессенджер, почта и VPN на общих узлах</p>
          <div className="actions">
            <a className="download-button download-button-light" href="/messenger">
              <img className="platform-svg" src="/logos/messenger.svg" alt="" />
              <span><small>Работает сейчас</small><b>Мессенджер</b></span>
            </a>
            <a className="download-button" href="/status">
              <span><small>Публичный</small><b>Статус сети</b></span>
            </a>
          </div>
          <small>Открытый код · AGPL-3.0 · собственные relay-узлы</small>
        </div>
        <div className="phone-stage" aria-hidden="true">
          <span className="phone-glow" />
          <img src="/media/laptop.png" alt="" />
        </div>
      </section>

      <section className="feature-section shell" id="services">
        <h2>Три сервиса.<br />Один подход к данным.</h2>
        <div className="feature-grid">
          {SERVICES.map((service, index) => (
            <article
              key={service.id}
              className={`feature-card feature-card-${service.id}${service.ready ? '' : ' is-soon'}`}
            >
              <div className="feature-title">
                <span className="feature-icon"><img className="service-logo" src={service.logo} alt="" /></span>
                <div><small>{service.badge}</small><h3>{service.short}</h3></div>
                <span className="feature-number">{String(index + 1).padStart(2, '0')}</span>
              </div>
              <p className="feature-copy">
                <strong>{service.tagline}</strong>
                <span>{service.about}</span>
              </p>
              <div className="feature-tags">
                {service.points.map((point) => <span key={point}>{point}</span>)}
              </div>
              <a className="feature-link" href={service.href}>
                {service.ready ? 'Открыть' : 'Подробнее'}<i aria-hidden="true">→</i>
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="server-section shell" id="shared">
        <h2>Что у них общего</h2>
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

        <section className="closing">
          <div className="closing-copy">
            <div className="closing-mark"><img src="/logos/valanium.svg" alt="" /></div>
            <div>
              <span>Без номера телефона</span>
              <h2>Начните с того,<br />что уже работает.</h2>
              <p>Мессенджер выпущен и открыт. Почта и VPN — на подходе.</p>
            </div>
          </div>
          <div className="closing-actions">
            <div className="actions actions-centered">
              <a className="download-button download-button-light" href="/messenger">
                <img className="platform-svg" src="/logos/messenger.svg" alt="" />
                <span><small>Открыть</small><b>Мессенджер</b></span>
              </a>
            </div>
            <small>Бесплатно · Открытый код · AGPL-3.0</small>
          </div>
        </section>
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

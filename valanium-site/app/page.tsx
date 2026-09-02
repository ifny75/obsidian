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
  Главная — витрина, а не рассказ.

  Человек приходит сюда с одним вопросом: «что тут есть». Значит заголовок по
  центру, три плитки сразу под ним, и никакого текста, который надо читать,
  чтобы понять, куда нажать. Подробности живут на страницах сервисов — здесь
  они только мешали бы выбору.

  Плитки нарочно похожи на значки приложений: это привычная человеку форма
  выбора, и её не нужно объяснять.
*/
export default function Home() {
  return (
    <main id="top">
      <DynamicHeader page="hub" />

      <section className="hub-hero shell">
        <h1>Одна инфраструктура<span>три способа ей пользоваться</span></h1>
        <p>Мессенджер, почта и VPN на общих узлах</p>

        <div className="hub-tiles">
          {SERVICES.map((service) => (
            <a
              key={service.id}
              className={`hub-tile hub-tile-${service.id}${service.ready ? '' : ' is-soon'}`}
              href={service.href}
            >
              <span className="hub-tile-icon">
                <img src={service.logo} alt="" />
              </span>
              <b>{service.short}</b>
              <small>{service.ready ? service.badge : 'Скоро'}</small>
            </a>
          ))}
        </div>
      </section>

      {/*
        Светлая полоса — та же, что на странице мессенджера.

        Она не украшение: тёмная страница без единого разрыва читается как
        одно бесконечное полотно, и человек перестаёт различать, где кончился
        один разговор и начался другой. Смена фона делает эту границу
        очевидной, не добавляя ни слова текста.
      */}
      <section className="routes" id="shared">
        <div className="routes-inner shell">
          <div className="routes-copy">
            <div className="routes-heading">
              <span>Общая основа</span>
              <h2>Три сервиса.<br />Одни правила.</h2>
              <p>Что верно для одного — верно для всех: инфраструктура, отношение к данным и открытый код общие.</p>
            </div>
            <ul className="hub-points">
              <li>
                <b>Свои узлы</b>
                <span>Инфраструктура своя, не арендованная у платформы. Состояние каждого узла видно публично.</span>
              </li>
              <li>
                <b>Минимум данных</b>
                <span>Сервер не хранит того, что не нужно для доставки. Чего нет в базе — того нельзя ни потерять, ни выдать.</span>
              </li>
              <li>
                <b>Открытый код</b>
                <span>Клиенты, ядро и сервер опубликованы под AGPL-3.0. Проверить обещания можно самому.</span>
              </li>
            </ul>
          </div>
          <div className="routes-visual">
            <span>Valanium</span>
            <img src="/media/valanium-laptop.png" alt="" />
          </div>
        </div>
      </section>

      <section className="hub-closing shell">
        <div className="closing">
          <div className="closing-copy">
            <div className="closing-mark"><img src="/logos/brand.svg" alt="" /></div>
            <div>
              <span>Без номера телефона</span>
              <h2>Начните с того,<br />что уже работает.</h2>
              <p>Мессенджер выпущен и открыт. Почта и VPN — на подходе.</p>
            </div>
          </div>
          <div className="closing-actions">
            <div className="actions actions-centered">
              <a className="download-button download-button-light" href="/messenger">
                <img className="platform-svg service-logo" src="/logos/messenger.svg" alt="" />
                <span><small>Открыть</small><b>Мессенджер</b></span>
              </a>
            </div>
            <small>Бесплатно · Открытый код · AGPL-3.0</small>
          </div>
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

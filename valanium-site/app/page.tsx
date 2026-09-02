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
  Главная — витрина: заголовок, обещание, три значка.

  Стеклянная панель здесь не украшение. Тёмная страница во всю ширину не имеет
  краёв, глазу не за что зацепиться; панель задаёт рамку, внутри которой живёт
  первый экран, и отделяет его от всего, что ниже.

  Кнопок «Войти» и «Зарегистрироваться» здесь нет намеренно. Учётной записи на
  сайте не существует: профиль заводится в приложении, ключи не покидают
  устройства, и сервер их не хранит — заводить вход в веб значило бы обещать
  то, чего нет и по замыслу быть не должно. Поэтому кнопки ведут туда, где
  действие действительно есть: к загрузке и к устройству сети.
*/
export default function Home() {
  return (
    <main id="top">
      <DynamicHeader page="hub" />

      <section className="stage shell">
        <div className="glass">
          <span className="glass-glow" aria-hidden="true" />

          <div className="glass-inner">
            <h1><span>Приватность</span> начинается здесь</h1>
            <p>Шифрование, свои узлы и открытый код</p>

            <div className="stage-actions">
              <a className="stage-button stage-button-primary" href="/messenger#download">Скачать</a>
              <a className="stage-button" href="/messenger#server">Как устроено</a>
            </div>

            <div className="stage-tiles">
              {SERVICES.map((service) => (
                <a
                  key={service.id}
                  className={`stage-tile${service.ready ? '' : ' is-soon'}`}
                  href={service.href}
                >
                  <span className="stage-tile-icon"><img src={service.logo} alt="" /></span>
                  <b>{service.short}</b>
                  <small>{service.ready ? service.badge : 'Скоро'}</small>
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/*
        Светлая полоса — та же, что на странице мессенджера. Тёмная страница без
        разрыва читается как одно полотно, и граница между разделами теряется.
        Смена фона обозначает её, не добавляя ни слова текста.
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
            <span>Valanium Messenger</span>
            <img className="routes-phone" src="/media/chat-phone.png" alt="Профиль в мессенджере Valanium" />
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

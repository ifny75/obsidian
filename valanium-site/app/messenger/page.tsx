/* eslint-disable @next/next/no-html-link-for-pages */
import type { Metadata } from 'next';
import { GithubIcon } from '../components/icons';
import { DynamicHeader } from '../components/dynamic-header';
import { RibbonShader } from '../components/ribbon-shader';
import { RouteSelector } from '../components/route-selector';
import { SupportDialog } from '../components/support-dialog';
import { RELEASES } from '../releases';

/*
  SEO мессенджера живёт здесь, а не в общем layout.

  Раньше вся разметка описывала мессенджер, потому что он и был единственной
  страницей. Теперь под корнем — выбор сервисов, и описывать им мессенджер
  значило бы обещать поисковику не то, что человек увидит.
*/
const TITLE = 'Valanium Messenger — приватный мессенджер с E2EE-шифрованием';
const DESCRIPTION =
  'Valanium Messenger — приватный мессенджер для Windows и Android. Сквозное шифрование по MLS (RFC 9420), переписка шифруется на устройстве, вход без номера телефона, открытый код под AGPL-3.0.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: 'https://valanium.com/messenger' },
  keywords: [
    'valanium messenger', 'valanium chat', 'valanium мессенджер',
    'приватный мессенджер', 'мессенджер с шифрованием', 'e2ee мессенджер',
    'мессенджер без номера телефона', 'защищённая переписка', 'MLS RFC 9420',
  ],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: 'https://valanium.com/messenger',
    siteName: 'Valanium',
    locale: 'ru_RU',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: TITLE }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og.png'] },
};

/** Что это за программа, на чём работает и почём. Без неё поисковик гадает. */
const APP_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Valanium Messenger',
  applicationCategory: 'CommunicationApplication',
  applicationSubCategory: 'Messenger',
  operatingSystem: 'Windows 10, Windows 11, Android 8.0+',
  description: DESCRIPTION,
  url: 'https://valanium.com/messenger',
  inLanguage: 'ru',
  license: 'https://www.gnu.org/licenses/agpl-3.0.html',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'RUB' },
  featureList: [
    'Сквозное шифрование по MLS (RFC 9420)',
    'Вход без номера телефона',
    'Публичные и закрытые каналы',
    'Голосовые сообщения и фотографии',
    'Открытый исходный код под AGPL-3.0',
    'Свой сервер-релей',
  ],
};

function DownloadButtons({ centered = false }: { centered?: boolean }) {
  return (
    <div className={`actions${centered ? ' actions-centered' : ''}`}>
      <a className="download-button download-button-light" href={RELEASES.windows.file}>
        <img className="platform-svg" src="/icons/microsoft-windows.svg" alt="" />
        <span><small>Скачать для</small><b>Windows {RELEASES.windows.version}</b></span>
      </a>
      <a className="download-button" href={RELEASES.android.file}>
        <img className="platform-svg" src="/icons/android.svg" alt="" />
        <span><small>Скачать для</small><b>Android {RELEASES.android.version}</b></span>
      </a>
    </div>
  );
}

function RibbonCard({ title, text, seed }: { title: string; text: string; seed: number }) {
  return (
    <article className="ribbon-card">
      <span className="ribbon"><RibbonShader seed={seed} /></span>
      <div><h3>{title}</h3><p>{text}</p></div>
    </article>
  );
}

export default function Home() {
  return (
    <main id="top">
      <script
        type="application/ld+json"
        // Разметка статична и собрана здесь же — постороннего ввода в ней нет.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(APP_SCHEMA) }}
      />
      <DynamicHeader page="messenger" />

      <section className="hero shell">
        <div className="hero-copy">
          <h1>Переписка остаётся <span>на ваших устройствах</span></h1>
          <p>Ваша приватность начинается здесь</p>
          <DownloadButtons />
          <small>MLS (RFC 9420) · AGPL-3.0 · сервер можно поднять свой</small>
        </div>
        <div className="phone-stage" aria-hidden="true">
          <span className="phone-glow" />
          <img src="/media/mackbook2.png" alt="" />
        </div>
      </section>

      <section className="facts shell" aria-label="Главные преимущества">
        <RibbonCard title="MLS · RFC 9420" text="Групповой стандарт шифрования, а не самодельный протокол" seed={0.2} />
        <RibbonCard title="Без телефона" text="Вход по коду чата или юзернейму" seed={1.7} />
        <RibbonCard title="Свои узлы" text="Собственные серверы и прозрачная инфраструктура" seed={3.4} />
      </section>

      <section className="server-section shell" id="server">
        <h2>Что он знает — и чего не знает</h2>
        <div className="server-grid">
          <article className="server-card">
            <span className="server-kicker">Только для доставки</span>
            <h3><span className="server-icon"><img src="/icons/eye.svg" alt="" /></span> Сервер видит</h3>
            <ul>
              <li>Запечатанный конверт и его размер</li>
              <li>Адрес устройства-получателя в момент доставки и время</li>
              <li>Отпечатки занятых юзернеймов и коды для начала чата</li>
              <li>Когда устройство последний раз выходило на связь</li>
              <li>Посты публичных каналов целиком — задуманы открытыми</li>
            </ul>
          </article>
          <article className="server-card server-card-blind">
            <span className="server-kicker">Защищено E2EE</span>
            <h3><span className="server-icon"><img src="/icons/eye-crossed.svg" alt="" /></span> Сервер не видит</h3>
            <ul>
              <li>Текст, фотографии и голосовые — ключи не покидают устройств</li>
              <li>Кто с кем переписывается: такой связки в его базе нет</li>
              <li>Сами юзернеймы — в каталоге лежат только их отпечатки</li>
              <li>Список ваших диалогов: он есть лишь на вашем устройстве</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="feature-section shell" id="features">
        <h2>Мессенджер, а не демонстрация<br />криптографии</h2>
        <div className="feature-grid">
          <article className="feature-card feature-card-code">
            <div className="feature-title">
              <span className="feature-number">01</span>
              <span className="feature-icon"><GithubIcon /></span>
              <div><small>Проверяемо</small><h3>Открытый код</h3></div>
            </div>
            <p className="feature-copy"><strong>Никакой веры на слово.</strong><span>Клиенты, ядро и сервер опубликованы на GitHub под AGPL-3.0. Разверните собственный relay и контролируйте маршрут сами.</span></p>
            <div className="feature-tags"><span>AGPL-3.0</span><span>Self-hosted relay</span></div>
          </article>
          <article className="feature-card feature-card-privacy">
            <div className="feature-title">
              <span className="feature-number">02</span>
              <span className="feature-icon"><img src="/icons/lock-hashtag.svg" alt="" /></span>
              <div><small>Под вашим контролем</small><h3>Приватность</h3></div>
            </div>
            <p className="feature-copy"><strong>Ваши границы — ваши правила.</strong><span>Вы решаете, кто может писать, отправлять медиа и голосовые, а также кому доступен ваш сетевой статус.</span></p>
            <div className="feature-tags"><span>E2EE</span><span>Гибкие разрешения</span></div>
          </article>
          <article className="feature-card feature-card-speed">
            <div className="feature-title">
              <span className="feature-number">03</span>
              <span className="feature-icon"><img src="/icons/tachometer-fast.svg" alt="" /></span>
              <div><small>Без лишнего ожидания</small><h3>Скорость</h3></div>
            </div>
            <p className="feature-copy"><strong>Сообщения приходят вовремя.</strong><span>Управляемая сеть узлов сохраняет стабильную доставку и быстрый отклик даже при переключении маршрута.</span></p>
            <div className="feature-tags"><span>Low latency</span><span>Stable routing</span></div>
          </article>
        </div>
      </section>

      <section className="routes" id="routes">
        <div className="routes-inner shell">
          <div className="routes-copy">
            <div className="routes-heading">
              <span>Маршрутизация</span>
              <h2>Вы выбираете,<br />как подключаться</h2>
              <p>Три режима прямо в приложении. Выбор сохраняется на устройстве и меняется в любой момент.</p>
            </div>
            <RouteSelector />
          </div>
          <div className="routes-visual">
            <span>Valanium routing</span>
            <img src="/media/mackbook.png" alt="Ноутбук с настройками маршрутизации Valanium" />
          </div>
        </div>
      </section>

      <section className="download-section shell" id="download">
        <h2>Public Beta</h2>
        <div className="release-grid">
          <article className="release-card release-card-windows">
            <div className="release-card-top"><span>Desktop</span><em>Portable</em></div>
            <div className="release-title"><span className="release-icon"><img src="/icons/microsoft-windows.svg" alt="" /></span><div><h3>Windows</h3><small>Версия {RELEASES.windows.version} · {RELEASES.windows.size} · портативный exe</small></div></div>
            <ul><li>Windows 10 и новее, 64-бит</li><li>Установка не требуется — запускается из файла</li><li>База лежит в защищённом хранилище Windows</li></ul>
            <a className="download-button release-action" href={RELEASES.windows.file}><img className="platform-svg" src="/icons/microsoft-windows.svg" alt="" /><span><small>Скачать для</small><b>Windows {RELEASES.windows.version}</b></span><i aria-hidden="true">↓</i></a>
          </article>
          <article className="release-card release-card-android">
            <div className="release-card-top"><span>Mobile</span><em>APK · arm64</em></div>
            <div className="release-title"><span className="release-icon"><img src="/icons/android.svg" alt="" /></span><div><h3>Android</h3><small>Версия {RELEASES.android.version} · {RELEASES.android.size} · arm64</small></div></div>
            <ul><li>Android 8.0 и новее, 64-бит</li><li>Установка из APK — Android может запросить разрешение</li><li>То же ядро, что и в версии для Windows</li></ul>
            <a className="download-button release-action" href={RELEASES.android.file}><img className="platform-svg" src="/icons/android.svg" alt="" /><span><small>Скачать для</small><b>Android {RELEASES.android.version}</b></span><i aria-hidden="true">↓</i></a>
          </article>
        </div>
        <section className="closing">
          <div className="closing-copy">
            <div className="closing-mark"><img src="/valanium.svg" alt="" /></div>
            <div><span>Без номера телефона</span><h2>Один профиль.<br />Ваши разговоры.</h2><p>Создание профиля занимает около минуты.</p></div>
          </div>
          <div className="closing-actions"><DownloadButtons centered /><small>Бесплатно · Открытый код · AGPL-3.0</small></div>
        </section>
      </section>

      <footer className="site-footer shell">
        <span>© 2026 Valanium · Public Beta · AGPL-3.0</span>
        <nav aria-label="Служебные ссылки"><a href="/status">Статус сети</a><a href="/privacy">Политика конфиденциальности</a><a href="/terms">Соглашение</a><SupportDialog /><a href="https://github.com/ifny75/valanium" target="_blank" rel="noreferrer noopener">GitHub</a></nav>
      </footer>
    </main>
  );
}

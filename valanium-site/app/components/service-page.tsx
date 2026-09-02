/* eslint-disable @next/next/no-html-link-for-pages */
import { DynamicHeader, type HeaderPage } from './dynamic-header';
import { SupportDialog } from './support-dialog';
import type { Service } from '../services';

/**
 * Общий каркас страницы сервиса.
 *
 * Собран из тех же блоков, что страница мессенджера, и это главное в нём:
 * почта и VPN должны читаться как тот же продукт, а не как соседний сайт.
 * Разъехаться им негде — классы общие, правка стиля меняет все три разом.
 *
 * Содержимое прототипов ещё поменяется, раскладка — нет.
 */
export type ServiceSection = { title: string; body: string };

export function ServicePage({
  service,
  page,
  lead,
  sections,
  note,
}: {
  service: Service;
  page: HeaderPage;
  lead: string;
  sections: ServiceSection[];
  note: string;
}) {
  return (
    <main id="top">
      <DynamicHeader page={page} />

      <section className="hero shell">
        <div className="hero-copy">
          <h1>{service.tagline}</h1>
          <p>{lead}</p>

          {/*
            Кнопки «скачать» здесь нет намеренно: скачивать пока нечего.
            Кнопка, ведущая в никуда, обесценивает и остальные.
          */}
          <div className="service-note">
            <span className="service-dot" aria-hidden="true" />
            {note}
          </div>
          <small>Открытый код · AGPL-3.0 · собственные узлы</small>
        </div>

        <div className="phone-stage service-stage" aria-hidden="true">
          <span className="phone-glow" />
          <img className="service-logo-big" src={service.logo} alt="" />
        </div>
      </section>

      <section className="feature-section shell" id="about">
        <h2>{service.name}</h2>
        <div className="feature-grid">
          {sections.map((section, index) => (
            <article key={section.title} className={`feature-card feature-card-${service.id}`}>
              <div className="feature-title">
                <span className="feature-icon"><img className="service-logo" src={service.logo} alt="" /></span>
                <div><small>{service.points[index] ?? service.badge}</small><h3>{section.title}</h3></div>
                <span className="feature-number">{String(index + 1).padStart(2, '0')}</span>
              </div>
              <p className="feature-copy"><span>{section.body}</span></p>
            </article>
          ))}
        </div>

        <section className="closing">
          <div className="closing-copy">
            <div className="closing-mark"><img src={service.logo} alt="" /></div>
            <div>
              <span>{service.badge}</span>
              <h2>Пока в разработке.</h2>
              <p>Работающий сегодня — мессенджер: клиенты, публичный статус узлов и открытый код.</p>
            </div>
          </div>
          <div className="closing-actions">
            <div className="actions actions-centered">
              <a className="download-button download-button-light" href="/messenger">
                <span><small>Открыть</small><b>Мессенджер</b></span>
              </a>
              <a className="download-button" href="/status">
                <span><small>Посмотреть</small><b>Статус сети</b></span>
              </a>
            </div>
          </div>
        </section>
      </section>

      <footer className="site-footer shell">
        <span>© 2026 Valanium · AGPL-3.0</span>
        <nav aria-label="Служебные ссылки">
          <a href="/">Сервисы</a>
          <a href="/status">Статус сети</a>
          <a href="/privacy">Политика конфиденциальности</a>
          <a href="/terms">Соглашение</a>
          <SupportDialog />
        </nav>
      </footer>
    </main>
  );
}

/* eslint-disable @next/next/no-html-link-for-pages */
import { DynamicHeader, type HeaderPage } from './dynamic-header';
import { SupportDialog } from './support-dialog';
import type { Service } from '../services';

/**
 * Общий каркас страницы сервиса.
 *
 * Почта и VPN — прототипы: содержимое ещё поменяется, а вот раскладка,
 * отступы и типографика меняться не должны. Один каркас на оба и означает,
 * что расходиться им негде; когда сервисы дозреют, наполнение заменят внутри,
 * а не рядом.
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
    <main className={`service-page service-page-${service.id}`} id="top">
      <DynamicHeader page={page} />

      <section className="service-hero shell">
        <div className="service-hero-copy">
          <span className="service-eyebrow">
            <i aria-hidden="true">{service.letter}</i>
            {service.badge}
          </span>
          <h1>{service.tagline}</h1>
          <p>{lead}</p>

          {/*
            Кнопки «скачать» здесь нет намеренно: скачивать пока нечего.
            Кнопка, которая ведёт в никуда, обесценивает и остальные.
          */}
          <div className="service-status-note">
            <span className="service-dot" aria-hidden="true" />
            {note}
          </div>
        </div>

        <div className="service-hero-mark" aria-hidden="true">
          {/* Место под логотип: его ещё не нарисовали. */}
          <span>{service.letter}</span>
        </div>
      </section>

      <section className="service-points shell" aria-label="Коротко о сервисе">
        {service.points.map((point, index) => (
          <article key={point}>
            <span className="service-point-number">{String(index + 1).padStart(2, '0')}</span>
            <h2>{point}</h2>
          </article>
        ))}
      </section>

      <section className="service-sections shell">
        {sections.map((section) => (
          <article key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.body}</p>
          </article>
        ))}
      </section>

      <section className="service-cta shell">
        <div>
          <h2>Пока в разработке</h2>
          <p>
            Сервис ещё не запущен. Работающий сегодня — мессенджер: у него есть
            клиенты, публичный статус узлов и открытый код.
          </p>
        </div>
        <div className="service-cta-actions">
          <a className="download-button download-button-light" href="/messenger">
            <span><small>Открыть</small><b>Valanium Messenger</b></span>
          </a>
          <a className="download-button" href="/status">
            <span><small>Посмотреть</small><b>Статус сети</b></span>
          </a>
        </div>
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

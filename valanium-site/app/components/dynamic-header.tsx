'use client';

import { useEffect, useState } from 'react';
import { GithubIcon } from './icons';
import { SupportDialog } from './support-dialog';
import { SERVICES } from '../services';

/**
 * Какая это страница — от этого зависит только меню.
 *
 * `messenger` живёт на якорях внутри одной длинной страницы, остальные —
 * отдельные разделы. Раньше вариантов было два и хватало флага; теперь
 * сервисов несколько, и меню собирается из таблицы, чтобы добавление
 * следующего не превращалось в правку разметки в трёх местах.
 */
export type HeaderPage = 'hub' | 'messenger' | 'mail' | 'vpn' | 'status';

type Link = { href: string; label: string };

const SERVICE_LINKS: Link[] = SERVICES.map((service) => ({
  href: service.href,
  label: service.short,
}));

/** Якоря есть только на странице мессенджера: снаружи они ведут на неё же. */
const MESSENGER_LINKS: Link[] = [
  { href: '#features', label: 'Возможности' },
  { href: '#routes', label: 'Маршруты' },
  { href: '#download', label: 'Скачать' },
];

function linksFor(page: HeaderPage): Link[] {
  return page === 'messenger' ? MESSENGER_LINKS : SERVICE_LINKS;
}

export function DynamicHeader({ page = 'hub' }: { page?: HeaderPage }) {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    let frame = 0;

    const update = () => {
      setCompact(window.scrollY > 42);
      frame = 0;
    };

    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // На странице мессенджера логотип возвращает к началу, на остальных — к
  // выбору сервисов: это разные намерения, и вести их в одно место нельзя.
  const brandHref = page === 'messenger' ? '#top' : '/';
  const links = linksFor(page);

  return (
    <header className={`site-header${compact ? ' is-compact' : ''}`}>
      <nav
        className="nav"
        aria-label="Основная навигация"
        style={{
          backdropFilter: compact ? 'blur(28px) saturate(165%)' : 'blur(14px) saturate(135%)',
          WebkitBackdropFilter: compact ? 'blur(28px) saturate(165%)' : 'blur(14px) saturate(135%)',
        }}
      >
        <a className="brand" href={brandHref} aria-label="Valanium">
          <img src="/logos/brand.svg" alt="" />
          <b>Valanium</b>
          {page === 'messenger' ? <span>Public Beta</span> : null}
        </a>

        <div className="nav-menu">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={link.href === `/${page}` ? 'is-active' : undefined}
            >
              {link.label}
            </a>
          ))}
          <a className={`nav-status-link${page === 'status' ? ' is-active' : ''}`} href="/status"><i />Статус</a>
        </div>

        <div className="nav-actions">
          <a className="status-mobile-link" href="/status" aria-label="Статус сети"><i /></a>
          <SupportDialog variant="header" />
          <a className="github-link" href="https://github.com/ifny75/valanium" target="_blank" rel="noreferrer noopener">
            <GithubIcon /><b>GitHub</b>
          </a>
        </div>
      </nav>
    </header>
  );
}

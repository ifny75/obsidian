'use client';

import { useEffect } from 'react';

const SELECTORS = [
  '.hero-copy > *', '.phone-stage', '.facts > *',
  '.server-section > h2', '.server-card', '.feature-section > h2', '.feature-card',
  '.routes-heading > *', '.route-selector', '.routes-visual',
  '.download-section > h2', '.release-card', '.closing',
  '.legal-hero > *', '.legal-content section', '.status-hero > *', '.status-summary', '.status-board-head', '.status-service',
].join(',');

export function RevealObserver() {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      elements.forEach((element) => element.classList.add('reveal-visible'));
      return;
    }

    elements.forEach((element) => {
      element.classList.add('reveal-item');
      const siblings = Array.from(element.parentElement?.children ?? []);
      element.style.setProperty('--reveal-delay', `${Math.min(siblings.indexOf(element), 4) * 70}ms`);
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        (entry.target as HTMLElement).classList.add('reveal-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return null;
}

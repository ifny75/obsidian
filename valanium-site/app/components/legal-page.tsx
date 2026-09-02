/* eslint-disable @next/next/no-html-link-for-pages */

export type LegalSection = { title: string; paragraphs?: string[]; items?: string[] };

export function LegalPage({ eyebrow, title, intro, sections }: { eyebrow: string; title: string; intro: string; sections: LegalSection[] }) {
  return (
    <main className="legal-shell">
      <header className="legal-nav">
        <a className="brand" href="/"><img src="/valanium.svg" alt="" /><b>Valanium</b></a>
        <a href="/">На главную</a>
      </header>
      <article className="legal-document">
        <div className="legal-hero"><span>{eyebrow}</span><h1>{title}</h1><p>{intro}</p><small>Редакция от 30 августа 2026 года</small></div>
        <div className="legal-content">
          {sections.map((section, index) => (
            <section key={section.title}>
              <h2><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</h2>
              {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {section.items && <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>}
            </section>
          ))}
        </div>
      </article>
      <footer className="legal-footer"><span>© 2026 Valanium</span><a href="/status">Статус сети</a><a href="/privacy">Конфиденциальность</a><a href="/terms">Соглашение</a></footer>
    </main>
  );
}

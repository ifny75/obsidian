import type { Metadata, Viewport } from 'next';
import { Inter, Unbounded } from 'next/font/google';
import './globals.css';
import { RevealObserver } from './components/reveal-observer';

/**
 * Гарнитуры те же, что в приложении: Unbounded на заголовках, Inter в тексте.
 * Сайт и клиент должны выглядеть одним продуктом, а не двумя разными.
 */
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
});

const unbounded = Unbounded({
  variable: '--font-unbounded',
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '600'],
  display: 'swap',
});

/*
  Общие метаданные всех страниц.

  Здесь только то, что верно для сайта целиком. Описание конкретного сервиса
  живёт на его странице: под корнем теперь выбор из трёх, и описывать им
  мессенджер значило бы обещать поисковику не то, что человек увидит.
*/
const TITLE = 'Valanium — приватные сервисы';

/** Карточка для превью ссылок: 1200×630, как просят все, кто их рисует. */
export const OG_IMAGE = {
  url: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Valanium — приватный мессенджер с E2EE-шифрованием',
};
const DESCRIPTION =
  'Valanium — приватные сервисы с общей инфраструктурой: мессенджер со сквозным шифрованием, почта и VPN. Открытый код, собственные узлы.';

export const metadata: Metadata = {
  title: {
    default: TITLE,
    // Страницы канала подставляют своё имя, а хвост остаётся общим.
    template: '%s — Valanium',
  },
  description: DESCRIPTION,
  metadataBase: new URL('https://valanium.com'),
  applicationName: 'Valanium',
  keywords: ['valanium', 'valanium messenger', 'valanium mail', 'valanium vpn', 'приватные сервисы'],
  authors: [{ name: 'Valanium' }],
  category: 'communication',
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: 'https://valanium.com/',
    siteName: 'Valanium',
    locale: 'ru_RU',
    type: 'website',
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    // summary_large_image без картинки — это обещание пустой карточки.
    images: [OG_IMAGE.url],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-snippet': -1, 'max-image-preview': 'large' },
  },
};

/*
  Разметка для поисковиков: что это за продукт, на каких платформах и почём.
  Без неё «мессенджер» приходится угадывать из текста страницы.
*/
const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      name: 'Valanium',
      url: 'https://valanium.com/',
      inLanguage: 'ru',
      publisher: { '@id': 'https://valanium.com/#org' },
    },
    {
      // Чтобы поисковик связал сайт, репозиторий и название в одну сущность.
      '@type': 'Organization',
      '@id': 'https://valanium.com/#org',
      name: 'Valanium',
      url: 'https://valanium.com/',
      logo: 'https://valanium.com/og.png',
      sameAs: ['https://github.com/ifny75/valanium'],
    },
  ],
};

/** Цвет строки состояния: в metadata это поле устарело, его место здесь. */
export const viewport: Viewport = {
  themeColor: '#070707',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <head>
        <script
          type="application/ld+json"
          // Разметка статична и собрана здесь же — постороннего ввода в ней нет.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
      </head>
      <body className={`${inter.variable} ${unbounded.variable}`}><RevealObserver />{children}</body>
    </html>
  );
}

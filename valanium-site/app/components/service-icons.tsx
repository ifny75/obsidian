/**
 * Значки панелей на страницах сервисов.
 *
 * Раньше все три панели несли логотип самого сервиса — то есть не говорили
 * ничего: одинаковая картинка трижды не помогает отличить один раздел от
 * другого. Здесь у каждой панели свой знак по её теме.
 *
 * Штрих, а не заливка: панели стоят на тёмном, и тонкая линия читается на
 * нём ровнее, чем силуэт. Цвет наследуется от панели — значок не должен
 * спорить с её акцентом.
 */
const COMMON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** Глаз с чертой: за содержимым никто не смотрит. */
function EyeOff() {
  return (
    <svg {...COMMON}>
      <path d="M2.5 12C5.2 7.9 8.5 5.9 12 5.9s6.8 2 9.5 6.1c-2.7 4.1-6 6.1-9.5 6.1S5.2 16.1 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

/** Замок: шифрование хранимого. */
function Lock() {
  return (
    <svg {...COMMON}>
      <rect x="4.2" y="10.2" width="15.6" height="9.6" rx="2.2" />
      <path d="M8.2 10.2V7.4a3.8 3.8 0 0 1 7.6 0v2.8" />
      <path d="M12 14v2" />
    </svg>
  );
}

/** Шар с меридианом: собственный домен, а не адрес внутри чужого. */
function Globe() {
  return (
    <svg {...COMMON}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.4 12h17.2" />
      <path d="M12 3.4c2.4 2.5 3.7 5.4 3.7 8.6S14.4 18.1 12 20.6c-2.4-2.5-3.7-5.4-3.7-8.6S9.6 5.9 12 3.4Z" />
    </svg>
  );
}

/** Молния: протокол маленький и быстрый. */
function Bolt() {
  return (
    <svg {...COMMON}>
      <path d="M13.4 2.6 5.2 13.4h5.6L10.6 21.4l8.2-10.8h-5.6l.2-8Z" />
    </svg>
  );
}

/** Лист с чертой: записей о подключениях не ведётся. */
function NoLog() {
  return (
    <svg {...COMMON}>
      <path d="M6.4 3.4h7.2l4 4v13.2H6.4z" />
      <path d="M13.4 3.4v4.2h4.2" />
      <path d="M9.4 12.6h5.2M9.4 16.2h3.4" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

/** Треугольник с восклицанием: у сервиса есть границы, и о них сказано. */
function Limit() {
  return (
    <svg {...COMMON}>
      <path d="M12 3.8 2.9 19.8h18.2L12 3.8Z" />
      <path d="M12 10.2v3.8" />
      <circle cx="12" cy="16.8" r=".8" fill="currentColor" stroke="none" />
    </svg>
  );
}

const ICONS = {
  'eye-off': EyeOff,
  lock: Lock,
  globe: Globe,
  bolt: Bolt,
  'no-log': NoLog,
  limit: Limit,
} as const;

export type ServiceIconName = keyof typeof ICONS;

export function ServiceIcon({ name }: { name: ServiceIconName }) {
  const Glyph = ICONS[name];
  return <Glyph />;
}

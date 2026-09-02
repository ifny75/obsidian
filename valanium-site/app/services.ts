/**
 * Что за сервисы и в каком они состоянии.
 *
 * Один источник на выбор сервисов, их страницы и меню: раньше номера версий
 * стояли по месту и разъехались, и с сервисами повторять эту ошибку незачем.
 *
 * `ready` честно отделяет работающее от задуманного. Мессенджер выпущен,
 * почта и VPN пока прототипы — и подписаны как прототипы. Обещать в
 * интерфейсе то, чего нет, дороже, чем промолчать: человек попробует и не
 * найдёт.
 */
export type Service = {
  id: 'messenger' | 'mail' | 'vpn';
  name: string;
  /** Короткое имя для карточек и меню, без повторения «Valanium». */
  short: string;
  logo: string;
  badge: string;
  tagline: string;
  about: string;
  points: string[];
  href: string;
  ready: boolean;
};

export const SERVICES: Service[] = [
  {
    id: 'messenger',
    name: 'Valanium Messenger',
    short: 'Мессенджер',
    logo: '/logos/messenger.svg',
    badge: 'Public Beta',
    tagline: 'Переписка остаётся на ваших устройствах',
    about:
      'Сквозное шифрование по MLS (RFC 9420), вход без номера телефона, ' +
      'клиенты для Windows и Android.',
    points: ['E2EE по MLS', 'Без номера телефона', 'Windows и Android'],
    href: '/messenger',
    ready: true,
  },
  {
    id: 'mail',
    name: 'Valanium Mail',
    short: 'Почта',
    logo: '/logos/mail.svg',
    badge: 'В разработке',
    tagline: 'Почта, которая не читает почту',
    about:
      'Почтовый ящик на инфраструктуре Valanium: шифрование хранимого, ' +
      'свой домен и отсутствие рекламного профилирования.',
    points: ['Шифрование на диске', 'Свой домен', 'Без профилирования'],
    href: '/mail',
    ready: false,
  },
  {
    id: 'vpn',
    name: 'Valanium VPN',
    short: 'VPN',
    logo: '/logos/vpn.svg',
    badge: 'В разработке',
    tagline: 'Выход в сеть через свои узлы',
    about:
      'Те же узлы, что держат relay мессенджера: WireGuard, отсутствие ' +
      'журналов подключений и прозрачный список серверов.',
    points: ['WireGuard', 'Без журналов', 'Свои узлы'],
    href: '/vpn',
    ready: false,
  },
];

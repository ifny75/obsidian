import type { Metadata } from 'next';
import { ServicePage } from '../components/service-page';
import { SERVICES } from '../services';

const service = SERVICES.find((item) => item.id === 'vpn')!;

const TITLE = 'Valanium VPN — выход в сеть через свои узлы';
const DESCRIPTION =
  'Valanium VPN — WireGuard на собственных узлах Valanium: без журналов подключений, с публичным списком серверов и открытым кодом. В разработке.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: 'https://valanium.com/vpn' },
  openGraph: {
    title: TITLE, description: DESCRIPTION, url: 'https://valanium.com/vpn',
    siteName: 'Valanium', locale: 'ru_RU', type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: TITLE }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og.png'] },
};

export default function VpnPage() {
  return (
    <ServicePage
      service={service}
      page="vpn"
      shot="/media/vpn-phone.png"
      lead="Те же узлы, что держат relay мессенджера, и тот же принцип: журналов подключений нет, а список серверов открыт."
      note="Прототип страницы. Подключение ещё не открыто."
      sections={[
        {
          kicker: 'Протокол',
          icon: 'bolt',
          title: 'Почему WireGuard',
          body: 'Он маленький, его код можно прочитать целиком за вечер, и он быстрый на слабом железе. Большой протокол с десятилетней историей и десятками режимов даёт больше поверхности, чем пользы.',
        },
        {
          kicker: 'Журналы',
          icon: 'no-log',
          title: 'Что значит «без журналов»',
          body: 'Не хранится, кто и когда подключался. Это проверяемое утверждение, а не обещание: узлы те же, что в relay-сети мессенджера, а их конфигурация лежит в открытом репозитории.',
        },
        {
          kicker: 'Границы',
          icon: 'limit',
          title: 'Чего VPN не делает',
          body: 'VPN меняет того, кто видит ваш трафик, но не убирает наблюдателя совсем: им становимся мы. Полной анонимности он не даёт — для неё в мессенджере есть режим Onion. Обещать большее было бы нечестно.',
        },
      ]}
    />
  );
}

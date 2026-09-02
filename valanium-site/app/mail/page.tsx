import type { Metadata } from 'next';
import { ServicePage } from '../components/service-page';
import { SERVICES } from '../services';

const service = SERVICES.find((item) => item.id === 'mail')!;

const TITLE = 'Valanium Mail — почта без профилирования';
const DESCRIPTION =
  'Valanium Mail — почтовый сервис на инфраструктуре Valanium: шифрование хранимого, свой домен, отсутствие рекламного профилирования. В разработке.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: 'https://valanium.com/mail' },
  openGraph: {
    title: TITLE, description: DESCRIPTION, url: 'https://valanium.com/mail',
    siteName: 'Valanium', locale: 'ru_RU', type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: TITLE }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og.png'] },
};

export default function MailPage() {
  return (
    <ServicePage
      service={service}
      page="mail"
      lead="Почтовый ящик на той же инфраструктуре, что и мессенджер: свои узлы, минимум хранимого и никакого чтения писем ради рекламы."
      note="Прототип страницы. Регистрация ещё не открыта."
      sections={[
        {
          kicker: 'Почему',
          icon: 'eye-off',
          title: 'Зачем ещё одна почта',
          body: 'Бесплатная почта окупается чтением писем: из них строят рекламный профиль. Здесь этого нет и не будет — сервис не зарабатывает на содержимом ящика, а значит, и заглядывать в него незачем.',
        },
        {
          kicker: 'Шифрование',
          icon: 'lock',
          title: 'Что шифруется',
          body: 'Письма шифруются на диске. Полное сквозное шифрование почта дать не может: SMTP устроен так, что письмо приходит открытым от чужого сервера. Обещать здесь E2EE значило бы врать — для переписки, которую нельзя показывать никому, есть мессенджер.',
        },
        {
          kicker: 'Домен',
          icon: 'globe',
          title: 'Свой домен',
          body: 'Ящик можно завести на своём домене, а не только на valanium.com. Это же означает, что переезд не привязан к нам: адрес остаётся вашим.',
        },
      ]}
    />
  );
}

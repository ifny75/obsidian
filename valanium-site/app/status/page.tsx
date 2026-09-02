import type { Metadata } from 'next';
import { DynamicHeader } from '../components/dynamic-header';
import { StatusDashboard } from '../components/status-dashboard';

export const metadata: Metadata = { title: { absolute: 'Статус сети — Valanium' }, description: 'Текущее состояние публичных сервисов и узлов сети Valanium.' };

export default function StatusPage() {
  return (
    <main className="status-page">
      <DynamicHeader page="status" />
      <div className="status-shell">
        <section className="status-hero"><span>Live infrastructure</span><h1>Сеть Valanium.<br />Всё под контролем.</h1><p>Публичный мониторинг сайта, ядра и relay-узлов. Только состояние и скорость ответа — без IP-адресов и внутренней топологии.</p></section>
        <StatusDashboard />
      </div>
      <footer className="status-footer"><span>© 2026 Valanium</span><a href="/privacy">Конфиденциальность</a><a href="/terms">Соглашение</a></footer>
    </main>
  );
}

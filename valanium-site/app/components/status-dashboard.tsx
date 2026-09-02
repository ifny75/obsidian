'use client';

import { useCallback, useEffect, useState } from 'react';

type StatusData = {
  overall: 'operational' | 'degraded' | 'outage';
  checkedAt: string;
  nodes: Array<{ id: string; name: string; role: string; status: 'operational' | 'outage'; latency: number }>;
};

const LABELS = { operational: 'Все системы работают', degraded: 'Частичное ухудшение', outage: 'Есть недоступные системы' } as const;

export function StatusDashboard() {
  const [data, setData] = useState<StatusData | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/status', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Status unavailable');
        return response.json() as Promise<StatusData>;
      })
      .then((next) => { setData(next); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const overall = failed ? 'outage' : data?.overall ?? 'operational';

  return (
    <>
      <section className={`status-summary status-${overall}`}>
        <span className="status-pulse" />
        <div><small>Состояние сети сейчас</small><h2>{failed ? 'Не удалось обновить статус' : data ? LABELS[data.overall] : 'Проверяем системы…'}</h2></div>
        <button type="button" onClick={refresh}><span>↻</span> Обновить</button>
      </section>
      <section className="status-board" id="network" aria-label="Узлы сети Valanium">
        <header className="status-board-head"><div><span>Valanium network</span><h2>Сервисы и узлы</h2></div><small><i /> Автообновление · 30 сек.</small></header>
        {(data?.nodes ?? [
          { id: 'web', name: 'Public Website', role: 'Сайт и загрузки', status: 'operational' as const, latency: 0 },
          { id: 'core', name: 'Messaging Core', role: 'Доставка сообщений', status: 'operational' as const, latency: 0 },
          { id: 'alpha', name: 'Relay Alpha', role: 'Relay · Multihop · Tor', status: 'operational' as const, latency: 0 },
          { id: 'beta', name: 'Relay Beta', role: 'Relay · Multihop · Tor', status: 'operational' as const, latency: 0 },
        ]).map((node) => (
          <article className={`status-service status-service-${node.status}${data ? '' : ' status-loading'}`} key={node.id}>
            <div className="status-service-line">
              <span className="status-service-check">{node.status === 'operational' ? '✓' : '!'}</span>
              <div className="status-service-name"><h3>{node.name}</h3><p>{node.role}</p></div>
              <div className="status-service-response"><small>Ответ</small><b>{data ? node.latency ? `${node.latency} ms` : '< 1 ms' : '—'}</b></div>
              <strong>{node.status === 'operational' ? 'Онлайн' : 'Недоступен'}</strong>
            </div>
            <div className="status-bars" aria-label={`Live-сигнал: ${node.status === 'operational' ? 'сервис работает' : 'сервис недоступен'}`}>
              {Array.from({ length: 56 }, (_, index) => <i key={index} style={{ animationDelay: `${-(index % 14) * 90}ms`, opacity: 0.54 + (index % 5) * 0.1 }} />)}
            </div>
          </article>
        ))}
      </section>
      <div className="status-note"><span>i</span><p>Полосы показывают текущий live-сигнал, а не исторический uptime. Публичная страница не раскрывает IP-адреса, порты и внутреннюю топологию.</p><time>{data ? `Обновлено ${new Date(data.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}</time></div>
    </>
  );
}

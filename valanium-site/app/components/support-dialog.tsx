'use client';

import { useRef, useState } from 'react';

const WALLETS = [
  { name: 'Monero', network: 'XMR', icon: '/icons/monero.svg', address: '85hqMyHK7Ca2R5FyNU7B4xJrLqF1e8su7cjZ8sF4zRZjMvSFmnaviMYY4JrBHwvVjVPTGSCAtz6hDMCCCpm8XWL4LcvUQDw' },
  { name: 'TON / USDT', network: 'TON', icon: '/icons/toncoin.svg', address: 'UQAbCn83LAZJaTpTD0Pb-D95YU5vbHg-7g6HLbiru_8qCovp' },
  { name: 'USDT', network: 'TRC20', icon: '/icons/tetheo.svg', address: 'TRVp9AYLL1PkcCJWJWfEgpr1aSZtchjuZw' },
] as const;

type FundingData = { goal: number; total: number; ton: number; tron: number; month: string; updatedAt: string; sources: { ton: boolean; tron: boolean } };

export function SupportDialog({ variant = 'footer' }: { variant?: 'footer' | 'header' }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [funding, setFunding] = useState<FundingData | null>(null);
  const [fundingError, setFundingError] = useState(false);

  const open = () => {
    dialogRef.current?.showModal();
    if (funding || fundingError) return;
    fetch('/api/support')
      .then((response) => {
        if (!response.ok) throw new Error('Support counter unavailable');
        return response.json() as Promise<FundingData>;
      })
      .then(setFunding)
      .catch(() => setFundingError(true));
  };

  const copy = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopied(address);
    window.setTimeout(() => setCopied((current) => current === address ? null : current), 1600);
  };

  return (
    <>
      <button className={`support-trigger support-trigger-${variant}`} type="button" onClick={open}>{variant === 'header' ? 'Support' : 'Поддержать'}</button>
      <dialog className="support-dialog" ref={dialogRef} onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}>
        <div className="support-dialog-card">
          <button className="support-close" type="button" aria-label="Закрыть" onClick={() => dialogRef.current?.close()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11m0-11-11 11" /></svg>
          </button>
          <div className="support-dialog-hero">
            <div className="support-emblem"><img src="/valanium.svg" alt="" /></div>
            <div><span>Поддержать разработку</span><h2>Помочь Valanium</h2><p>Поддержите независимую инфраструктуру проекта.</p></div>
            <small><i /> On-chain</small>
          </div>
          <div className="support-overview">
            <section className="funding-progress" aria-label="Сбор средств за месяц">
              <div className="funding-progress-head">
                <div><small>Собрано за {funding?.month ?? 'текущий месяц'}</small><b>{funding ? `$${funding.total.toFixed(2)}` : fundingError ? 'Недоступно' : 'Загрузка…'}</b></div>
                <strong><span>Цель</span> $20</strong>
              </div>
              <div className="funding-track"><span style={{ width: `${Math.min(100, ((funding?.total ?? 0) / (funding?.goal ?? 20)) * 100)}%` }} /></div>
              {funding && <div className="funding-networks"><span>TON <b>${funding.ton.toFixed(2)}</b></span><span>TRON <b>${funding.tron.toFixed(2)}</b></span></div>}
              {funding && (!funding.sources.ton || !funding.sources.tron) && <small className="funding-warning">Одна из сетей временно не ответила — сумма может быть неполной.</small>}
            </section>
            <aside className="support-allocation">
              <span>Сверх цели</span>
              <b>Запас для сети</b>
              <p>Остаток пойдёт на более быстрые серверы или оплату следующих месяцев.</p>
            </aside>
          </div>
          <div className="wallet-list-head"><div><span>Выберите сеть</span><h3>Адреса для поддержки</h3></div><small>Проверяйте сеть перед переводом</small></div>
          <div className="wallet-list">
            {WALLETS.map((wallet) => (
              <div className="wallet" key={wallet.network}>
                <span className="wallet-mark" aria-hidden="true"><img src={wallet.icon} alt="" /></span>
                <div className="wallet-meta"><b>{wallet.name}</b><small>{wallet.network}</small></div>
                <code title={wallet.address}>{wallet.address}</code>
                <button type="button" onClick={() => copy(wallet.address)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                  <span>{copied === wallet.address ? 'Скопировано' : 'Копировать'}</span>
                </button>
              </div>
            ))}
          </div>
          <p className="support-note"><span aria-hidden="true">i</span><span>Счётчик учитывает подтверждённые USDT в TON и TRON за текущий месяц. Monero не отображается из-за приватности сети.</span></p>
        </div>
      </dialog>
    </>
  );
}

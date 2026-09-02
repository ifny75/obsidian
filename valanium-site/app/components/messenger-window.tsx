/**
 * Окно мессенджера — не выдуманный макет, а тот же интерфейс, что в клиенте:
 * своя полоса заголовка с названием по центру, список слева, переписка справа,
 * строка ввода таблеткой. Если интерфейс приложения меняется, меняется и это.
 */
export function MessengerWindow() {
  return (
    <div className="messenger-window" aria-label="Окно Valanium с защищённой перепиской">
      <div className="window-bar">
        <img src="/logos/brand.svg" alt="" />
        <b>Valanium</b>
        <span className="window-dots" aria-hidden="true">
          <i>—</i>
          <i>▢</i>
          <i>✕</i>
        </span>
      </div>

      <div className="window-body">
        <aside className="chat-list">
          <div className="list-head">
            <span className="avatar green">OB</span>
            <div>
              <b>Valanium</b>
              <small>в сети</small>
            </div>
          </div>

          <div className="search">
            <span aria-hidden="true">⌕</span> Поиск, @юзернейм или код
          </div>

          <div className="tabs">
            <span className="on">Диалоги</span>
            <span>Запросы</span>
          </div>

          <div className="person active">
            <span className="avatar violet">AU</span>
            <div>
              <b>
                @aurora <span className="emblem">☾</span>
              </b>
              <small>Голосовое · 0:12</small>
            </div>
            <time>18:42</time>
          </div>

          <div className="person">
            <span className="avatar">KI</span>
            <div>
              <b>@kira</b>
              <small>OBS-9DPH4-LF82D</small>
            </div>
            <time>17:05</time>
          </div>

          <div className="person">
            <span className="avatar">MX</span>
            <div>
              <b>@max</b>
              <small>Фото</small>
            </div>
            <time>вчера</time>
          </div>
        </aside>

        <section className="conversation">
          <header>
            <span className="avatar violet">AU</span>
            <div>
              <b>
                @aurora <span className="emblem">☾</span>
              </b>
              <small>E2E · защищённый диалог</small>
            </div>
            <span className="verify">◎ Сверить ключи</span>
          </header>

          <div className="messages">
            <div className="day">
              <i /> СЕГОДНЯ <i />
            </div>
            <div className="bubble">
              Сервер правда не видит текст?
              <time>18:40</time>
            </div>
            <div className="bubble out">
              Ему достаётся запечатанный конверт. Ключи не покидают устройства.
              <time>18:41 ✓✓</time>
            </div>
            <div className="bubble voice">
              <i aria-hidden="true">▶</i>
              <u aria-hidden="true" />
              <span>0:12</span>
            </div>
            <div className="bubble out">
              И входа по номеру телефона нет — только код или юзернейм.
              <time>18:42 ✓✓</time>
            </div>
          </div>

          <div className="composer">
            <span className="round" aria-hidden="true">
              ＋
            </span>
            <p>Сообщение…</p>
            <span className="round" aria-hidden="true">
              ●
            </span>
            <span className="send" aria-hidden="true">
              ↑
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

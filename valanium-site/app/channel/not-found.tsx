/** Имя канала не по формату либо адрес набран от руки с ошибкой. */
export default function ChannelNotFound() {
  return (
    <main>
      <section className="shell channel-page">
        <p className="eyebrow">Канал</p>
        <h1 className="channel-handle">Такой ссылки нет</h1>
        <p className="hero-lead">
          Имя канала состоит из латинских букв, цифр и подчёркиваний — от трёх до
          тридцати знаков. Проверьте ссылку целиком: скорее всего, она обрезалась
          при пересылке.
        </p>
        <div className="actions">
          <a className="button primary" href="/">
            <span>
              <small>Вернуться</small>
              <b>На главную</b>
            </span>
          </a>
        </div>
      </section>
    </main>
  );
}

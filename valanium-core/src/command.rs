//! Граница между ядром и UI: команды внутрь, события наружу.
//!
//! Это единственный словарь, который знает интерфейс. Он одинаков для Java на
//! Android и для WebView на Windows, поэтому новую кнопку не нужно
//! прокидывать через FFI отдельной функцией — достаточно нового варианта.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Создать личность и зарегистрироваться по инвайту.
    ///
    /// `payment_ref` работает только со сборкой `--features ton`: без неё
    /// получить счёт нечем, и поле всегда остаётся пустым.
    Register {
        url: String,
        handle: Option<String>,
        invite: Option<String>,
        #[serde(default)]
        payment_ref: Option<String>,
    },
    /// Выставить счёт в TON. Ответ придёт событием `Invoice`.
    #[cfg(feature = "ton")]
    RequestInvoice { url: String },
    /// Войти уже существующей личностью.
    Connect { url: String },
    Disconnect,
    /// `recipient_device` — hex публичного ключа устройства получателя.
    Send { recipient_device: String, body: String },
    /// Страница истории. `before` — курсор из предыдущей страницы; пусто —
    /// «с самого свежего». Постранично, а не всё сразу: в переписке с фото и
    /// голосовыми выдача целиком — это мегабайты base64 через границу FFI на
    /// каждое открытие чата.
    History {
        conversation: String,
        limit: i64,
        #[serde(default)]
        before: Option<String>,
    },
    /// Есть ли уже личность в этой базе и какая. Работает без подключения.
    Status,
    /// Заведённые беседы. События `conversation_started` живут только в
    /// текущей сессии, а список нужен и сразу после запуска.
    Conversations,
    /// Отпечаток для ручной сверки контакта.
    Fingerprint { identity: String },
    /// Что сверить с собеседником по другому каналу, чтобы убедиться, что
    /// между вами никого нет. Работает и без подключения.
    Verify { peer_device: String },
    /// Получить публичный профиль по OBS-коду или 64-символьному device key.
    ProfileGet { query: String },
    /// Показать код восстановления. Работает без подключения.
    RecoveryCode,
    /// Восстановить личность на новом устройстве по коду.
    ///
    /// Ключ устройства при этом создаётся свой: восстанавливается личность, а
    /// не старое устройство. Сервер примет его без инвайта — личность ему уже
    /// известна.
    Recover { url: String, code: String },
    /// Включить восстановление по логину и паролю. Требует подключения:
    /// запечатанная посылка кладётся на сервер.
    ///
    /// Пароль здесь не тот, которым открывается локальная база, — это
    /// отдельный секрет, и им нельзя открыть ничего, кроме посылки.
    ///
    /// `totp` — секрет для приложения с одноразовыми кодами, если человек
    /// включает второй фактор. `code` при этом обязателен: сервер проверит, что
    /// приложение действительно выдаёт правильные коды, прежде чем запирать
    /// посылку. Без такой проверки человек включил бы второй фактор, ошибся при
    /// переносе секрета и потерял доступ, узнав об этом через полгода.
    RecoverySetup {
        login: String,
        password: String,
        #[serde(default)]
        totp: Option<String>,
        #[serde(default)]
        code: Option<String>,
    },
    /// Завести секрет для приложения с кодами. Ответ — `TotpSecret`.
    TotpSecret { login: String },
    /// Убрать посылку с сервера. Восстановление по паролю после этого не
    /// работает — остаётся только код.
    RecoveryForget,
    /// Восстановить личность по логину и паролю на новом устройстве.
    RecoverPassword {
        url: String,
        login: String,
        password: String,
        /// Одноразовый код, если у этого логина включён второй фактор.
        #[serde(default)]
        code: Option<String>,
    },
    /// Удалить одно сообщение из локальной переписки.
    ///
    /// `for_both` просит удалить его и у собеседника. Именно просит: выполнит
    /// это его клиент, а не мы, и копия у него уже есть.
    DeleteMessage { conversation: String, id: String, #[serde(default)] for_both: bool },
    /// Заменить текст уже отправленного сообщения.
    ///
    /// `for_both` просит заменить его и у собеседника. Именно просит: сделает
    /// это его клиент, а прочитанного старого текста правка не отменяет.
    EditMessage {
        conversation: String,
        id: String,
        body: String,
        #[serde(default)]
        for_both: bool,
    },
    /// Очистить переписку, оставив саму беседу.
    ClearConversation { conversation: String },
    /// Убрать и переписку, и беседу целиком.
    DeleteConversation { conversation: String },
    /// Сообщить собеседнику, что мы набираем текст.
    Typing { recipient_device: String, active: bool },
    /// Прочитать, кому позволено писать. Работает без подключения.
    AccessGet,
    /// Сменить политику. Требует подключения: её проверяет сервер.
    AccessSet { policy: crate::access::Policy },
    /// Выпустить ссылку-приглашение.
    PassInvite {
        label: Option<String>,
        one_time: bool,
        /// 0 — бессрочно.
        ttl_sec: u64,
    },
    /// Отозвать выпущенный пропуск по его хешу.
    PassRevoke { hash: String },
    /// Занять или сменить юзернейм. Требует подключения.
    ///
    /// Юзернейм — слой поиска, а не личность: сменить его можно когда угодно, и
    /// ни одна проверка ключей на него не опирается.
    UsernameSet { name: String, discoverable: bool },
    /// Освободить юзернейм.
    UsernameClear,
    /// Найти человека по точному юзернейму.
    UsernameLookup { name: String },
    /// Локальная книга отношений: контакты, одобренные, запросы, блокировки.
    DirectoryList,
    /// Изменить положение собеседника.
    DirectorySet { device: String, standing: crate::directory::Standing },
    /// Забыть о собеседнике целиком.
    DirectoryForget { device: String },
    /// Прочитать правила приватности. Работает без подключения.
    PrivacyGet,
    /// Заменить правила приватности целиком.
    ///
    /// Целиком, а не по одному полю, намеренно: экран настроек всё равно держит
    /// весь набор, а частичные правки открыли бы окно, в котором сохранённое
    /// состояние не соответствует ни одному показанному.
    PrivacySet { privacy: crate::privacy::Privacy },
    /// Обновить или очистить свой серверный аватар.
    ProfileSet {
        avatar_mime: Option<String>,
        avatar_base64: Option<String>,
    },
    /// Значок и цвет профиля. Пустое поле означает «не трогать».
    ProfileDecor {
        emblem: Option<String>,
        color: Option<String>,
    },
    /// Завести группу или канал.
    ///
    /// Разница между ними одна и вся в правилах: в канале пишет только
    /// владелец. Криптографически это одна и та же группа MLS — сервер о ней
    /// по-прежнему не знает ничего, включая сам факт её существования.
    GroupCreate {
        title: String,
        /// `chat` — пишут все, `channel` — только владелец.
        kind: String,
        /// Кого позвать сразу. Можно и никого — позвать получится позже.
        #[serde(default)]
        members: Vec<String>,
    },
    /// Позвать людей в существующую группу.
    GroupInvite { group: String, members: Vec<String> },
    /// Убрать участника. Прочитанное раньше у него останется.
    GroupRemove { group: String, device: String },
    /// Написать в группу.
    GroupSend { group: String, body: String },
    /// Забыть группу вместе с перепиской на этом устройстве.
    GroupForget { group: String },
    /// Перечислить свои группы.
    Groups,
    /// Завести открытый канал: короткое имя, название, описание.
    ChannelCreate { handle: String, title: String, about: Option<String> },
    /// Написать в свой канал.
    ///
    /// Текст уходит на сервер КАК ЕСТЬ. Канал открыт, подписаться может кто
    /// угодно, и ключ пришлось бы отдать любому желающему — шифровать вещание
    /// для неизвестного круга значит обманывать читателя, а не защищать его.
    /// Поэтому интерфейс обязан помечать канал открытым.
    ChannelPublish { channel: String, body: String },
    /// Свои и читаемые каналы.
    ChannelList,
    /// Лента канала страницами: `before` — с какого номера идти вглубь.
    ChannelFeed { channel: String, before: Option<i64> },
    /// Подписаться или отписаться.
    ChannelSubscribe { channel: String, subscribe: bool },
    /// Найти канал по короткому имени.
    ChannelFind { handle: String },
    /// Убрать свой пост.
    ChannelDeletePost { channel: String, post: String },
    /// Закрыть свой канал целиком: посты и подписки уходят следом.
    ChannelDelete { channel: String },
    /// Сменить название, описание или значок своего канала.
    ///
    /// Каждое поле необязательно: шлём только то, что человек тронул. Имя
    /// канала не меняется — на нём держится ссылка, по которой на канал уже
    /// сослались. `icon: null` снимает значок, отсутствие поля — не трогает.
    ChannelUpdate {
        channel: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        about: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<serde_json::Value>,
    },
    /// Позвать человека писать в канал или вернуть его в читатели.
    ChannelAdmin {
        channel: String,
        who: String,
        #[serde(default = "yes")]
        admin: bool,
    },
    /// Отозвать все прочие устройства. Подписывается identity-ключом.
    RevokeOtherDevices,
    /// Подтвердить, что новый ключ под знакомым именем — это правда он.
    ///
    /// Спрашивается ровно один раз на смену: до подтверждения переписка с этим
    /// именем не начинается, после — закрепляется новый ключ.
    PinAccept { name: String, device: String },
    /// Забыть закрепление имени.
    PinForget { name: String },
    /// Собрать файл переноса аккаунта под отдельным паролем.
    ///
    /// Паролей тут два, и это не дублирование. `password` запечатывает сам
    /// файл: он уезжает с машины, и его стойкость человек выбирает отдельно.
    /// `unlock` — пароль этого устройства, и он здесь затем, что экспорт
    /// выносит наружу ключи и всю переписку разом. База в этот момент уже
    /// открыта, то есть достаточно чужих рук на разблокированной машине;
    /// подтверждение паролем — единственное, что стоит между такими руками и
    /// копией всего аккаунта.
    AccountExport { password: String, unlock: String },
    /// Разложить файл переноса в эту базу. `data` — содержимое файла в hex.
    AccountImport { password: String, data: String },
    /// Сколько места занято на этом устройстве.
    Storage,
    /// Счётчики и список аккаунтов. Отвечает только владельцу.
    ///
    /// `offset` — с какого места списка продолжать: страницами, чтобы панель не
    /// тянула всю базу одним кадром.
    AdminGet {
        #[serde(default)]
        offset: u64,
    },
    /// Заблокировать или разблокировать аккаунт по коду чата либо адресу.
    AdminAction {
        action: String,
        reference: String,
    },
    /// Почта поддержки: список переписок, либо одна целиком, если задан `thread`.
    SupportGet {
        #[serde(default)]
        offset: u64,
        #[serde(default)]
        thread: Option<String>,
    },
    /// Ответить письмом. Уходит человеку раньше, чем ложится в базу.
    SupportReply {
        thread: String,
        body: String,
    },
    /// Пометить прочитанной, а с `closed` — закрыть либо открыть заново.
    SupportMark {
        thread: String,
        #[serde(default)]
        closed: Option<bool>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Соединение установлено, сервер представился.
    Connected {
        heartbeat_sec: u64,
        invite_entry: bool,
        ton_entry: bool,
        profiles: bool,
        decor: bool,
    },
    Registered { identity: String, device: String },
    Authenticated { device_id: String, queued: u64, admin: bool },
    /// Счёт на оплату входа: адрес, сумма в nanoton и memo.
    #[cfg(feature = "ton")]
    Invoice { reference: String, address: String, amount_nano: String, expires_at: i64, paid: bool },
    /// Оплата зачислена — можно регистрироваться.
    #[cfg(feature = "ton")]
    InvoicePaid { reference: String },
    /// Сообщение принято сервером: `client_ref` — тот, что был в Send.
    Accepted { client_ref: String, envelope_id: String },
    /// Диалог заведён: собеседник принял приглашение либо позвал нас сам.
    /// `peer_device` уже проверен — за ним стоит именно этот ключ устройства.
    ConversationStarted { peer_device: String, conversation: String },
    /// Входящее сообщение, уже расшифрованное.
    ///
    /// `sender_device` не «кто представился», а кто доказал владение ключом:
    /// привязка MLS-листа к устройству проверяется на каждом сообщении.
    Message {
        envelope_id: String,
        conversation: String,
        sender_device: String,
        server_ts: u64,
        body: String,
    },
    /// Накопленная очередь доставлена целиком.
    QueueDone,
    /// `conversation` обязателен: без него интерфейс не отличит ответ для
    /// открытого сейчас чата от запоздавшего ответа для предыдущего.
    History { conversation: String, messages: Vec<HistoryItem>, has_more: bool },
    /// `identity` и `device` пусты, если личности ещё нет.
    Status { has_identity: bool, identity: String, device: String },
    Conversations { items: Vec<ConversationItem> },
    Fingerprint { identity: String, fingerprint: String },
    Profile {
        device: String,
        chat_code: String,
        handle: Option<String>,
        avatar_mime: Option<String>,
        avatar_base64: Option<String>,
        emblem: Option<String>,
        color: Option<String>,
        updated_at: i64,
    },
    /// Группа или канал: состав берётся из самого MLS, а не из чужого списка.
    Group {
        group: String,
        kind: String,
        title: String,
        owner: String,
        members: Vec<String>,
    },
    /// Группа исчезла с этого устройства.
    GroupForgotten { group: String },
    /// Что лежит на этом устройстве. Ничего из этого никуда не отправляется.
    Storage { database_bytes: u64, conversations: u64, messages: u64 },
    /// Файл переноса готов: `data` — его содержимое в hex, интерфейс сохраняет
    /// его на диск. Через ядро он не пишется намеренно — путь к файлу выбирает
    /// человек, а не библиотека.
    AccountExported { data: String, messages: u64 },
    /// Аккаунт перенесён: столько сообщений легло в базу.
    AccountImported { messages: u64 },
    /// Ответ по каналам: список, лента, найденный канал — что спросили.
    ///
    /// Пересылается как есть: набор полей задаёт сервер, и разбирать его здесь
    /// значило бы ломать клиент при каждом новом поле.
    Channels { report: serde_json::Value },
    /// Новый пост в канале, на который подписаны.
    ChannelPost { report: serde_json::Value },
    DevicesRevoked { count: u64 },
    /// Ответ панели поддержки. Как и Admin, пересылается сервером как есть.
    Support { report: serde_json::Value },
    /// Ответ панели владельца: только счётчики.
    ///
    /// Ни переписок, ни списка людей здесь нет — сервер их не хранит, и панель
    /// не должна создавать впечатление, будто хранит.
    Admin { report: serde_json::Value },
    /// Тело сообщения заменено — своё или по просьбе собеседника.
    Edited { conversation: String, id: String, body: String },
    /// Сообщения исчезли из локальной базы.
    Deleted { conversation: String, ids: Vec<String> },
    /// Переписка очищена или беседа удалена целиком.
    ConversationCleared { conversation: String, forgotten: bool },
    /// Собеседник объявился в сети.
    ///
    /// «В сети» здесь означает «прислал признак жизни только что». Держит ли он
    /// соединение прямо сейчас, мы не знаем и знать не можем: сигнала о выходе
    /// не бывает — связь рвётся молча.
    PeerOnline { peer_device: String },
    /// Собеседник набирает текст.
    PeerTyping { peer_device: String, active: bool },
    /// Текущая политика и выпущенные приглашения.
    Access {
        policy: crate::access::Policy,
        invites: Vec<crate::access::Invite>,
        granted: usize,
    },
    /// Свой юзернейм. Пусто — не занят.
    Username { name: Option<String>, discoverable: bool },
    /// Итог поиска. `device` пуст, если никого не нашли или человек скрыт.
    ///
    /// `pin` говорит, что мы помним об этом имени: встречено впервые, ключ тот
    /// же или ключ сменился. Последнее — не ошибка и не приговор, но и не то,
    /// о чём можно промолчать: см. `pins.rs`.
    UsernameFound {
        query: String,
        device: Option<String>,
        #[serde(default)]
        pin: Option<crate::pins::PinState>,
        chat_code: Option<String>,
        avatar_mime: Option<String>,
        avatar_base64: Option<String>,
        emblem: Option<String>,
        color: Option<String>,
    },
    /// Новый ключ под знакомым именем подтверждён.
    PinAccepted { name: String, device: String },
    /// Книга отношений целиком.
    Directory { entries: Vec<DirectoryItem> },
    /// Текущие правила приватности.
    Privacy { privacy: crate::privacy::Privacy },
    /// Запись для восстановления. Показывать один раз и просить записать: она
    /// равносильна личности, и в логи или скриншоты ей нельзя.
    ///
    /// Два вида одной и той же записи, а не два разных ключа: `words` — те же
    /// 32 байта двадцатью четырьмя словами. Человеку показывают слова, потому
    /// что их переписывают глазами, а не по одному символу; `code` остаётся для
    /// тех, у кого он уже записан на бумаге.
    RecoveryCode { code: String, words: String },
    /// Посылка легла на сервер: вход по этому логину теперь работает.
    RecoverySaved { login: String, #[serde(default)] totp: bool },
    /// Новый секрет для приложения с кодами. Показать и попросить подтвердить
    /// кодом — до подтверждения на сервер ничего не уходит.
    TotpSecret { secret: String, readable: String, url: String },
    /// Посылки на сервере больше нет.
    RecoveryForgotten,
    /// Данные для сверки беседы.
    ///
    /// `safety_number` считается от пары устройств и не меняется, пока не
    /// сменились ключи. `epoch_code` выведен из секрета эпохи MLS: он одинаков
    /// у участников исправной беседы и меняется на каждом коммите.
    Verification {
        peer_device: String,
        safety_number: String,
        epoch: u64,
        epoch_code: String,
        members: Vec<String>,
    },
    /// Криптография сошлась, но состояние выглядит подозрительно. Это не сбой,
    /// а возможная атака: показывать заметно и не прятать в общий лог ошибок.
    Anomaly { kind: String, detail: String },
    Disconnected { reason: String },
    /// `code` — машиночитаемый (`payment_pending`, `handle_taken`, …).
    Failed { code: String, message: String },
}

#[derive(Debug, Serialize)]
pub struct DirectoryItem {
    pub device: String,
    pub standing: crate::directory::Standing,
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub origin: Option<String>,
    pub noted_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ConversationItem {
    pub peer_device: String,
    pub conversation: String,
    /// Последнее расшифрованное сообщение остаётся локальным и нужно списку
    /// бесед вместо бесполезной одинаковой подписи «Защищённый диалог».
    pub last_body: Option<String>,
    pub last_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct HistoryItem {
    pub id: String,
    /// Непрозрачный курсор для следующей страницы.
    pub cursor: String,
    pub outgoing: bool,
    pub created_at: i64,
    pub body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_parse_from_ui_json() {
        let command: Command =
            serde_json::from_str(r#"{"type":"send","recipient_device":"ab","body":"hi"}"#).unwrap();
        assert!(matches!(command, Command::Send { .. }));

        let register: Command = serde_json::from_str(
            r#"{"type":"register","url":"wss://x/ws","handle":"alice","invite":"code"}"#,
        )
        .unwrap();
        match register {
            Command::Register { handle, invite, .. } => {
                assert_eq!(handle.as_deref(), Some("alice"));
                assert_eq!(invite.as_deref(), Some("code"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    /// Без фичи `ton` выставить счёт нечем — команда просто не существует.
    #[test]
    #[cfg(not(feature = "ton"))]
    fn invoice_command_is_absent_in_the_default_build() {
        assert!(serde_json::from_str::<Command>(r#"{"type":"request_invoice","url":"wss://x"}"#).is_err());
    }

    #[test]
    fn unknown_command_is_an_error_not_a_default() {
        assert!(serde_json::from_str::<Command>(r#"{"type":"launch_missiles"}"#).is_err());
    }

    #[test]
    fn message_event_carries_conversation_and_sender() {
        let json = serde_json::to_string(&Event::Message {
            envelope_id: "aa".into(),
            conversation: "bb".into(),
            sender_device: "cc".into(),
            server_ts: 1,
            body: "текст".into(),
        })
        .unwrap();

        // UI обязан знать, в какую беседу класть сообщение и от кого оно.
        assert!(json.contains(r#""conversation":"bb""#));
        assert!(json.contains(r#""sender_device":"cc""#));
    }

    #[test]
    fn password_recovery_commands_parse() {
        assert!(matches!(
            serde_json::from_str::<Command>(
                r#"{"type":"recovery_setup","login":"alice","password":"длинный-пароль"}"#
            ).unwrap(),
            Command::RecoverySetup { .. }
        ));
        assert!(matches!(
            serde_json::from_str::<Command>(
                r#"{"type":"recover_password","url":"wss://x/ws","login":"alice","password":"p"}"#
            ).unwrap(),
            Command::RecoverPassword { .. }
        ));
        assert!(matches!(
            serde_json::from_str::<Command>(r#"{"type":"recovery_forget"}"#).unwrap(),
            Command::RecoveryForget
        ));
    }

    #[test]
    fn recovery_commands_parse() {
        assert!(matches!(
            serde_json::from_str::<Command>(r#"{"type":"recovery_code"}"#).unwrap(),
            Command::RecoveryCode
        ));
        assert!(matches!(
            serde_json::from_str::<Command>(r#"{"type":"recover","url":"wss://x/ws","code":"AAA"}"#)
                .unwrap(),
            Command::Recover { .. }
        ));
    }

    #[test]
    fn verify_command_parses() {
        let command: Command =
            serde_json::from_str(r#"{"type":"verify","peer_device":"ab"}"#).unwrap();
        assert!(matches!(command, Command::Verify { .. }));
    }

    #[test]
    fn anomaly_is_a_separate_event_not_a_failure() {
        // Интерфейс обязан отличать «не получилось» от «похоже на атаку».
        let json = serde_json::to_string(&Event::Anomaly {
            kind: "member_set".into(),
            detail: "в беседе 3 участника вместо двух".into(),
        })
        .unwrap();
        assert!(json.contains(r#""type":"anomaly""#));
    }

    #[test]
    fn status_and_conversations_parse() {
        assert!(matches!(
            serde_json::from_str::<Command>(r#"{"type":"status"}"#).unwrap(),
            Command::Status
        ));
        assert!(matches!(
            serde_json::from_str::<Command>(r#"{"type":"conversations"}"#).unwrap(),
            Command::Conversations
        ));
    }

    #[test]
    fn events_serialise_with_tag() {
        let json = serde_json::to_string(&Event::QueueDone).unwrap();
        assert_eq!(json, r#"{"type":"queue_done"}"#);

        let json = serde_json::to_string(&Event::Failed {
            code: "payment_pending".into(),
            message: "invoice not funded yet".into(),
        })
        .unwrap();
        assert!(json.contains(r#""type":"failed""#));
        assert!(json.contains("payment_pending"));
    }
}

/// Значение по умолчанию для `ChannelAdmin::admin`: команда без флага зовёт,
/// а не разжалует.
fn yes() -> bool {
    true
}

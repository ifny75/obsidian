//! Движок: одно соединение, один цикл, всё состояние внутри задачи.
//!
//! Наружу — только команды и события. UI не видит ни сокета, ни ключей, ни
//! шифротекста: он оперирует открытым текстом, а граница доверия проходит
//! ровно здесь.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::command::{Command, ConversationItem, Event, HistoryItem};
use crate::crypto::random_bytes;
use crate::error::{CoreError, Result};
use crate::keys::Credentials;
use crate::keys;
use crate::mls::{Incoming, Mls};
#[cfg(feature = "ton")]
use crate::proto::PayInfo;
use crate::proto::{self, op, AuthErr, AuthOk, AuthRequest, Hello, ServerError, ID_LEN, KEY_LEN};
use crate::store::Store;

pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Cloudflare рвёт WS после ~100 с тишины, поэтому пинг обязателен. Если
/// сервер вдруг не назвал период — берём безопасное значение сами.
const FALLBACK_HEARTBEAT_SEC: u64 = 30;
const MAX_BACKOFF_SEC: u64 = 60;
const DEFAULT_TTL_SEC: u32 = 14 * 24 * 3600;
/// Сколько KeyPackages выкладывать при подключении. Каждый расходуется одним
/// собеседником, поэтому запас нужен, но небольшой.
const KEY_PACKAGES_PER_CONNECT: usize = 5;

/// Как представляться серверу при подключении.
enum Entry {
    /// Личность уже зарегистрирована.
    Existing,
    /// Первый вход: нужен пропуск.
    Register { handle: Option<String>, invite: Option<String>, payment_ref: Option<String> },
    /// Только выставить счёт и ждать оплаты.
    #[cfg(feature = "ton")]
    Invoice,
}

/// Отправка, ждущая KeyPackage собеседника либо восстановления соединения.
struct PendingSend {
    device: [u8; KEY_LEN],
    body: String,
    /// Своя копия уже лежит в базе. При повторе её не надо класть снова —
    /// иначе разрыв связи раздваивал бы сообщение в собственной переписке.
    stored: bool,
}

/// Не ушедшее из-за обрыва.
type Outbox = Vec<PendingSend>;

/// Зачем мы просили KeyPackage.
///
/// Раньше причина была одна — первое сообщение человеку, — и ответ сервера
/// однозначно означал «заводим беседу вдвоём». С группами тот же кадр может
/// прийти на приглашение, и перепутать эти два случая нельзя: во втором
/// заводить новую беседу не надо, надо добавить лист в существующую.
enum Claim {
    Start(PendingSend),
    Invite { group_id: Vec<u8>, device: [u8; KEY_LEN] },
}

/// Состояние, переживающее переподключение.
///
/// Живёт в `session`, а не в `pump`: и отправной ящик, и память о неудачных
/// конвертах имеют смысл только между попытками соединения.
#[derive(Default)]
struct Live {
    outbox: Outbox,
    /// Конверты, которые не удалось прочитать. Первый промах прощается —
    /// сообщение могло опередить приглашение и на следующем подключении
    /// разберётся. Второй означает, что оно не разберётся уже никогда.
    failed: std::collections::HashSet<[u8; ID_LEN]>,
}

/// Обрыв связи, а не отказ сервера. Такую ошибку лечит переподключение, и
/// продолжать писать в этот сокет бессмысленно: он уже закрыт.
///
/// Сбои MLS сюда не входят: связь при них цела, и переподключение их не чинит —
/// на новом соединении повторится то же самое.
fn is_transport(error: &CoreError) -> bool {
    matches!(error, CoreError::Transport(_))
}

pub struct Engine {
    commands: mpsc::UnboundedSender<Command>,
}

impl Engine {
    /// Поднимает рантайм в отдельном потоке. Возвращается сразу.
    pub fn start(db_path: String, password: Vec<u8>, sink: EventSink) -> Result<Self> {
        // В итоговой Tauri-сборке зависимости могут включить одновременно
        // ring и aws-lc-rs. Rustls в таком случае намеренно не выбирает
        // провайдер сам и паникует при первом wss:// соединении. Клиент
        // использует ring явно на всех платформах.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let (tx, rx) = mpsc::unbounded_channel();
        let store = Store::open(&db_path, &password)?;

        std::thread::Builder::new()
            .name("obsidian-core".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    Err(_) => {
                        sink(Event::Failed {
                            code: "runtime".into(),
                            message: "cannot start async runtime".into(),
                        });
                        return;
                    }
                };
                runtime.block_on(run(rx, store, sink));
            })
            .map_err(|_| CoreError::Transport("cannot spawn core thread".into()))?;

        Ok(Self { commands: tx })
    }

    pub fn submit(&self, command: Command) -> Result<()> {
        self.commands
            .send(command)
            .map_err(|_| CoreError::Transport("core thread is gone".into()))
    }
}

/// Главный цикл. Живёт, пока UI не закроет канал команд.
/// Команды, которым не нужна сеть: они читают локальную базу и отвечают сразу.
/// `true` — команда обработана здесь, дальше её вести не надо.
///
/// Собрано в одно место намеренно. Раньше этот набор был продублирован в `run`
/// и в `pump`, и любая новая локальная команда молча получала «already
/// connected», если про второе место забывали, — на этом и попался
/// `recovery_code`, который нужен как раз тогда, когда клиент подключён.
fn handle_local(command: &Command, store: &Store, sink: &EventSink) -> bool {
    match command {
        Command::Status => {
            sink(status(store));
            sink(username_event(store));
        }

        Command::RecoveryCode => match store.load_credentials() {
            Ok(credentials) => sink(Event::RecoveryCode {
                code: crate::recovery::encode(&credentials.identity),
                words: crate::recovery::encode_words(&credentials.identity),
            }),
            Err(_) => fail(sink, "no_identity", "личности в этой базе ещё нет"),
        },

        Command::TotpSecret { login } => {
            // Сети не нужно: секрет заводится на устройстве и до подтверждения
            // кодом никуда не уходит.
            let secret = crate::totp::new_secret(&login);
            sink(Event::TotpSecret {
                readable: crate::totp::readable(&secret.base32),
                secret: secret.base32,
                url: secret.url,
            });
        }

        Command::AccountExport { password, unlock } => {
            // Сначала подтверждение, потом сбор: собирать архив, который затем
            // некому отдать, значило бы держать всю переписку в памяти зря.
            let confirmed = store.password_matches(unlock.as_bytes());
            match confirmed {
                Ok(false) => fail(sink, "account_export", "пароль устройства не подходит"),
                Err(err) => fail(sink, "account_export", &err.to_string()),
                Ok(true) => {
                    let built = store.export_archive().and_then(|archive| {
                        let count = archive.messages.len() as u64;
                        crate::migrate::seal(password, &archive).map(|file| (file, count))
                    });
                    match built {
                        Ok((file, messages)) => sink(Event::AccountExported {
                            data: hex::encode(file),
                            messages,
                        }),
                        Err(err) => fail(sink, "account_export", &err.to_string()),
                    }
                }
            }
        }
        Command::AccountImport { password, data } => {
            let restored = hex::decode(&data)
                .map_err(|_| CoreError::BadFrame)
                .and_then(|file| crate::migrate::open(&password, &file))
                .and_then(|archive| store.import_archive(&archive));
            match restored {
                Ok(messages) => sink(Event::AccountImported { messages: messages as u64 }),
                Err(err) => fail(sink, "account_import", &err.to_string()),
            }
        }
        Command::Storage => match store.counts() {
            Ok((conversations, messages)) => sink(Event::Storage {
                database_bytes: store.footprint(),
                conversations,
                messages,
            }),
            Err(err) => fail(sink, "storage", &err.to_string()),
        },
        Command::Groups => {
            // Список групп лежит на устройстве, и связь для него не нужна:
            // интерфейсу есть что показать сразу после запуска. Состав берётся
            // из снимка, который обновляется при каждом изменении группы.
            for (group_id, _kind, raw) in store.list_groups().unwrap_or_default() {
                if let Ok(meta) = serde_json::from_slice::<GroupMeta>(&raw) {
                    sink(Event::Group {
                        group: hex::encode(&group_id),
                        kind: meta.kind,
                        title: meta.title,
                        owner: meta.owner,
                        members: meta.members,
                    });
                }
            }
        }
        Command::PrivacyGet => sink(privacy_event(store)),

        Command::DirectoryList => sink(directory_event(store)),

        Command::AccessGet => sink(access_event(store)),

        Command::ClearConversation { conversation } => match hex::decode(conversation) {
            Ok(id) => match store.delete_conversation(&id) {
                Ok(_) => sink(Event::ConversationCleared {
                    conversation: conversation.clone(),
                    forgotten: false,
                }),
                Err(err) => fail(sink, "storage", &err.to_string()),
            },
            Err(_) => fail(sink, "bad_conversation", "conversation must be hex"),
        },

        Command::DeleteConversation { conversation } => match hex::decode(conversation) {
            Ok(id) => match store.forget_conversation(&id) {
                Ok(()) => sink(Event::ConversationCleared {
                    conversation: conversation.clone(),
                    forgotten: true,
                }),
                Err(err) => fail(sink, "storage", &err.to_string()),
            },
            Err(_) => fail(sink, "bad_conversation", "conversation must be hex"),
        },

        Command::DirectorySet { device, standing } => {
            let mut directory = load_directory(store);
            directory.set(device, *standing, now_millis());
            match save_directory(store, &directory) {
                Ok(()) => sink(directory_event(store)),
                Err(err) => fail(sink, "storage", &err.to_string()),
            }
        }

        Command::PinAccept { name, device } => {
            let mut pins = load_pins(store);
            if pins.accept(name, device, now_millis()) {
                match save_pins(store, &pins) {
                    Ok(()) => sink(Event::PinAccepted {
                        name: name.clone(),
                        device: device.clone(),
                    }),
                    Err(err) => fail(sink, "storage", &err.to_string()),
                }
            } else {
                // Подтверждать нечего: ключ тот же или имя незнакомое. Молчать
                // нельзя — интерфейс ждёт ответа на нажатую кнопку.
                sink(Event::PinAccepted { name: name.clone(), device: device.clone() });
            }
        }

        Command::PinForget { name } => {
            let mut pins = load_pins(store);
            pins.forget(name);
            if let Err(err) = save_pins(store, &pins) {
                fail(sink, "storage", &err.to_string());
            }
        }

        Command::DirectoryForget { device } => {
            let mut directory = load_directory(store);
            directory.forget(device);
            match save_directory(store, &directory) {
                Ok(()) => sink(directory_event(store)),
                Err(err) => fail(sink, "storage", &err.to_string()),
            }
        }

        Command::PrivacySet { privacy } => match serde_json::to_vec(privacy) {
            Ok(encoded) => match store.save_setting(PRIVACY_KEY, &encoded) {
                Ok(()) => sink(Event::Privacy { privacy: privacy.clone() }),
                Err(err) => fail(sink, "storage", &err.to_string()),
            },
            Err(err) => fail(sink, "encoding", &err.to_string()),
        },

        Command::Fingerprint { identity } => match hex::decode(identity) {
            Ok(bytes) => sink(Event::Fingerprint {
                fingerprint: crate::keys::fingerprint(&bytes),
                identity: identity.clone(),
            }),
            Err(_) => fail(sink, "bad_identity", "identity must be hex"),
        },

        Command::Conversations => match store.list_conversations() {
            Ok(items) => sink(Event::Conversations {
                items: items
                    .into_iter()
                    .map(|(peer_device, conversation)| ConversationItem {
                        peer_device: hex::encode(peer_device),
                        conversation: hex::encode(conversation),
                    })
                    .collect(),
            }),
            Err(err) => fail(sink, "storage", &err.to_string()),
        },

        Command::History { conversation, limit, before } => match hex::decode(conversation) {
            Ok(id) => match store.list_messages(&id, *limit, parse_cursor(before)) {
                Ok(rows) => {
                    // Отдали ровно столько, сколько просили, — значит дальше,
                    // скорее всего, есть ещё. Лишний пустой запрос дешевле, чем
                    // лишний счётный проход по всей переписке.
                    let has_more = rows.len() as i64 >= *limit;
                    sink(Event::History {
                        conversation: conversation.clone(),
                        has_more,
                        messages: rows
                            .into_iter()
                            .map(|row| HistoryItem {
                                id: hex::encode(&row.id),
                                cursor: format!("{}:{}", row.created_at, row.seq),
                                outgoing: row.outgoing,
                                created_at: row.created_at,
                                body: String::from_utf8_lossy(&row.body).into_owned(),
                            })
                            .collect(),
                    })
                }
                Err(err) => fail(sink, "storage", &err.to_string()),
            },
            Err(_) => fail(sink, "bad_conversation", "conversation must be hex"),
        },

        _ => return false,
    }
    true
}

async fn run(mut commands: mpsc::UnboundedReceiver<Command>, store: Store, sink: EventSink) {
    while let Some(command) = commands.recv().await {
        if handle_local(&command, &store, &sink) {
            continue;
        }
        match command {
            Command::Recover { url, code } => match recover(&store, &code) {
                Ok(()) => session(&url, Entry::Existing, &store, &sink, &mut commands).await,
                Err(err) => fail(&sink, recovery_code_of(&err), &err.to_string()),
            },
            Command::RecoverPassword { url, login, password, code } => {
                match recover_with_password(&store, &url, &login, &password, code.as_deref()).await {
                    Ok(()) => session(&url, Entry::Existing, &store, &sink, &mut commands).await,
                    Err(err) => fail(&sink, password_code_of(&err), &err.to_string()),
                }
            }
            Command::Verify { peer_device } => {
                // Сверка не требует сети: всё нужное лежит в локальном снимке.
                match load_or_create(&store, &Entry::Existing).and_then(|c| load_or_create_mls(&store, &c)) {
                    Ok(mls) => sink(verification(&mls, &store, &peer_device)),
                    Err(err) => fail(&sink, "keys", &err.to_string()),
                }
            }
            #[cfg(feature = "ton")]
            Command::RequestInvoice { url } => {
                session(&url, Entry::Invoice, &store, &sink, &mut commands).await;
            }
            Command::Register { url, handle, invite, payment_ref } => {
                session(&url, Entry::Register { handle, invite, payment_ref }, &store, &sink, &mut commands)
                    .await;
            }
            Command::Connect { url } => {
                session(&url, Entry::Existing, &store, &sink, &mut commands).await;
            }
            Command::Disconnect => sink(Event::Disconnected { reason: "by request".into() }),
            Command::Send { .. }
            | Command::ProfileGet { .. }
            | Command::ProfileSet { .. }
            | Command::ProfileDecor { .. }
            | Command::AdminGet { .. }
            | Command::ChannelCreate { .. }
            | Command::ChannelPublish { .. }
            | Command::ChannelList
            | Command::ChannelFeed { .. }
            | Command::ChannelSubscribe { .. }
            | Command::ChannelFind { .. }
            | Command::ChannelDeletePost { .. }
            | Command::ChannelDelete { .. }
            | Command::ChannelUpdate { .. }
            | Command::ChannelAdmin { .. }
            | Command::AdminAction { .. }
            | Command::RecoverySetup { .. }
            | Command::DeleteMessage { .. }
            | Command::EditMessage { .. }
            | Command::Typing { .. }
            | Command::AccessSet { .. }
            | Command::PassInvite { .. }
            | Command::PassRevoke { .. }
            | Command::UsernameSet { .. }
            | Command::UsernameClear
            | Command::UsernameLookup { .. }
            | Command::RecoveryForget => {
                fail(&sink, "not_connected", "connect before using network features")
            }
            other => {
                // Досюда доходят только команды, которые уже забрал handle_local,
                // то есть не доходит ничего. Ветка явная, а не `_ => {}`: если
                // появится новая команда и её забудут развести, это будет видно
                // событием, а не тишиной — ровно так потерялся recovery_code.
                fail(&sink, "unhandled", &format!("команда не обработана: {other:?}"));
            }
        }
    }
}

/// Собирает то, что собеседники сравнивают между собой.
///
/// Два числа с разным назначением. `safety_number` считается от пары ключей
/// устройств и держится, пока ключи не сменились, — его сверяют один раз при
/// знакомстве. `epoch_code` выведен из секрета текущей эпохи MLS: он совпадает
/// у участников исправной беседы и меняется на каждом коммите, поэтому им
/// проверяют «мы прямо сейчас в одном состоянии».
fn verification(mls: &Mls, store: &Store, peer_device: &str) -> Event {
    let Ok(device) = hex::decode(peer_device) else {
        return failure("bad_device", "device must be hex");
    };
    let group = match store.conversation_with(&device) {
        Ok(Some(group)) => group,
        Ok(None) => return failure("no_conversation", "сверять нечего: беседа ещё не заведена"),
        Err(err) => return failure("storage", &err.to_string()),
    };
    let snapshot = match mls.inspect(&group) {
        Ok(snapshot) => snapshot,
        Err(err) => return failure("inspect", &err.to_string()),
    };

    Event::Verification {
        safety_number: keys::safety_number(&mls.device_pub(), &device),
        epoch: snapshot.epoch,
        epoch_code: keys::fingerprint(&snapshot.epoch_authenticator),
        members: snapshot.members.iter().map(hex::encode).collect(),
        peer_device: peer_device.to_owned(),
    }
}

/// Состав беседы обязан оставаться прежним: мы и тот, с кем переписываемся.
/// Лишний лист в диалоге один на один — это ровно то, как выглядит атака с
/// участием сервера.
fn check_membership(mls: &Mls, store: &Store, group_id: &[u8], sink: &EventSink) {
    let snapshot = match mls.inspect(group_id) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            sink(Event::Anomaly { kind: "inspect".into(), detail: err.to_string() });
            return;
        }
    };
    if snapshot.members.len() != 2 {
        sink(Event::Anomaly {
            kind: "member_set".into(),
            detail: format!("в беседе {} участников вместо двух", snapshot.members.len()),
        });
        return;
    }
    let Ok(Some(expected)) = store.peer_of_conversation(group_id) else { return };
    if !snapshot.members.iter().any(|member| member.as_slice() == expected.as_slice()) {
        sink(Event::Anomaly {
            kind: "peer_changed".into(),
            detail: "устройство собеседника в беседе не то, что было".into(),
        });
    }
}

/// Курсор страницы: `"<время>:<позиция>"`. Мусор трактуется как «с начала» —
/// пустой список выглядел бы для человека как потерянная переписка.
fn parse_cursor(raw: &Option<String>) -> Option<(i64, i64)> {
    let (time, seq) = raw.as_ref()?.split_once(':')?;
    Some((time.parse().ok()?, seq.parse().ok()?))
}

fn failure(code: &str, message: &str) -> Event {
    Event::Failed { code: code.to_owned(), message: message.to_owned() }
}

/// Кладёт восстановленную личность в пустую базу.
///
/// Ключ устройства создаётся новый: восстанавливается личность, а не старое
/// устройство. Занятую базу трогать нельзя — иначе восстановление затёрло бы
/// личность, которая там уже живёт, и человек потерял бы доступ вместо того,
/// чтобы его вернуть.
fn recover(store: &Store, code: &str) -> Result<()> {
    if store.has_credentials()? {
        return Err(CoreError::Rejected("identity_exists".into()));
    }
    let identity = crate::recovery::decode(code)?;
    store.save_credentials(&Credentials { identity, device: crate::keys::SecretKey::generate() })
}

/// Машиночитаемый повод отказа: интерфейсу нужно отличать опечатку в коде от
/// занятой базы.
fn recovery_code_of(error: &CoreError) -> &str {
    match error {
        CoreError::BadRecoveryCode(_) => "bad_recovery_code",
        // Сюда попадают и коды сервера: они уже машиночитаемые слаги.
        CoreError::Rejected(reason) => reason,
        _ => "recover",
    }
}

/// То же для входа по паролю. Отдельный код нужен интерфейсу: «не подошёл
/// пароль» и «код набран с ошибкой» ведут к разным экранам.
fn password_code_of(error: &CoreError) -> &str {
    match error {
        CoreError::BadRecoveryCode(_) => "bad_password",
        CoreError::Rejected(reason) => reason,
        _ => "recover",
    }
}

/// Убирает сообщение из локальной базы и сообщает об этом интерфейсу.
///
/// Возвращает устройство собеседника — оно понадобится, если удалить просят и
/// у него.
/// Заменяет тело у себя и сообщает, кому уходит просьба.
fn edit_locally(
    store: &Store,
    sink: &EventSink,
    conversation: &str,
    id: &str,
    body: &str,
) -> Result<Option<[u8; KEY_LEN]>> {
    let group = hex::decode(conversation).map_err(|_| CoreError::BadFrame)?;
    if store.update_message_by_id(&group, id, body.as_bytes())? {
        sink(Event::Edited {
            conversation: conversation.to_owned(),
            id: id.to_owned(),
            body: body.to_owned(),
        });
    }
    let peer = store
        .peer_of_conversation(&group)?
        .and_then(|raw| raw.try_into().ok());
    Ok(peer)
}

fn delete_locally(
    store: &Store,
    sink: &EventSink,
    conversation: &str,
    id: &str,
) -> Result<Option<[u8; KEY_LEN]>> {
    let group = hex::decode(conversation).map_err(|_| CoreError::BadFrame)?;
    if store.delete_message_by_id(&group, id)? {
        sink(Event::Deleted {
            conversation: conversation.to_owned(),
            ids: vec![id.to_owned()],
        });
    }
    let peer = store
        .peer_of_conversation(&group)?
        .and_then(|raw| raw.try_into().ok());
    Ok(peer)
}

/// Объявляет присутствие тем, кому это разрешено.
///
/// Правило «сейчас в сети» проверяется здесь, у отправителя: скрыть себя может
/// только тот, о ком речь. Тем, кому не разрешено, сигнал просто не уходит — и
/// у них не появится ни строчки о нас.
async fn announce_presence(
    socket: &mut Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    outbox: &mut Outbox,
) -> Result<()> {
    let privacy: crate::privacy::Privacy = store
        .load_setting(PRIVACY_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    let directory = load_directory(store);

    for (device, entry) in directory.entries.iter() {
        if !privacy.presence.permits(device, entry.standing.relation()) {
            continue;
        }
        let Ok(raw) = hex::decode(device) else { continue };
        let Ok(key): std::result::Result<[u8; KEY_LEN], _> = raw.clone().try_into() else { continue };
        // Без заведённой беседы канала нет, а заводить её ради статуса незачем.
        let Ok(Some(group_id)) = store.conversation_with(&raw) else { continue };

        let waiting = PendingSend {
            device: key,
            body: crate::access::presence_signal(),
            stored: true,
        };
        encrypt_and_send(socket, store, mls, sink, &group_id, waiting, outbox).await?;
    }
    Ok(())
}

/// Отправляет «печатает» собеседнику.
///
/// Сигнал едет обычным шифрованным конвертом: сервер видит непрозрачные байты и
/// о наборе текста не узнаёт ничего. Плата за это — лишний конверт, поэтому
/// интерфейс обязан слать сигнал редко, а не на каждую букву.
#[allow(clippy::too_many_arguments)]
async fn send_typing(
    socket: &mut Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    recipient_device: &str,
    active: bool,
    outbox: &mut Outbox,
) -> Result<()> {
    let device = hex::decode(recipient_device).map_err(|_| CoreError::BadFrame)?;
    let device: [u8; KEY_LEN] = device.try_into().map_err(|_| CoreError::BadKeyLength)?;

    // Беседы ещё нет — и сообщать нечего: заводить её ради индикатора набора
    // текста было бы странно.
    let Some(group_id) = store.conversation_with(&device)? else { return Ok(()) };

    let waiting = PendingSend {
        device,
        body: crate::access::typing_signal(active),
        stored: true,
    };
    encrypt_and_send(socket, store, mls, sink, &group_id, waiting, outbox).await
}

/// Приводит выданные пропуска в соответствие с правилом.
///
/// В обе стороны: кому полагается и не выдан — выдаём, у кого есть и больше не
/// полагается — отзываем. Сверка идёт при каждом подключении, поэтому включение
/// политики никого не отрезает (знакомые получают пропуска тем же заходом), а
/// сужение круга или блокировка действительно закрывают дверь, а не оставляют
/// её приоткрытой старым пропуском.
///
/// Пропуск уезжает служебным сообщением внутри шифрованного канала — сервер
/// видит только очередной непрозрачный конверт. Тем, с кем беседа ещё не
/// заведена, выдача откладывается: без канала передать секрет некуда, а
/// отправлять его в открытую нельзя.
async fn grant_missing(
    socket: &mut Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    live: &mut Live,
) -> Result<()> {
    let mut access = load_access(store);
    let peers = deserving(store);
    let mut changed = false;

    // Сначала отбираем у тех, кому больше не полагается.
    let stale: Vec<String> = access
        .granted
        .keys()
        .filter(|device| !peers.contains(*device))
        .cloned()
        .collect();
    for device in stale {
        if let Some(hash) = access.take_grant(&device) {
            send(socket, proto::pass_revoke_frame(&hash)?).await?;
            changed = true;
        }
    }

    for device in access.missing_grants(peers.iter()) {
        let Ok(raw) = hex::decode(&device) else { continue };
        let Ok(key): std::result::Result<[u8; KEY_LEN], _> = raw.clone().try_into() else { continue };
        // Беседы нет — значит и канала нет. Выдадим, когда она появится.
        let Ok(Some(group_id)) = store.conversation_with(&raw) else { continue };

        let (pass, hash) = crate::access::new_pass();
        send(socket, proto::pass_create_frame(&hash, false, 0)?).await?;

        let waiting = PendingSend {
            device: key,
            body: crate::access::pass_gift(&pass),
            // Служебное сообщение в переписку не кладётся.
            stored: true,
        };
        encrypt_and_send(socket, store, mls, sink, &group_id, waiting, &mut live.outbox).await?;

        access.remember_grant(&device, &hash);
        changed = true;
    }

    // Ключ от аватара — тем же, кому и пропуск, и тем же каналом. Один раз на
    // собеседника: отметка о выданном лежит в настройках, поэтому переподключение
    // не превращается в рассылку.
    if avatar_is_private(store) {
        let key = own_profile_key(store)?;
        let mut sent: std::collections::BTreeSet<String> = store
            .load_setting(PROFILE_KEY_SENT)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();

        let mut shared = false;
        for device in &peers {
            if sent.contains(device) {
                continue;
            }
            let Ok(raw) = hex::decode(device) else { continue };
            let Ok(peer): std::result::Result<[u8; KEY_LEN], _> = raw.clone().try_into() else {
                continue;
            };
            let Ok(Some(group_id)) = store.conversation_with(&raw) else { continue };

            let waiting = PendingSend {
                device: peer,
                body: crate::access::profile_key_gift(&hex::encode(key)),
                stored: true,
            };
            encrypt_and_send(socket, store, mls, sink, &group_id, waiting, &mut live.outbox)
                .await?;
            sent.insert(device.clone());
            shared = true;
        }
        if shared {
            store.save_setting(PROFILE_KEY_SENT, &serde_json::to_vec(&sent)?)?;
        }
    }

    if changed {
        save_access(store, &access)?;
        sink(access_event(store));
    }
    Ok(())
}

/// Готовит кадр с запечатанной личностью и канонический логин для события.
///
/// Пароль отсюда не уходит никуда, кроме Argon2id: на сервер отправляются
/// только хеш логина, хеш доказательства и шифротекст.
fn seal_recovery(
    store: &Store,
    login: &str,
    password: &str,
    totp: Option<&str>,
    code: Option<&str>,
) -> Result<(String, Vec<u8>)> {
    let credentials = store.load_credentials()?;
    let sealed = crate::passphrase::seal(login, password, &credentials.identity)?;
    let frame = proto::recovery_set_frame(
        &sealed.login_id,
        &crate::passphrase::verifier(&sealed.token),
        &sealed.sealed,
        totp,
        code,
    )?;
    Ok((crate::passphrase::normalize_login(login)?, frame))
}

/// Кладёт в пустую базу личность, распечатанную по логину и паролю.
async fn recover_with_password(
    store: &Store,
    url: &str,
    login: &str,
    password: &str,
    code: Option<&str>,
) -> Result<()> {
    if store.has_credentials()? {
        return Err(CoreError::Rejected("identity_exists".into()));
    }
    let identity = fetch_sealed_identity(url, login, password, code).await?;
    store.save_credentials(&Credentials { identity, device: keys::SecretKey::generate() })
}

/// Забирает запечатанную личность до всякой аутентификации.
///
/// Это единственный разговор с сервером без ключей, и иначе быть не может:
/// тому, кто потерял устройство, подписываться нечем. Поэтому обмен короткий и
/// одноразовый — соединение закрывается сразу после ответа, а дальше вход идёт
/// обычным путём, уже восстановленным ключом.
///
/// Argon2id считается здесь же и блокирует поток ядра примерно на секунду.
/// Это осознанно: параллельно всё равно ничего не происходит, а вынос в
/// отдельный поток стоил бы `block_in_place`, которого на однопоточном
/// рантайме нет.
async fn fetch_sealed_identity(
    url: &str,
    login: &str,
    password: &str,
    code: Option<&str>,
) -> Result<keys::SecretKey> {
    let (login_id, token, key) = crate::passphrase::request(login, password)?;

    let (mut socket, _) = connect_async(crate::edge::ws_request(url)?)
        .await
        .map_err(|err| CoreError::Transport(err.to_string()))?;
    send(&mut socket, proto::recovery_get_frame(&login_id, &token, code)?).await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let sealed = loop {
        let message = tokio::time::timeout_at(deadline, socket.next())
            .await
            .map_err(|_| CoreError::Transport("сервер не ответил".into()))?
            .ok_or_else(|| CoreError::Transport("соединение закрыто".into()))?
            .map_err(|err| CoreError::Transport(err.to_string()))?;

        let Message::Binary(data) = message else { continue };
        let (opcode, body) = proto::split(&data)?;
        match opcode {
            op::RECOVERY_BLOB => {
                let blob: proto::RecoveryBlob = proto::parse_json(body)?;
                break hex::decode(&blob.sealed).map_err(|_| CoreError::BadFrame)?;
            }
            op::ERROR => {
                let error: ServerError = proto::parse_json(body)?;
                return Err(CoreError::Rejected(error.code));
            }
            // HELLO и прочее по дороге — не наше дело.
            _ => {}
        }
    };
    let _ = socket.close(None).await;

    crate::passphrase::open(&key, &login_id, &sealed)
}

/// Ключ, под которым правила приватности лежат в запечатанной базе.
const PRIVACY_KEY: &str = "privacy";
/// Книга отношений: кто контакт, кто ждёт решения, кто заблокирован.
const DIRECTORY_KEY: &str = "directory";
/// Политика доступа, выданные и полученные пропуска.
const ACCESS_KEY: &str = "access";
/// Свой юзернейм. На сервере лежит только его хеш, читаемое имя — здесь.
const USERNAME_KEY: &str = "username";
/// Закреплённые ключи: под каким ключом мы видели каждое имя.
const PINS_KEY: &str = "pins";
/// Свой ключ профиля: им запечатан наш аватар.
const PROFILE_KEY: &str = "profile_key";
/// Ключи профилей собеседников: device в hex → ключ в hex.
const PEER_PROFILE_KEYS: &str = "peer_profile_keys";
/// Кому наш ключ профиля уже отправлен.
const PROFILE_KEY_SENT: &str = "profile_key_sent";

/// Свой юзернейм из локальной базы.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct OwnUsername {
    #[serde(default)]
    name: Option<String>,
    #[serde(default = "yes")]
    discoverable: bool,
    /// Занято ли имя дорогим хешем. У баз, заведённых раньше, поля нет — и
    /// `false` здесь правильное значение: оно означает «ещё не занимали».
    #[serde(default)]
    strong_hash: bool,
}

fn yes() -> bool {
    true
}

fn load_username(store: &Store) -> OwnUsername {
    store
        .load_setting(USERNAME_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn username_event(store: &Store) -> Event {
    let own = load_username(store);
    Event::Username { name: own.name, discoverable: own.discoverable }
}

/// Книга отношений. Испорченная запись не должна лишать доступа к настройкам:
/// в этом случае берётся пустая — все становятся незнакомцами, а это
/// безопасная сторона ошибки, а не разрешающая.
/// Закрепления. Испорченная запись означает «ничего не помним»: это заставит
/// закрепить ключи заново, но не пропустит подмену молча под видом знакомого.
/// Перезанимает своё имя, добавляя к нему дорогой хеш.
///
/// Ничего не делает, если имени нет или это уже сделано.
async fn upgrade_username_hash(
    socket: &mut Socket,
    store: &Store,
    sink: &EventSink,
) -> Result<()> {
    let mut own = load_username(store);
    let Some(name) = own.name.clone() else { return Ok(()) };
    if own.strong_hash {
        return Ok(());
    }

    let normalized = match crate::directory::normalize_username(&name) {
        Ok(normalized) => normalized,
        // Имя, которое больше не проходит проверку, перезанимать нечем.
        // Это не повод рвать соединение — человек сменит его сам.
        Err(_) => return Ok(()),
    };
    let hash = crate::directory::username_hash(&normalized);
    let hash2 = crate::directory::username_hash_v2(&normalized)?;
    send(socket, proto::username_set_frame(&hash, &hash2, own.discoverable)?).await?;

    own.strong_hash = true;
    if let Err(err) = store.save_setting(USERNAME_KEY, &serde_json::to_vec(&own)?) {
        fail(sink, "storage", &err.to_string());
    }
    Ok(())
}

/// Свой ключ профиля, заводится при первом обращении.
fn own_profile_key(store: &Store) -> Result<[u8; 32]> {
    if let Some(raw) = store.load_setting(PROFILE_KEY)? {
        if let Ok(key) = <[u8; 32]>::try_from(raw.as_slice()) {
            return Ok(key);
        }
    }
    let key = crate::profile::new_key();
    store.save_setting(PROFILE_KEY, &key)?;
    Ok(key)
}

/// Ключи профилей собеседников. Испорченная запись означает «ключей нет»:
/// аватары просто не покажутся, и это безопасная сторона ошибки.
fn load_peer_profile_keys(store: &Store) -> std::collections::BTreeMap<String, String> {
    store
        .load_setting(PEER_PROFILE_KEYS)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

/// Открывает аватар, если он запечатан и ключ от него у нас есть.
///
/// Возвращает `None`, когда открыть нечем: аватара для нас просто нет, и
/// показать надо инициалы, а не сломанную картинку. Так же выглядит и случай,
/// когда человек убрал нас из контактов и сменил ключ.
fn unseal_avatar(
    store: &Store,
    device: Option<&str>,
    mime: Option<String>,
    data: Option<String>,
) -> (Option<String>, Option<String>) {
    if !crate::profile::is_sealed(mime.as_deref()) {
        return (mime, data);
    }
    let (Some(device), Some(data)) = (device, data) else {
        return (None, None);
    };
    let keys = load_peer_profile_keys(store);
    let Some(key_hex) = keys.get(device) else { return (None, None) };
    let Ok(key) = hex::decode(key_hex) else { return (None, None) };
    match crate::profile::open(&key, &data) {
        Ok((mime, data)) => (Some(mime), Some(data)),
        Err(_) => (None, None),
    }
}

fn load_pins(store: &Store) -> crate::pins::Pins {
    store
        .load_setting(PINS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_pins(store: &Store, pins: &crate::pins::Pins) -> Result<()> {
    store.save_setting(PINS_KEY, &serde_json::to_vec(pins)?)
}

fn load_directory(store: &Store) -> crate::directory::Directory {
    store
        .load_setting(DIRECTORY_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_directory(store: &Store, directory: &crate::directory::Directory) -> Result<()> {
    store.save_setting(DIRECTORY_KEY, &serde_json::to_vec(directory)?)
}

fn load_access(store: &Store) -> crate::access::Access {
    store
        .load_setting(ACCESS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_access(store: &Store, access: &crate::access::Access) -> Result<()> {
    store.save_setting(ACCESS_KEY, &serde_json::to_vec(access)?)
}

fn access_event(store: &Store) -> Event {
    let access = load_access(store);
    Event::Access {
        policy: access.policy,
        invites: access.invites.clone(),
        granted: access.granted.len(),
    }
}

/// Кому полагается пропуск.
///
/// Решает то же самое правило «личные сообщения», по которому интерфейс рисует
/// настройку, — вместе с именными исключениями. Благодаря этому «всегда
/// разрешать» действительно выдаёт пропуск, а «никогда» его отбирает, и
/// поведение не расходится с тем, что человек видит на экране.
/// Стоит ли прятать аватар от сервера.
///
/// Решает то же правило, которым человек уже пользуется: «аватар видят все» —
/// прятать не от кого, всё остальное — прятать. Отдельной настройки нет
/// намеренно: две настройки об одном и том же расходятся, и объяснить разницу
/// потом невозможно.
fn avatar_is_private(store: &Store) -> bool {
    let privacy: crate::privacy::Privacy = store
        .load_setting(PRIVACY_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    privacy.profile_avatar.scope != crate::privacy::Scope::Everyone
}

fn deserving(store: &Store) -> Vec<String> {
    let privacy: crate::privacy::Privacy = store
        .load_setting(PRIVACY_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    let rule = &privacy.direct_messages;

    load_directory(store)
        .entries
        .iter()
        .filter(|(device, entry)| rule.permits(device, entry.standing.relation()))
        .map(|(device, _)| device.clone())
        .collect()
}

fn blocked(store: &Store, device: &str) -> bool {
    load_directory(store).is_blocked(device)
}

/// Заводит запрос на незнакомца, написавшего первым.
///
/// Без этого раздел «Запросы» оставался бы пустым: записи неоткуда взяться,
/// пока человек сам кого-то не добавил. Уже знакомых — контактов, одобренных,
/// отклонённых — не трогаем: их положение решено, и переписка не должна
/// возвращать их в очередь на рассмотрение.
fn remember_stranger(store: &Store, sink: &EventSink, device: &str, origin: &str) {
    let mut directory = load_directory(store);
    if directory.standing(device).is_some() {
        return;
    }
    let now = now_millis();
    directory.set(device, crate::directory::Standing::Pending, now);
    directory.note(device, None, Some(origin.to_owned()), now);
    if save_directory(store, &directory).is_ok() {
        sink(directory_event(store));
    }
}

fn directory_event(store: &Store) -> Event {
    let directory = load_directory(store);
    Event::Directory {
        entries: directory
            .entries
            .iter()
            .map(|(device, entry)| crate::command::DirectoryItem {
                device: device.clone(),
                standing: entry.standing,
                display_name: entry.display_name.clone(),
                username: entry.username.clone(),
                origin: entry.origin.clone(),
                noted_at: entry.noted_at,
            })
            .collect(),
    }
}

/// Правила из базы либо значения по умолчанию.
///
/// Испорченная запись не должна запирать человека снаружи собственных
/// настроек: в этом случае берётся набор по умолчанию — он безопасный, а не
/// разрешающий, — и правила можно перезадать.
fn privacy_event(store: &Store) -> Event {
    let privacy = store
        .load_setting(PRIVACY_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    Event::Privacy { privacy }
}

/// Свой адрес нужен интерфейсу до всякого подключения: его показывают
/// собеседнику, чтобы тот мог написать первым.
fn status(store: &Store) -> Event {
    match store.load_credentials() {
        Ok(credentials) => Event::Status {
            has_identity: true,
            identity: hex::encode(credentials.identity_pub()),
            device: hex::encode(credentials.device_pub()),
        },
        Err(_) => Event::Status { has_identity: false, identity: String::new(), device: String::new() },
    }
}

/// Держит соединение и переподключается, пока не придёт Disconnect.
async fn session(
    url: &str,
    entry: Entry,
    store: &Store,
    sink: &EventSink,
    commands: &mut mpsc::UnboundedReceiver<Command>,
) {
    let credentials = match load_or_create(store, &entry) {
        Ok(credentials) => credentials,
        Err(err) => return fail(sink, "keys", &err.to_string()),
    };
    let mut mls = match load_or_create_mls(store, &credentials) {
        Ok(mls) => mls,
        Err(err) => return fail(sink, "mls", &err.to_string()),
    };

    let mut entry = entry;
    let mut backoff = 1u64;
    let mut live = Live::default();

    loop {
        // Дошли ли мы в этот раз до рабочего состояния. Нужно, чтобы отличить
        // «сервер недоступен» от «связь была и оборвалась».
        let mut established = false;

        match connect_once(
            url, &credentials, &entry, store, &mut mls, sink, commands, &mut live, &mut established,
        )
        .await
        {
            Ok(Outcome::Closed) => return,
            Ok(Outcome::Retry) => {}
            Err(CoreError::Rejected(code)) => {
                // Отказ сервера повтором не лечится: ждём новой команды.
                fail(sink, &code, "server rejected the entry attempt");
                return;
            }
            Err(err) => sink(Event::Disconnected { reason: err.to_string() }),
        }

        // Второй заход уже не регистрирует: личность на сервере есть.
        entry = Entry::Existing;

        // Задержка растёт только пока сервер недостижим. Разрыв уже рабочего
        // соединения — обычное дело за Cloudflare, и наказывать за него
        // минутой ожидания нельзя: именно так «доставка в реальном времени»
        // превращается в «увижу после перезапуска».
        if established {
            backoff = 1;
        }
        if wait_before_retry(backoff, store, sink, commands).await == Pause::Closed {
            return;
        }
        if !established {
            backoff = (backoff * 2).min(MAX_BACKOFF_SEC);
        }
    }
}

#[derive(PartialEq, Eq)]
enum Pause {
    /// Пауза кончилась — пробуем снова.
    Elapsed,
    /// Интерфейс попросил закончить.
    Closed,
}

/// Пауза между попытками, которая слышит интерфейс.
///
/// Раньше здесь стоял простой сон, и всё это время ядро не читало команды
/// вовсе. Стоило телефону уснуть и потерять связь, как заново открытый экран
/// не получал ответа даже на вопрос «кто я» и висел на заставке до конца
/// паузы — а она растёт до минуты. Выглядело это как намертво зависшее
/// приложение, хотя ядро просто ждало.
///
/// Поэтому во время паузы отвечаем на всё, что можно ответить без сети, а
/// просьбу подключиться понимаем как «попробуй прямо сейчас».
async fn wait_before_retry(
    seconds: u64,
    store: &Store,
    sink: &EventSink,
    commands: &mut mpsc::UnboundedReceiver<Command>,
) -> Pause {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Pause::Elapsed,
            command = commands.recv() => {
                let Some(command) = command else { return Pause::Closed };
                if handle_local(&command, store, sink) {
                    continue;
                }
                match command {
                    // «Подключись» во время паузы — это «не жди, попробуй сейчас».
                    Command::Connect { .. } => return Pause::Elapsed,
                    Command::Disconnect => {
                        sink(Event::Disconnected { reason: "by request".into() });
                        return Pause::Closed;
                    }
                    other => {
                        let _ = other;
                        fail(sink, "not_connected", "нет связи с сервером, пробуем ещё раз");
                    }
                }
            }
        }
    }
}

enum Outcome {
    /// UI попросил отключиться.
    Closed,
    /// Соединение оборвалось — переподключаемся.
    Retry,
}

/// Итог рукопожатия: с чем мы остались на этом соединении.
enum Handshake {
    /// `key_packages` — сколько наших пакетов сервер уже держит. `None` —
    /// сервер старый и числа не сообщает. `device_id` и `admin` хранятся, чтобы
    /// ответить на повторный вопрос «кто я» без нового рукопожатия.
    Authenticated { key_packages: Option<usize>, device_id: String, admin: bool },
    /// Счёт выставлен, ждём оплаты — писать ещё нельзя.
    #[cfg(feature = "ton")]
    InvoicePending,
}

fn load_or_create(store: &Store, entry: &Entry) -> Result<Credentials> {
    if store.has_credentials()? {
        return store.load_credentials();
    }
    if matches!(entry, Entry::Existing) {
        return Err(CoreError::NoCredentials);
    }
    let credentials = Credentials::generate();
    store.save_credentials(&credentials)?;
    Ok(credentials)
}

fn load_or_create_mls(store: &Store, credentials: &Credentials) -> Result<Mls> {
    match store.load_mls()? {
        Some((signer_public, snapshot)) => Mls::restore(&credentials.device, &signer_public, &snapshot),
        None => {
            let mls = Mls::create(&credentials.device)?;
            store.save_mls(&mls.signer_public(), &mls.snapshot())?;
            Ok(mls)
        }
    }
}

/// Снимок состояния MLS переживает любое изменение: пропущенная запись — это
/// потерянная эпоха и нерасшифровываемая переписка после перезапуска.
fn persist(store: &Store, mls: &Mls, sink: &EventSink) {
    if let Err(err) = store.save_mls(&mls.signer_public(), &mls.snapshot()) {
        fail(sink, "mls_persist", &err.to_string());
    }
}

/// Что сервер сообщил о себе при встрече.
///
/// Хранится на всё соединение: те же слова понадобятся ещё раз, когда экран
/// пересоздадут и он спросит, где мы. Придумывать ответ заново нельзя — про
/// возможности сервера знает только его приветствие.
#[derive(Clone, Copy)]
struct Greeting {
    heartbeat_sec: u64,
    invite_entry: bool,
    ton_entry: bool,
    profiles: bool,
    decor: bool,
}

#[allow(clippy::too_many_arguments)]
async fn connect_once(
    url: &str,
    credentials: &Credentials,
    entry: &Entry,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    live: &mut Live,
    established: &mut bool,
) -> Result<Outcome> {
    // Заголовки Cloudflare Access, если сборка их знает: без них закрытый
    // периметр пришлось бы держать выключенным (§10.1).
    let (mut socket, _) = connect_async(crate::edge::ws_request(url)?)
        .await
        .map_err(|err| CoreError::Transport(err.to_string()))?;

    let hello = expect_hello(&mut socket, sink).await?;
    let heartbeat = if hello.heartbeat_sec == 0 { FALLBACK_HEARTBEAT_SEC } else { hello.heartbeat_sec };

    let nonce = hex::decode(&hello.nonce).map_err(|_| CoreError::BadFrame)?;
    let handshake = handshake(&mut socket, credentials, entry, nonce, sink).await?;
    *established = true;

    let greeting = Greeting {
        heartbeat_sec: heartbeat,
        invite_entry: hello.entry.invite,
        ton_entry: hello.entry.ton,
        profiles: hello.features.profiles,
        decor: hello.features.decor,
    };

    pump(socket, store, mls, sink, commands, greeting, handshake, live).await
}

async fn expect_hello(socket: &mut Socket, sink: &EventSink) -> Result<Hello> {
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| CoreError::Transport("closed before hello".into()))?
            .map_err(|err| CoreError::Transport(err.to_string()))?;

        if let Message::Binary(data) = message {
            let (opcode, body) = proto::split(&data)?;
            if opcode != op::HELLO {
                return Err(CoreError::UnknownOpcode(opcode));
            }
            let hello: Hello = proto::parse_json(body)?;
            sink(Event::Connected {
                heartbeat_sec: hello.heartbeat_sec,
                invite_entry: hello.entry.invite,
                ton_entry: hello.entry.ton,
                profiles: hello.features.profiles,
                decor: hello.features.decor,
            });
            return Ok(hello);
        }
    }
}

/// Проходит AUTH или PAY_REQUEST.
#[cfg_attr(not(feature = "ton"), allow(unused_mut))]
async fn handshake(
    socket: &mut Socket,
    credentials: &Credentials,
    entry: &Entry,
    mut nonce: Vec<u8>,
    sink: &EventSink,
) -> Result<Handshake> {
    let identity = hex::encode(credentials.identity_pub());
    let device = hex::encode(credentials.device_pub());
    let cert = hex::encode(credentials.device_cert());

    let build = |nonce: &[u8], entry: &Entry| -> AuthRequest {
        let (invite, payment_ref, handle) = match entry {
            Entry::Register { handle, invite, payment_ref } => {
                (invite.clone(), payment_ref.clone(), handle.clone())
            }
            _ => (None, None, None),
        };
        AuthRequest {
            v: 1,
            identity: identity.clone(),
            device: device.clone(),
            device_cert: cert.clone(),
            sig: hex::encode(credentials.auth_signature(nonce)),
            invite,
            payment_ref,
            handle,
        }
    };

    #[cfg(feature = "ton")]
    let opcode = if matches!(entry, Entry::Invoice) { op::PAY_REQUEST } else { op::AUTH };
    #[cfg(not(feature = "ton"))]
    let opcode = op::AUTH;

    send(socket, proto::json_frame(opcode, &build(&nonce, entry))?).await?;

    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| CoreError::Transport("closed during handshake".into()))?
            .map_err(|err| CoreError::Transport(err.to_string()))?;

        let Message::Binary(data) = message else { continue };
        let (opcode, body) = proto::split(&data)?;
        match opcode {
            op::AUTH_OK => {
                let ok: AuthOk = proto::parse_json(body)?;
                sink(Event::Authenticated {
                    device_id: ok.device_id.clone(),
                    queued: ok.queued,
                    admin: ok.admin,
                });
                sink(Event::Registered { identity, device });
                return Ok(Handshake::Authenticated {
                    key_packages: ok.key_packages,
                    device_id: ok.device_id,
                    admin: ok.admin,
                });
            }
            #[cfg(feature = "ton")]
            op::PAY_INFO => {
                let info: PayInfo = proto::parse_json(body)?;
                nonce = hex::decode(&info.nonce).map_err(|_| CoreError::BadFrame)?;
                let _ = &nonce;
                sink(Event::Invoice {
                    reference: info.reference,
                    address: info.address,
                    amount_nano: info.amount_nano,
                    expires_at: info.expires_at,
                    paid: info.paid,
                });
                return Ok(Handshake::InvoicePending);
            }
            op::AUTH_ERR => {
                let err: AuthErr = proto::parse_json(body)?;
                sink(Event::Failed { code: err.code.clone(), message: err.message });
                return Err(CoreError::Rejected(err.code));
            }
            op::ERROR => {
                let err: ServerError = proto::parse_json(body)?;
                sink(Event::Failed { code: err.code.clone(), message: err.message });
                return Err(CoreError::Rejected(err.code));
            }
            // Всё остальное на этом шаге неинтересно: ждём своего ответа
            // дальше. Рвать рукопожатие из-за постороннего кадра нельзя —
            // сервер вправе прислать что-то, чего эта версия ещё не знает.
            _ => {}
        }
    }
}

/// Рабочий цикл соединения: входящие кадры, команды UI и heartbeat.
async fn pump(
    mut socket: Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    greeting: Greeting,
    handshake: Handshake,
    live: &mut Live,
) -> Result<Outcome> {
    let authenticated = matches!(handshake, Handshake::Authenticated { .. });
    let device_id = match &handshake {
        Handshake::Authenticated { device_id, .. } => device_id.clone(),
        #[cfg(feature = "ton")]
        Handshake::InvoicePending => String::new(),
    };
    let admin = matches!(&handshake, Handshake::Authenticated { admin: true, .. });
    let mut pending: HashMap<[u8; ID_LEN], Claim> = HashMap::new();
    // Логин, посылку по которому сервер ещё не подтвердил. Пустое значение при
    // RECOVERY_OK означает, что подтверждают удаление, а не установку.
    // Логин и «включался ли второй фактор» — чтобы ответить о том, что
    // именно сохранилось, а не просто «сохранено».
    let mut pending_recovery: Option<(String, bool)> = None;
    // Имя, которое сервер ещё не подтвердил, и имя, по которому идёт поиск.
    // Сервер видит только хеши и вернуть читаемое имя не может — его помнит
    // эта сторона.
    let mut pending_username: Option<(String, bool)> = None;
    let mut looking_for: Option<String> = None;

    if authenticated {
        // Докладываем ровно недостающее. Раньше полная пачка уходила на каждый
        // вход: пакеты копились, упирались в потолок хранилища, и сервер начинал
        // рвать соединение на каждом подключении — связь не жила дольше одного
        // захода. Старый сервер числа не сообщает, тогда ведём себя как прежде.
        let stored = match &handshake {
            Handshake::Authenticated { key_packages, .. } => key_packages.unwrap_or(0),
            #[cfg(feature = "ton")]
            Handshake::InvoicePending => 0,
        };
        let needed = KEY_PACKAGES_PER_CONNECT.saturating_sub(stored);

        // Без выложенных KeyPackages нам просто некому написать первым.
        if needed > 0 {
            match mls.key_packages(needed) {
                Ok(packages) => {
                    send(&mut socket, proto::keypkg_publish_frame(&packages)).await?;
                    persist(store, mls, sink);
                }
                Err(err) => fail(sink, "mls_key_packages", &err.to_string()),
            }
        }

        // Предъявляем всё, что нам выдали: допуск живёт только в пределах
        // соединения, поэтому повторять его надо на каждом заходе.
        for (recipient, pass) in load_access(store).to_present() {
            send(&mut socket, proto::pass_present_frame(&recipient, &pass)?).await?;
        }

        // Выдаём пропуска тем, кому они полагаются, но ещё не достались.
        // Сверка идёт при каждом подключении, поэтому включение политики никого
        // не отрезает: знакомые получают пропуска тем же заходом. Это же чинит
        // и выдачу, прерванную обрывом связи.
        // Пропуск — любезность, а не условие переписки: его неудача не повод
        // рвать связь. Обрыв разберётся сам на следующей отправке.
        if let Err(err) = grant_missing(&mut socket, store, mls, sink, live).await {
            fail(sink, "pass_grant", &err.to_string());
        }

        // Дозанимаем своё имя дорогим хешем, если этого ещё не делали.
        //
        // Сервер не может пересчитать хеш сам — имени он не знает и знать не
        // должен. Значит, обновить строку способен только тот, у кого имя
        // есть, то есть клиент, и делает он это молча при первом же заходе
        // после обновления. Один раз: отметка лежит рядом с самим именем.
        if let Err(err) = upgrade_username_hash(&mut socket, store, sink).await {
            if is_transport(&err) {
                return Ok(Outcome::Retry);
            }
            fail(sink, "username_upgrade", &err.to_string());
        }

        // Объявляемся тем, кому это разрешено правилом «сейчас в сети».
        if let Err(err) = announce_presence(&mut socket, store, mls, sink, &mut live.outbox).await {
            fail(sink, "presence", &err.to_string());
        }

        // То, что не ушло из-за обрыва. Досылаем до всего остального: порядок
        // сообщений для человека важнее, чем свежесть.
        for waiting in std::mem::take(&mut live.outbox) {
            if let Err(err) =
                deliver(&mut socket, store, mls, sink, &mut pending, waiting, &mut live.outbox).await
            {
                if is_transport(&err) {
                    return Ok(Outcome::Retry);
                }
                fail(sink, "send", &err.to_string());
            }
        }
    }

    let mut ticker = tokio::time::interval(Duration::from_secs(greeting.heartbeat_sec));
    ticker.tick().await; // первый тик срабатывает сразу — пропускаем

    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(message) = incoming else { return Ok(Outcome::Retry) };
                let message = message.map_err(|err| CoreError::Transport(err.to_string()))?;

                // Закрытие сервером надо заметить здесь. Дальше сокет только
                // выглядит живым: отправка в него вернёт «sending after
                // closing», а мы будем считать, что всё в порядке, — и
                // доставка встанет до перезапуска.
                if let Message::Close(frame) = &message {
                    let reason = frame
                        .as_ref()
                        .map(|f| f.reason.to_string())
                        .filter(|reason| !reason.is_empty())
                        .unwrap_or_else(|| "сервер закрыл соединение".into());
                    sink(Event::Disconnected { reason });
                    return Ok(Outcome::Retry);
                }

                if let Message::Binary(data) = message {
                    // Ответ на восстановление разбирается здесь, а не в on_frame:
                    // логин знает только эта сторона — сервер его не видел.
                    if matches!(proto::split(&data), Ok((op::USERNAME_OK, _))) {
                        let own = match pending_username.take() {
                            // Имя, занятое этим клиентом, всегда занято обеими
                            // формами хеша: дозанимать его потом не нужно.
                            Some((name, discoverable)) => OwnUsername {
                                name: Some(name),
                                discoverable,
                                strong_hash: true,
                            },
                            None => OwnUsername {
                                name: None,
                                discoverable: true,
                                strong_hash: false,
                            },
                        };
                        match serde_json::to_vec(&own)
                            .map_err(CoreError::from)
                            .and_then(|raw| store.save_setting(USERNAME_KEY, &raw))
                        {
                            Ok(()) => sink(Event::Username {
                                name: own.name,
                                discoverable: own.discoverable,
                            }),
                            Err(err) => fail(sink, "storage", &err.to_string()),
                        }
                        continue;
                    }
                    if matches!(proto::split(&data), Ok((op::USERNAME_FOUND, _))) {
                        let (_, body) = proto::split(&data)?;
                        let found: proto::UsernameFound = proto::parse_json(body)?;
                        let query = looking_for.take().unwrap_or_default();
                        let device = if found.found { found.device } else { None };

                        // Ответ сервера сверяется с тем, что мы помним об этом
                        // имени. Промолчать здесь нельзя: подмена ключа до
                        // первого письма выглядит ровно как обычная находка.
                        let pin = match (&query.is_empty(), &device) {
                            (false, Some(device)) => {
                                let mut pins = load_pins(store);
                                let state = pins.check(&query, device, now_millis());
                                if state != crate::pins::PinState::Same {
                                    if let Err(err) = save_pins(store, &pins) {
                                        fail(sink, "storage", &err.to_string());
                                    }
                                }
                                if state == crate::pins::PinState::Changed {
                                    sink(Event::Anomaly {
                                        kind: "pinned_key_changed".into(),
                                        detail: format!(
                                            "у имени @{query} другой ключ устройства, чем прежде",
                                        ),
                                    });
                                }
                                Some(state)
                            }
                            _ => None,
                        };

                        let (avatar_mime, avatar_base64) = unseal_avatar(
                            store,
                            device.as_deref(),
                            found.avatar_mime,
                            found.avatar_base64,
                        );
                        sink(Event::UsernameFound {
                            query,
                            device,
                            pin,
                            chat_code: found.chat_code,
                            avatar_mime,
                            avatar_base64,
                            emblem: found.emblem,
                            color: found.color,
                        });
                        continue;
                    }
                    if matches!(proto::split(&data), Ok((op::RECOVERY_OK, _))) {
                        match pending_recovery.take() {
                            Some((login, totp)) => sink(Event::RecoverySaved { login, totp }),
                            None => sink(Event::RecoveryForgotten),
                        }
                        continue;
                    }
                    if let Err(err) =
                        on_frame(&mut socket, &data, store, mls, sink, &mut pending, live).await
                    {
                        // Битый кадр — рвём соединение, а не гадаем.
                        sink(Event::Disconnected { reason: err.to_string() });
                        return Ok(Outcome::Retry);
                    }
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { return Ok(Outcome::Closed) };

                // Локальные команды отвечают одинаково, подключены мы или нет.
                if handle_local(&command, store, sink) {
                    continue;
                }

                match command {
                    Command::Disconnect => {
                        let _ = socket.close(None).await;
                        sink(Event::Disconnected { reason: "by request".into() });
                        return Ok(Outcome::Closed);
                    }
                    Command::Verify { peer_device } => {
                        // Здесь MLS живой, поэтому эпоха свежая — в отличие от
                        // сверки вне соединения, где состояние поднимается из снимка.
                        sink(verification(mls, store, &peer_device));
                    }
                    Command::DeleteMessage { conversation, id, for_both } => {
                        match delete_locally(store, sink, &conversation, &id) {
                            Ok(peer) => {
                                // Просьба уходит после удаления у себя: если
                                // связь оборвётся, у нас оно уже исчезло, а
                                // повторить просьбу человек сможет.
                                if for_both {
                                    if let Some(device) = peer {
                                        let body = crate::access::delete_request(&[id.clone()]);
                                        let waiting = PendingSend { device, body, stored: true };
                                        if let Err(err) = deliver(
                                            &mut socket, store, mls, sink, &mut pending, waiting,
                                            &mut live.outbox,
                                        ).await {
                                            if is_transport(&err) {
                                                return Ok(Outcome::Retry);
                                            }
                                            fail(sink, "delete_request", &err.to_string());
                                        }
                                    }
                                }
                            }
                            Err(err) => fail(sink, "storage", &err.to_string()),
                        }
                    }
                    Command::EditMessage { conversation, id, body, for_both } => {
                        match edit_locally(store, sink, &conversation, &id, &body) {
                            Ok(peer) => {
                                // Как и с удалением: сначала у себя, потом
                                // просьба. Оборвётся связь — своё уже
                                // исправлено, а повторить человек сможет.
                                if for_both {
                                    if let Some(device) = peer {
                                        let request = crate::access::edit_request(&id, &body);
                                        let waiting =
                                            PendingSend { device, body: request, stored: true };
                                        if let Err(err) = deliver(
                                            &mut socket, store, mls, sink, &mut pending, waiting,
                                            &mut live.outbox,
                                        ).await {
                                            if is_transport(&err) {
                                                return Ok(Outcome::Retry);
                                            }
                                            fail(sink, "edit_request", &err.to_string());
                                        }
                                    }
                                }
                            }
                            Err(err) => fail(sink, "storage", &err.to_string()),
                        }
                    }
                    Command::Typing { recipient_device, active } => {
                        // Ошибку не показываем: индикатор набора — вещь
                        // необязательная, и ругаться на него посреди переписки
                        // хуже, чем тихо его не отправить.
                        if let Err(err) = send_typing(
                            &mut socket, store, mls, sink, &recipient_device, active,
                            &mut live.outbox,
                        ).await {
                            if is_transport(&err) {
                                return Ok(Outcome::Retry);
                            }
                        }
                    }
                    Command::AccessSet { policy } => {
                        let label = match policy {
                            crate::access::Policy::Everyone => "everyone",
                            crate::access::Policy::Passes => "passes",
                        };
                        // Сначала раздаём пропуска, потом запираем дверь: в
                        // обратном порядке знакомые остались бы снаружи до
                        // следующего подключения.
                        if let Err(err) = grant_missing(&mut socket, store, mls, sink, live).await {
                            fail(sink, "pass_grant", &err.to_string());
                        }
                        send(&mut socket, proto::access_set_frame(label)?).await?;

                        let mut access = load_access(store);
                        access.policy = policy;
                        match save_access(store, &access) {
                            Ok(()) => sink(access_event(store)),
                            Err(err) => fail(sink, "storage", &err.to_string()),
                        }
                    }
                    Command::PassInvite { label, one_time, ttl_sec } => {
                        let (pass, hash) = crate::access::new_pass();
                        send(&mut socket, proto::pass_create_frame(&hash, one_time, ttl_sec)?).await?;

                        let mut access = load_access(store);
                        access.invites.push(crate::access::Invite {
                            pass,
                            hash,
                            label,
                            one_time,
                            ttl_sec,
                            created_at: now_millis(),
                        });
                        match save_access(store, &access) {
                            Ok(()) => sink(access_event(store)),
                            Err(err) => fail(sink, "storage", &err.to_string()),
                        }
                    }
                    Command::PassRevoke { hash } => {
                        send(&mut socket, proto::pass_revoke_frame(&hash)?).await?;

                        let mut access = load_access(store);
                        access.invites.retain(|invite| invite.hash != hash);
                        access.granted.retain(|_, granted| *granted != hash);
                        match save_access(store, &access) {
                            Ok(()) => sink(access_event(store)),
                            Err(err) => fail(sink, "storage", &err.to_string()),
                        }
                    }
                    Command::UsernameSet { name, discoverable } => {
                        match crate::directory::normalize_username(&name) {
                            Ok(normalized) => {
                                // Argon2id считается здесь и держит поток ядра
                                // около десятой доли секунды. Это цена за то,
                                // чтобы утёкшая таблица имён не перебиралась
                                // словарём, и платится она дважды за имя.
                                let hash = crate::directory::username_hash(&normalized);
                                let hash2 = crate::directory::username_hash_v2(&normalized)?;
                                pending_username = Some((normalized, discoverable));
                                send(
                                    &mut socket,
                                    proto::username_set_frame(&hash, &hash2, discoverable)?,
                                )
                                .await?;
                            }
                            Err(err) => fail(sink, "bad_username", &err.to_string()),
                        }
                    }
                    Command::UsernameClear => {
                        pending_username = None;
                        send(&mut socket, proto::username_clear_frame()?).await?;
                    }
                    Command::UsernameLookup { name } => {
                        match crate::directory::normalize_username(&name) {
                            Ok(normalized) => {
                                let hash = crate::directory::username_hash(&normalized);
                                let hash2 = crate::directory::username_hash_v2(&normalized)?;
                                looking_for = Some(normalized);
                                send(
                                    &mut socket,
                                    proto::username_lookup_frame(&hash, &hash2)?,
                                )
                                .await?;
                            }
                            Err(err) => fail(sink, "bad_username", &err.to_string()),
                        }
                    }
                    Command::ProfileGet { query } => {
                        if greeting.profiles {
                            send(&mut socket, proto::profile_get_frame(&query)?).await?;
                        } else {
                            fail(sink, "profiles_unavailable", "server does not support profiles yet");
                        }
                    }
                    Command::ProfileDecor { emblem, color } => {
                        if greeting.decor {
                            send(&mut socket, proto::profile_decor_frame(&emblem, &color)?).await?;
                        } else {
                            fail(sink, "decor_unavailable", "сервер ещё не умеет значки и цвета");
                        }
                    }
                    Command::GroupCreate { title, kind, members } => {
                        let kind = if kind == "channel" { "channel" } else { "chat" };
                        match mls.create_group() {
                            Ok(group_id) => {
                                let meta = GroupMeta {
                                    title,
                                    kind: kind.to_string(),
                                    owner: hex::encode(mls.device_pub()),
                                    members: Vec::new(),
                                };
                                let raw = serde_json::to_vec(&meta).unwrap_or_default();
                                store.save_group(&group_id, kind, &raw, now_millis())?;
                                persist(store, mls, sink);
                                sink(group_event(mls, store, &group_id, &meta));
                                for member in members {
                                    request_invite(&mut socket, sink, &mut pending, &group_id, &member).await?;
                                }
                            }
                            Err(err) => fail(sink, "group_create", &err.to_string()),
                        }
                    }
                    Command::GroupInvite { group, members } => {
                        match hex::decode(&group) {
                            Ok(group_id) => {
                                for member in members {
                                    request_invite(&mut socket, sink, &mut pending, &group_id, &member).await?;
                                }
                            }
                            Err(_) => fail(sink, "bad_group", "идентификатор группы неразборчив"),
                        }
                    }
                    Command::GroupRemove { group, device } => {
                        let (Ok(group_id), Ok(raw)) = (hex::decode(&group), hex::decode(&device))
                        else {
                            fail(sink, "bad_group", "идентификатор неразборчив");
                            continue;
                        };
                        let Ok(target): std::result::Result<[u8; KEY_LEN], _> = raw.try_into()
                        else {
                            fail(sink, "bad_device", "адрес устройства неверной длины");
                            continue;
                        };
                        match mls.remove_member(&group_id, &target) {
                            Ok(commit) => {
                                persist(store, mls, sink);
                                fan_out(&mut socket, mls, &group_id, &commit, None).await?;
                                if let Some((_, meta)) = load_meta(store, &group_id) {
                                    sink(group_event(mls, store, &group_id, &meta));
                                }
                            }
                            Err(err) => fail(sink, "group_remove", &err.to_string()),
                        }
                    }
                    Command::GroupSend { group, body } => {
                        let Ok(group_id) = hex::decode(&group) else {
                            fail(sink, "bad_group", "идентификатор группы неразборчив");
                            continue;
                        };
                        // В своём канале пишет только владелец — и здесь тоже:
                        // отправлять то, что получатели отвергнут, незачем.
                        if let Some((kind, meta)) = load_meta(store, &group_id) {
                            if kind == "channel" && meta.owner != hex::encode(mls.device_pub()) {
                                fail(sink, "channel_readonly", "в этот канал пишет только владелец");
                                continue;
                            }
                        }
                        match mls.encrypt_group(&group_id, body.as_bytes()) {
                            Ok(ciphertext) => {
                                persist(store, mls, sink);
                                let mut id = [0u8; ID_LEN];
                                id.copy_from_slice(&random_bytes(ID_LEN));
                                store.insert_message(&id, &group_id, true, now_millis(), body.as_bytes())?;
                                fan_out(&mut socket, mls, &group_id, &ciphertext, None).await?;
                            }
                            Err(CoreError::Anomaly(detail)) => {
                                sink(Event::Anomaly { kind: "send_blocked".into(), detail });
                            }
                            Err(err) => fail(sink, "group_send", &err.to_string()),
                        }
                    }
                    Command::GroupForget { group } => {
                        if let Ok(group_id) = hex::decode(&group) {
                            store.forget_group(&group_id)?;
                            sink(Event::GroupForgotten { group });
                        }
                    }
                    Command::ChannelCreate { handle, title, about } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_CREATE,
                            &serde_json::json!({ "handle": handle, "title": title, "about": about }))?).await?;
                    }
                    Command::ChannelPublish { channel, body } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_PUBLISH,
                            &serde_json::json!({ "channel": channel, "body": body }))?).await?;
                    }
                    Command::ChannelList => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_LIST,
                            &serde_json::json!({}))?).await?;
                    }
                    Command::ChannelFeed { channel, before } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_FEED,
                            &serde_json::json!({ "channel": channel, "before": before }))?).await?;
                    }
                    Command::ChannelSubscribe { channel, subscribe } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_SUB,
                            &serde_json::json!({ "channel": channel, "subscribe": subscribe }))?).await?;
                    }
                    Command::ChannelFind { handle } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_FIND,
                            &serde_json::json!({ "handle": handle }))?).await?;
                    }
                    Command::ChannelDeletePost { channel, post } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_DELETE_POST,
                            &serde_json::json!({ "channel": channel, "post": post }))?).await?;
                    }
                    Command::ChannelDelete { channel } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_DELETE,
                            &serde_json::json!({ "channel": channel }))?).await?;
                    }
                    Command::ChannelUpdate { channel, title, about, icon } => {
                        // Только тронутые поля: сервер отличает «не менять» от
                        // «очистить» по наличию ключа, а не по пустому значению.
                        let mut payload = serde_json::Map::new();
                        payload.insert("channel".into(), channel.into());
                        if let Some(title) = title {
                            payload.insert("title".into(), title.into());
                        }
                        if let Some(about) = about {
                            payload.insert("about".into(), about.into());
                        }
                        if let Some(icon) = icon {
                            payload.insert("icon".into(), icon);
                        }
                        send(&mut socket, proto::channel_frame(op::CHANNEL_UPDATE,
                            &serde_json::Value::Object(payload))?).await?;
                    }
                    Command::ChannelAdmin { channel, who, admin } => {
                        send(&mut socket, proto::channel_frame(op::CHANNEL_ADMIN,
                            &serde_json::json!({ "channel": channel, "who": who, "admin": admin }))?).await?;
                    }
                    Command::AdminGet { offset } => {
                        send(&mut socket, proto::admin_get_frame(offset)?).await?;
                    }
                    Command::AdminAction { action, reference } => {
                        send(&mut socket, proto::admin_action_frame(&action, &reference)?).await?;
                    }
                    Command::ProfileSet { avatar_mime, avatar_base64 } => {
                        if greeting.profiles {
                            // Прячем аватар от сервера ровно тогда, когда
                            // человек и так велел показывать его не всем.
                            // Правило `profile_avatar` до сих пор соблюдал
                            // только наш собственный интерфейс — теперь его
                            // соблюдает и хранилище.
                            let (mime, data) = match (&avatar_mime, &avatar_base64) {
                                (Some(mime), Some(data)) if avatar_is_private(store) => {
                                    let key = own_profile_key(store)?;
                                    (
                                        Some(crate::profile::SEALED_MIME.to_owned()),
                                        Some(crate::profile::seal(&key, mime, data)?),
                                    )
                                }
                                _ => (avatar_mime.clone(), avatar_base64.clone()),
                            };
                            send(&mut socket, proto::profile_set_frame(&mime, &data)?).await?;
                        } else {
                            fail(sink, "profiles_unavailable", "server does not support profiles yet");
                        }
                    }
                    Command::RecoverySetup { login, password, totp, code } => {
                        if !authenticated {
                            fail(sink, "not_authenticated", "войдите, прежде чем включать восстановление");
                        } else if totp.is_some() && code.as_deref().unwrap_or("").is_empty() {
                            // Включать второй фактор без подтверждения нельзя:
                            // ошибка при переносе секрета обнаружилась бы только
                            // тогда, когда восстановление уже понадобилось.
                            fail(sink, "totp_code_required", "подтвердите код из приложения");
                        } else {
                            match seal_recovery(
                                store, &login, &password, totp.as_deref(), code.as_deref(),
                            ) {
                                Ok((normalized, frame)) => {
                                    pending_recovery = Some((normalized, totp.is_some()));
                                    send(&mut socket, frame).await?;
                                }
                                Err(err) => fail(sink, password_code_of(&err), &err.to_string()),
                            }
                        }
                    }
                    Command::RecoveryForget => {
                        if !authenticated {
                            fail(sink, "not_authenticated", "войдите, прежде чем менять восстановление");
                        } else {
                            pending_recovery = None;
                            send(&mut socket, proto::recovery_forget_frame()?).await?;
                        }
                    }
                    Command::Send { recipient_device, body } => {
                        if !authenticated {
                            fail(sink, "not_authenticated", "invoice is not funded yet");
                        } else if let Err(err) = on_send(
                            &mut socket, store, mls, sink, &mut pending, &recipient_device, body,
                            &mut live.outbox,
                        )
                        .await
                        {
                            if is_transport(&err) {
                                // Сообщение уже в ящике — переподключаемся и
                                // досылаем, а не пишем в закрытый сокет.
                                sink(Event::Disconnected { reason: err.to_string() });
                                return Ok(Outcome::Retry);
                            }
                            fail(sink, "send", &err.to_string());
                        }
                    }
                    Command::Connect { .. } => {
                        // Уже подключены — и это не ошибка, а вопрос «где я».
                        // Так спрашивает заново открытый экран: приложение
                        // свернули, окно пересоздали, а соединение всё это время
                        // жило. Раньше в ответ уходил отказ «busy», интерфейс
                        // ждал «вошли» и навсегда оставался на заставке.
                        //
                        // Пересказываем встречу целиком, а не одно «вошли»: без
                        // возможностей сервера заново открытый экран не знает,
                        // можно ли спрашивать профили, и показывает вместо имён
                        // шестнадцатеричные адреса.
                        //
                        // Очередь при этом ноль: всё накопленное уже отдано на
                        // входе, обещать «столько-то ждёт» было бы неправдой.
                        sink(Event::Connected {
                            heartbeat_sec: greeting.heartbeat_sec,
                            invite_entry: greeting.invite_entry,
                            ton_entry: greeting.ton_entry,
                            profiles: greeting.profiles,
                            decor: greeting.decor,
                        });
                        sink(Event::Authenticated {
                            device_id: device_id.clone(),
                            queued: 0,
                            admin,
                        });
                    }
                    other => {
                        // Остальное — вход и восстановление — имеет смысл только
                        // вне соединения.
                        fail(sink, "busy", &format!("already connected: {other:?}"));
                    }
                }
            }
            _ = ticker.tick() => {
                send(&mut socket, proto::frame(op::PING, &[])).await?;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn on_frame(
    socket: &mut Socket,
    data: &[u8],
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    pending: &mut HashMap<[u8; ID_LEN], Claim>,
    live: &mut Live,
) -> Result<()> {
    let (opcode, body) = proto::split(data)?;
    match opcode {
        op::PONG => {}
        op::QUEUE_DONE => sink(Event::QueueDone),
        op::ENVELOPE => on_envelope(socket, body, store, mls, sink, live).await?,
        op::KEYPKG => {
            on_key_package(socket, body, store, mls, sink, pending, &mut live.outbox).await?
        }
        op::PROFILE => {
            let profile: proto::ProfilePayload = proto::parse_json(body)?;
            // Аватар мог приехать запечатанным. Ключ есть — открываем, нет —
            // отдаём наверх пустоту: интерфейс покажет инициалы.
            let (avatar_mime, avatar_base64) = unseal_avatar(
                store,
                Some(profile.device.as_str()),
                profile.avatar_mime,
                profile.avatar_base64,
            );
            sink(Event::Profile {
                device: profile.device,
                chat_code: profile.chat_code,
                handle: profile.handle,
                avatar_mime,
                avatar_base64,
                emblem: profile.emblem,
                color: profile.color,
                updated_at: profile.updated_at,
            });
        }
        op::SEND_OK => {
            let (client_ref, envelope_id) = proto::parse_send_ok(body)?;
            sink(Event::Accepted {
                client_ref: hex::encode(client_ref),
                envelope_id: hex::encode(envelope_id),
            });
        }
        #[cfg(feature = "ton")]
        op::PAY_OK => {
            let info: serde_json::Value = proto::parse_json(body)?;
            sink(Event::InvoicePaid {
                reference: info.get("ref").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            });
        }
        op::ERROR => {
            let err: ServerError = proto::parse_json(body)?;
            sink(Event::Failed { code: err.code, message: err.message });
        }

        op::CHANNEL_OK => {
            sink(Event::Channels { report: proto::parse_json(body)? });
        }
        op::CHANNEL_POST => {
            sink(Event::ChannelPost { report: proto::parse_json(body)? });
        }
        op::ADMIN_OK => {
            // Отчёт пересылается как есть: набор счётчиков задаёт сервер, и
            // разбирать его по полям здесь значило бы ломать клиент при каждом
            // новом счётчике.
            sink(Event::Admin { report: proto::parse_json(body)? });
        }
        op::ACCESS_OK => {
            // Подтверждение операции с доступом. Разбирать почти нечего, кроме
            // одного случая: наш пропуск не приняли. Тогда писать этому
            // человеку не выйдет, и он должен узнать причину, а не гадать.
            let ok: proto::AccessOk = proto::parse_json(body)?;
            if ok.admitted == Some(false) {
                fail(sink, "pass_rejected", "пропуск не принят: возможно, он отозван или истёк");
            }
        }

        // Незнакомый кадр пропускаем, а не рвём связь.
        //
        // Раньше здесь был отказ, и он ронял соединение. Это стоило
        // бесконечного цикла переподключений: сервер отвечал на выкладку
        // пропусков кадром 0x2a, которого клиент не знал, тот рвал связь, на
        // новом соединении всё повторялось — и так до перезапуска. Защищать
        // тут нечего: сервер и так может прислать что угодно, а клиент, не
        // переживающий нового кадра, ломается от любого обновления сервера.
        _ => {}
    }
    Ok(())
}

/// Расшифровывает конверт и раскладывает по беседам.
///
/// ACK отправляется в любом случае, даже если расшифровать не удалось: сервер
/// хранит конверт до подтверждения, и без ACK нерасшифровываемый кадр приезжал
/// бы заново при каждом подключении. Ошибка при этом видна событием.
async fn on_envelope(
    socket: &mut Socket,
    body: &[u8],
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    live: &mut Live,
) -> Result<()> {
    let envelope = proto::parse_envelope(body)?;

    match mls.process(&envelope.ciphertext) {
        Ok(Incoming::Joined { group_id, peer_device }) => {
            let device = hex::encode(&peer_device);
            if blocked(store, &device) {
                // Приглашение от заблокированного не заводит беседу. Конверт
                // подтверждаем: иначе он будет приезжать снова и снова.
                return send(socket, proto::ack_frame(&envelope.id)).await;
            }
            remember_stranger(store, sink, &device, "написал первым");

            store.set_conversation(&peer_device, &group_id)?;
            persist(store, mls, sink);
            check_membership(mls, store, &group_id, sink);
            sink(Event::ConversationStarted {
                peer_device: device,
                conversation: hex::encode(&group_id),
            });
        }
        Ok(Incoming::Message { group_id, sender_device, plaintext }) => {
            let device = hex::encode(&sender_device);
            if blocked(store, &device) {
                // Заблокированный не попадает ни в базу, ни на экран. Проверка
                // стоит здесь, а не в интерфейсе, именно поэтому: спрятать
                // сообщение мало, его не должно быть на диске.
                return send(socket, proto::ack_frame(&envelope.id)).await;
            }
            let text = String::from_utf8_lossy(&plaintext);
            if crate::access::is_control(&text) {
                // Служебное сообщение в переписке не сохраняется: в ленте ему
                // не место. Наружу выходит только то, что видно человеку, —
                // «печатает» и исчезнувшие сообщения.
                use crate::access::Control;
                match crate::access::parse_signal(&text) {
                    Some(Control::Pass(pass)) => {
                        let mut access = load_access(store);
                        access.hold(&device, &pass);
                        let _ = save_access(store, &access);
                    }
                    Some(Control::ProfileKey(key)) => {
                        // Ключ от аватара собеседника. Кладём его рядом с
                        // устройством, от которого он пришёл: чужой ключ на
                        // чужой аватар всё равно не подойдёт.
                        let mut keys = load_peer_profile_keys(store);
                        keys.insert(hex::encode(&device), key);
                        if let Ok(encoded) = serde_json::to_vec(&keys) {
                            let _ = store.save_setting(PEER_PROFILE_KEYS, &encoded);
                        }
                    }
                    Some(Control::Delete(ids)) => {
                        let group = hex::encode(&group_id);
                        let mut removed = Vec::new();
                        for id in ids {
                            if store.delete_message_by_id(&group_id, &id).unwrap_or(false) {
                                removed.push(id);
                            }
                        }
                        if !removed.is_empty() {
                            sink(Event::Deleted { conversation: group, ids: removed });
                        }
                    }
                    Some(Control::Edit { id, body }) => {
                        if store.update_message_by_id(&group_id, &id, body.as_bytes())
                            .unwrap_or(false)
                        {
                            sink(Event::Edited {
                                conversation: hex::encode(&group_id),
                                id,
                                body,
                            });
                        }
                    }
                    Some(Control::Typing(active)) => {
                        sink(Event::PeerTyping { peer_device: device.clone(), active });
                    }
                    Some(Control::Online) => {
                        sink(Event::PeerOnline { peer_device: device.clone() });
                    }
                    Some(Control::Group { title, kind, owner }) => {
                        // Название присылает тот, кто позвал. Верить ему на слово
                        // тут можно: состав всё равно задаёт MLS, а подпись под
                        // сообщением уже проверена.
                        let meta = GroupMeta {
                            title,
                            kind: kind.clone(),
                            owner,
                            members: Vec::new(),
                        };
                        if let Ok(raw) = serde_json::to_vec(&meta) {
                            let _ = store.save_group(&group_id, &kind, &raw, now_millis());
                        }
                        sink(group_event(mls, store, &group_id, &meta));
                    }
                    None => {}
                }
                return send(socket, proto::ack_frame(&envelope.id)).await;
            }
            // В канале пишет только владелец. Это соглашение клиентов, а не
            // запрет криптографии: MLS разрешает говорить любому участнику.
            // Поэтому проверка стоит на приёме — чужой пост не ляжет в базу,
            // даже если его собрали изменённым клиентом.
            if let Some((kind, meta)) = load_meta(store, &group_id) {
                if kind == "channel" && meta.owner != device {
                    sink(Event::Anomaly {
                        kind: "channel_post_rejected".into(),
                        detail: format!("в канале «{}» писать может только владелец", meta.title),
                    });
                    return send(socket, proto::ack_frame(&envelope.id)).await;
                }
            }

            remember_stranger(store, sink, &device, "написал первым");

            store.insert_message(&envelope.id, &group_id, false, envelope.server_ts as i64, &plaintext)?;
            persist(store, mls, sink);
            check_membership(mls, store, &group_id, sink);
            sink(Event::Message {
                envelope_id: hex::encode(envelope.id),
                conversation: hex::encode(&group_id),
                sender_device: device,
                server_ts: envelope.server_ts,
                body: String::from_utf8_lossy(&plaintext).into_owned(),
            });
        }
        Ok(Incoming::Handled) => persist(store, mls, sink),

        // Повторная доставка после потерянного подтверждения. Ключ израсходован,
        // второй раз это сообщение не прочитается никогда — подтверждаем и
        // забываем. Человеку показывать нечего: он это сообщение уже видел.
        Err(CoreError::AlreadyProcessed(_)) => {}

        Err(err) => {
            fail(sink, "decrypt", &err.to_string());

            // Подтверждённый конверт сервер удаляет навсегда, поэтому с первого
            // промаха ACK не шлём: сообщение могло опередить приглашение, и на
            // следующем подключении оно разберётся. Но и держать его вечно
            // нельзя — конверт, не читаемый дважды, не прочитается уже никогда,
            // а очередь занимать будет до истечения срока.
            if live.failed.insert(envelope.id) {
                return Ok(());
            }
            sink(Event::Failed {
                code: "undecryptable".into(),
                message: "сообщение не удалось прочитать — снято с очереди".into(),
            });
        }
    }

    send(socket, proto::ack_frame(&envelope.id)).await
}

/// Описание группы: то, чего нет в самом MLS.
///
/// Состав здесь — снимок, а не второй источник правды: настоящий состав знает
/// MLS, и `group_event` каждый раз переписывает снимок его ответом. Нужен он
/// ради списка групп без сети: MLS живёт только внутри соединения, а показать
/// список надо сразу после запуска.
#[derive(serde::Serialize, serde::Deserialize)]
struct GroupMeta {
    title: String,
    kind: String,
    owner: String,
    #[serde(default)]
    members: Vec<String>,
}

fn load_meta(store: &Store, group_id: &[u8]) -> Option<(String, GroupMeta)> {
    let (kind, raw) = store.group(group_id).ok().flatten()?;
    let meta: GroupMeta = serde_json::from_slice(&raw).ok()?;
    Some((kind, meta))
}

fn group_event(mls: &Mls, store: &Store, group_id: &[u8], meta: &GroupMeta) -> Event {
    let members: Vec<String> = mls
        .members(group_id)
        .unwrap_or_default()
        .into_iter()
        .map(hex::encode)
        .collect();

    // Снимок состава обновляется тем же ответом MLS, которым отвечаем наружу:
    // разойтись им негде.
    let fresh = GroupMeta {
        title: meta.title.clone(),
        kind: meta.kind.clone(),
        owner: meta.owner.clone(),
        members: members.clone(),
    };
    if let Ok(raw) = serde_json::to_vec(&fresh) {
        let _ = store.save_group(group_id, &fresh.kind, &raw, now_millis());
    }

    Event::Group {
        group: hex::encode(group_id),
        kind: meta.kind.clone(),
        title: meta.title.clone(),
        owner: meta.owner.clone(),
        members,
    }
}

/// Отправляет один и тот же шифротекст каждому участнику, кроме себя.
///
/// Групп на сервере нет: он принимает конверты, адресованные устройствам. Это
/// и хорошо (состав группы ему негде хранить), и честно говоря дорого —
/// отправка в группу из двадцати человек это двадцать конвертов. Поэтому
/// группы здесь про десятки участников, а не про тысячи.
async fn fan_out(
    socket: &mut Socket,
    mls: &Mls,
    group_id: &[u8],
    payload: &[u8],
    skip: Option<[u8; KEY_LEN]>,
) -> Result<()> {
    let me = mls.device_pub();
    for member in mls.members(group_id)? {
        if member == me || Some(member) == skip {
            continue;
        }
        let mut client_ref = [0u8; ID_LEN];
        client_ref.copy_from_slice(&random_bytes(ID_LEN));
        send(
            socket,
            proto::send_frame(&client_ref, &member, DEFAULT_TTL_SEC, payload),
        )
        .await?;
    }
    Ok(())
}

/// Рассказывает участникам, как группа называется.
///
/// В самом Welcome названия нет, и придумать его получатель не может. Поэтому
/// описание едет обычным шифрованным сообщением внутри группы: сервер видит
/// такой же непрозрачный конверт, как и у любого другого.
async fn announce_group(
    socket: &mut Socket,
    mls: &mut Mls,
    group_id: &[u8],
    meta: &GroupMeta,
) -> Result<()> {
    let body = crate::access::group_signal(&meta.title, &meta.kind, &meta.owner);
    let ciphertext = mls.encrypt_group(group_id, body.as_bytes())?;
    fan_out(socket, mls, group_id, &ciphertext, None).await
}

/// Досылает приглашение, когда приехал KeyPackage приглашённого.
async fn finish_invite(
    socket: &mut Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    group_id: &[u8],
    device: [u8; KEY_LEN],
    package: &[u8],
) -> Result<()> {
    let (commit, welcome) = match mls.add_members(group_id, &[(package.to_vec(), device)]) {
        Ok(pair) => pair,
        Err(err) => {
            fail(sink, "group_invite", &err.to_string());
            return Ok(());
        }
    };
    persist(store, mls, sink);

    // Коммит — тем, кто уже был в группе; приглашение — новичку. Порядок важен:
    // без Welcome ему нечем разобрать даже следующий коммит.
    fan_out(socket, mls, group_id, &commit, Some(device)).await?;
    send_envelope(socket, &device, &welcome).await?;

    if let Some((_, meta)) = load_meta(store, group_id) {
        announce_group(socket, mls, group_id, &meta).await?;
        sink(group_event(mls, store, group_id, &meta));
    }
    Ok(())
}

/// Просит KeyPackage приглашаемого: без него добавить лист нечем.
async fn request_invite(
    socket: &mut Socket,
    sink: &EventSink,
    pending: &mut HashMap<[u8; ID_LEN], Claim>,
    group_id: &[u8],
    member: &str,
) -> Result<()> {
    let Ok(raw) = hex::decode(member) else {
        fail(sink, "bad_device", "адрес устройства неразборчив");
        return Ok(());
    };
    let Ok(device): std::result::Result<[u8; KEY_LEN], _> = raw.try_into() else {
        fail(sink, "bad_device", "адрес устройства неверной длины");
        return Ok(());
    };

    let mut client_ref = [0u8; ID_LEN];
    client_ref.copy_from_slice(&random_bytes(ID_LEN));
    pending.insert(client_ref, Claim::Invite { group_id: group_id.to_vec(), device });
    send(socket, proto::keypkg_claim_frame(&client_ref, &device)).await
}

/// Приехал KeyPackage собеседника — заводим группу и досылаем отложенное.
async fn on_key_package(
    socket: &mut Socket,
    body: &[u8],
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    pending: &mut HashMap<[u8; ID_LEN], Claim>,
    outbox: &mut Outbox,
) -> Result<()> {
    let (client_ref, package) = proto::parse_keypkg(body)?;
    let Some(claim) = pending.remove(&client_ref) else {
        // Ответ на запрос, который мы уже не ждём. Не повод рвать соединение.
        return Ok(());
    };

    let Some(package) = package else {
        fail(sink, "no_key_packages", "recipient has no key packages left");
        return Ok(());
    };

    let waiting = match claim {
        Claim::Start(waiting) => waiting,
        Claim::Invite { group_id, device } => {
            return finish_invite(socket, store, mls, sink, &group_id, device, &package).await;
        }
    };

    // Привязку пакета к устройству проверяет сам MLS-слой: сервер мог подсунуть
    // чужой, и тогда start_conversation откажется его брать.
    let (group_id, welcome) = match mls.start_conversation(&package, &waiting.device) {
        Ok(result) => result,
        Err(err) => {
            fail(sink, "key_package", &err.to_string());
            return Ok(());
        }
    };
    store.set_conversation(&waiting.device, &group_id)?;
    persist(store, mls, sink);
    // Отправитель узнаёт идентификатор беседы тем же событием, что и
    // получатель: интерфейсу иначе некуда класть исходящие сообщения.
    sink(Event::ConversationStarted {
        peer_device: hex::encode(waiting.device),
        conversation: hex::encode(&group_id),
    });

    // Сначала приглашение, потом само сообщение — порядок важен: без Welcome
    // получателю нечем расшифровать.
    if let Err(err) = send_envelope(socket, &waiting.device, &welcome).await {
        outbox.push(waiting);
        return Err(err);
    }
    encrypt_and_send(socket, store, mls, sink, &group_id, waiting, outbox).await
}

#[allow(clippy::too_many_arguments)]
async fn on_send(
    socket: &mut Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    pending: &mut HashMap<[u8; ID_LEN], Claim>,
    recipient_device: &str,
    body: String,
    outbox: &mut Outbox,
) -> Result<()> {
    let device = hex::decode(recipient_device).map_err(|_| CoreError::BadFrame)?;
    let device: [u8; KEY_LEN] = device.try_into().map_err(|_| CoreError::BadKeyLength)?;

    deliver(socket, store, mls, sink, pending, PendingSend { device, body, stored: false }, outbox).await
}

/// Общий путь для новой отправки и для досылки из ящика.
///
/// При обрыве сообщение возвращается в ящик, а не теряется: до этой правки
/// неудачная отправка оставляла человеку одну строку в журнале ошибок и
/// собственную копию в базе, которой собеседник никогда не увидит.
async fn deliver(
    socket: &mut Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    pending: &mut HashMap<[u8; ID_LEN], Claim>,
    waiting: PendingSend,
    outbox: &mut Outbox,
) -> Result<()> {
    match store.conversation_with(&waiting.device)? {
        Some(group_id) => encrypt_and_send(socket, store, mls, sink, &group_id, waiting, outbox).await,
        None => {
            // Беседы ещё нет: просим KeyPackage и досылаем сообщение по ответу.
            let mut client_ref = [0u8; ID_LEN];
            client_ref.copy_from_slice(&random_bytes(ID_LEN));
            let device = waiting.device;
            pending.insert(client_ref, Claim::Start(waiting));
            if let Err(err) = send(socket, proto::keypkg_claim_frame(&client_ref, &device)).await {
                if let Some(Claim::Start(lost)) = pending.remove(&client_ref) {
                    outbox.push(lost);
                }
                return Err(err);
            }
            Ok(())
        }
    }
}

async fn encrypt_and_send(
    socket: &mut Socket,
    store: &Store,
    mls: &mut Mls,
    sink: &EventSink,
    group_id: &[u8],
    waiting: PendingSend,
    outbox: &mut Outbox,
) -> Result<()> {
    let device = &waiting.device;
    let body = waiting.body.as_str();

    // Отказ здесь — не сбой отправки, а сигнал: состав беседы не тот, кому мы
    // собирались писать. Открытый текст в такую группу уходить не должен.
    let ciphertext = match mls.encrypt(group_id, body.as_bytes(), device) {
        Ok(ciphertext) => ciphertext,
        Err(CoreError::Anomaly(detail)) => {
            sink(Event::Anomaly { kind: "send_blocked".into(), detail });
            return Ok(());
        }
        Err(other) => return Err(other),
    };
    persist(store, mls, sink);

    let mut client_ref = [0u8; ID_LEN];
    client_ref.copy_from_slice(&random_bytes(ID_LEN));
    // Своя копия ложится в базу открытым текстом — но в запечатанной записи.
    // При досылке из ящика она там уже есть: повторять нельзя.
    if !waiting.stored {
        store.insert_message(&client_ref, group_id, true, now_millis(), body.as_bytes())?;
    }

    if let Err(err) =
        send(socket, proto::send_frame(&client_ref, device, DEFAULT_TTL_SEC, &ciphertext)).await
    {
        // Шифротекст этой эпохи уже не пригодится — при досылке текст будет
        // зашифрован заново, поэтому в ящик кладётся именно открытый текст.
        outbox.push(PendingSend { device: *device, body: waiting.body, stored: true });
        return Err(err);
    }
    Ok(())
}

/// Служебный кадр MLS (Welcome, коммит) едет тем же конвертом, что и сообщения.
async fn send_envelope(socket: &mut Socket, device: &[u8; KEY_LEN], payload: &[u8]) -> Result<()> {
    let mut client_ref = [0u8; ID_LEN];
    client_ref.copy_from_slice(&random_bytes(ID_LEN));
    send(socket, proto::send_frame(&client_ref, device, DEFAULT_TTL_SEC, payload)).await
}

async fn send(socket: &mut Socket, frame: Vec<u8>) -> Result<()> {
    socket
        .send(Message::Binary(frame))
        .await
        .map_err(|err| CoreError::Transport(err.to_string()))
}

fn fail(sink: &EventSink, code: &str, message: &str) {
    sink(Event::Failed { code: code.to_string(), message: message.to_string() });
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Сбой MLS не должен выглядеть как обрыв связи.
    ///
    /// Раньше и то и другое было `Transport`, а по нему клиент решает
    /// «переподключиться». Любая беда с состоянием группы поэтому превращалась в
    /// бесконечный цикл: связь цела, клиент рвёт её сам и на новом соединении
    /// спотыкается о то же самое. Разделение — единственное, что это держит.
    #[test]
    fn an_mls_failure_is_not_a_dead_socket() {
        assert!(!is_transport(&CoreError::Mls("mls encrypt".into())));
        assert!(!is_transport(&CoreError::AlreadyProcessed("повтор")));
        assert!(!is_transport(&CoreError::Rejected("dm_not_allowed".into())));
        assert!(is_transport(&CoreError::Transport("сокет закрыт".into())));
    }

    /// Курсор страницы читается только целиком; мусор трактуется как «сначала».
    #[test]
    fn a_broken_cursor_reads_as_the_beginning() {
        assert_eq!(parse_cursor(&Some("1700:12".into())), Some((1700, 12)));
        for bad in ["", "1700", "abc:def", "1700:", ":12"] {
            assert_eq!(parse_cursor(&Some(bad.into())), None, "принят мусор: {bad}");
        }
        assert_eq!(parse_cursor(&None), None);
    }
}

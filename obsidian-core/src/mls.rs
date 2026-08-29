//! Шифрование переписки: MLS (RFC 9420) через OpenMLS.
//!
//! Диалог 1:1 — это группа из двух участников, отдельного кода для него нет.
//!
//! **Привязка к личности.** У MLS своя пара подписи, и сама по себе она никак
//! не связана с ключом устройства из `keys.rs`. Поэтому в credential кладётся
//! не идентификатор, а `device_pub || sig`, где подпись сделана ключом
//! устройства над MLS-ключом этого листа. Каждый участник проверяет её сам —
//! иначе «участник группы» и «владелец устройства» остаются разными сущностями
//! и сервер может подставить в группу кого угодно.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::error::{CoreError, Result};
use crate::keys::{self, KEY_LEN, SIG_LEN};

/// Ciphersuite из ARCHITECTURE.md §5.
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Доменный префикс подписи, связывающей MLS-ключ с устройством.
const DOMAIN_MLS: &[u8] = b"obsidian-mls-v1";

/// `[32B device_pub][64B подпись MLS-ключа этим устройством]`
const CREDENTIAL_LEN: usize = KEY_LEN + SIG_LEN;

/// Что приехало от собеседника.
#[derive(Debug)]
pub enum Incoming {
    /// Приглашение в группу: мы в неё вступили.
    Joined { group_id: Vec<u8>, peer_device: [u8; KEY_LEN] },
    /// Расшифрованное сообщение.
    Message { group_id: Vec<u8>, sender_device: [u8; KEY_LEN], plaintext: Vec<u8> },
    /// Служебный кадр MLS — обработан, показывать нечего.
    Handled,
}

/// Состояние беседы: то, что можно сверить с собеседником, и то, по чему
/// видно неладное.
#[derive(Debug)]
pub struct Snapshot {
    /// Номер эпохи MLS. Растёт на каждом коммите и назад не ходит.
    pub epoch: u64,
    /// Значение, которое MLS выводит из секрета эпохи. У всех участников
    /// исправной группы оно одинаково, у постороннего — нет. Ради этого RFC
    /// 9420 его и определяет (§8.2).
    pub epoch_authenticator: Vec<u8>,
    /// Устройства участников. Привязка каждого уже проверена.
    pub members: Vec<[u8; KEY_LEN]>,
}

pub struct Mls {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    device_pub: [u8; KEY_LEN],
}

/// Кратность, до которой добивается содержимое сообщения перед шифрованием.
///
/// Длина шифротекста повторяет длину открытого текста — это свойство любого
/// потокового AEAD, — а длину видит сервер. Без добивки по одному только
/// размеру конверта отличаются вещи, которые различать он не должен: сигнал
/// «печатает» (десятки байт), короткая реплика (сотни), фотография (тысячи).
/// Переписку это не раскрывает, но раскрывает её ритм и род занятий.
///
/// Добивка нулями до кратности — часть самого MLS (RFC 9420, §6.3.2), а не
/// наша надстройка. Отсюда её главное достоинство: снимает её принимающая
/// сторона по стандарту, поэтому уже выпущенные клиенты продолжают читать
/// такие сообщения без единой правки. Своя добивка над MLS этого не умеет —
/// её пришлось бы согласовывать с каждым собеседником отдельно.
///
/// 256 байт — размен между сокрытием и трафиком. Всё мелкое — служебные
/// сигналы, «привет», «да» — становится неотличимым друг от друга, а платим мы
/// не более 255 байт на сообщение. Корзины с ростом (1 КиБ, 4 КиБ, 16 КиБ)
/// спрятали бы и середину, но стоили бы до двенадцати килобайт на сообщение и
/// требовали бы своего слоя поверх MLS — то есть согласования с собеседником.
const PADDING_BLOCK: usize = 256;

impl Mls {
    /// Создаёт новое MLS-состояние и привязывает его к ключу устройства.
    pub fn create(device: &keys::SecretKey) -> Result<Self> {
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|_| CoreError::Mls("mls signature keypair".into()))?;
        let provider = OpenMlsRustCrypto::default();
        signer
            .store(provider.storage())
            .map_err(|_| CoreError::Mls("mls signer store".into()))?;
        Ok(Self::assemble(device, signer, provider))
    }

    /// Восстанавливает состояние из запечатанного снимка.
    ///
    /// Приватный ключ подписи наружу не отдаётся вовсе (`private()` есть только
    /// под test-utils), поэтому он и не хранится отдельно: он лежит внутри
    /// снимка хранилища и достаётся оттуда по публичному ключу.
    pub fn restore(device: &keys::SecretKey, signer_public: &[u8], snapshot: &[u8]) -> Result<Self> {
        let provider = OpenMlsRustCrypto::default();
        restore_storage(&provider, snapshot)?;

        let signer = SignatureKeyPair::read(
            provider.storage(),
            signer_public,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or(CoreError::StoreLocked)?;

        Ok(Self::assemble(device, signer, provider))
    }

    fn assemble(device: &keys::SecretKey, signer: SignatureKeyPair, provider: OpenMlsRustCrypto) -> Self {
        let credential = CredentialWithKey {
            credential: BasicCredential::new(bind_credential(device, signer.public())).into(),
            signature_key: signer.public().into(),
        };
        Self { provider, signer, credential, device_pub: device.public() }
    }

    pub fn device_pub(&self) -> [u8; KEY_LEN] {
        self.device_pub
    }

    pub fn signer_public(&self) -> Vec<u8> {
        self.signer.to_public_vec()
    }

    /// Снимок всего состояния MLS. Наружу уходит только запечатанным: внутри
    /// эпохальные секреты, приватные ключи листьев и ключ подписи.
    pub fn snapshot(&self) -> Vec<u8> {
        let values = self.provider.storage().values.read().expect("mls storage poisoned");

        let mut out = Vec::new();
        out.extend_from_slice(&(values.len() as u64).to_be_bytes());
        for (key, value) in values.iter() {
            out.extend_from_slice(&(key.len() as u64).to_be_bytes());
            out.extend_from_slice(&(value.len() as u64).to_be_bytes());
            out.extend_from_slice(key);
            out.extend_from_slice(value);
        }
        out
    }

    /// KeyPackages для публикации на сервере. Каждый выдаётся ровно одному
    /// собеседнику: переиспользование ломает forward secrecy.
    pub fn key_packages(&self, count: usize) -> Result<Vec<Vec<u8>>> {
        (0..count)
            .map(|_| {
                let bundle = KeyPackage::builder()
                    .build(CIPHERSUITE, &self.provider, &self.signer, self.credential.clone())
                    .map_err(|_| CoreError::Mls("mls key package".into()))?;
                MlsMessageOut::from(bundle.key_package().clone())
                    .tls_serialize_detached()
                    .map_err(|_| CoreError::Mls("mls serialize".into()))
            })
            .collect()
    }

/// Заводит группу и приглашает владельца `key_package`.
    ///
    /// Возвращает `(group_id, welcome)`. Welcome уходит собеседнику обычным
    /// конвертом — сервер видит только шифротекст.
    pub fn start_conversation(
        &mut self,
        key_package: &[u8],
        expect_device: &[u8; KEY_LEN],
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let key_package = self.parse_key_package(key_package, expect_device)?;

        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            // Дерево едет внутри Welcome: другого канала у получателя нет.
            .use_ratchet_tree_extension(true)
            .padding_size(PADDING_BLOCK)
            .build();

        let mut group = MlsGroup::new(&self.provider, &self.signer, &config, self.credential.clone())
            .map_err(|_| CoreError::Mls("mls group create".into()))?;

        let (_commit, welcome, _info) = group
            .add_members(&self.provider, &self.signer, std::slice::from_ref(&key_package))
            .map_err(|_| CoreError::Mls("mls add member".into()))?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| CoreError::Mls("mls merge commit".into()))?;

        Ok((
            group.group_id().as_slice().to_vec(),
            welcome
                .tls_serialize_detached()
                .map_err(|_| CoreError::Mls("mls serialize welcome".into()))?,
        ))
    }

    /// Заводит группу, в которой пока только мы.
    ///
    /// Отдельно от `start_conversation`: там группа сразу рождается вдвоём, а
    /// здесь состав набирается коммитами. Пустая группа — нормальное состояние
    /// канала, в который ещё никого не позвали.
    pub fn create_group(&mut self) -> Result<Vec<u8>> {
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            // Дерево едет внутри Welcome: другого канала у получателя нет.
            .use_ratchet_tree_extension(true)
            .padding_size(PADDING_BLOCK)
            .build();

        let group = MlsGroup::new(&self.provider, &self.signer, &config, self.credential.clone())
            .map_err(|_| CoreError::Mls("mls group create".into()))?;

        Ok(group.group_id().as_slice().to_vec())
    }

    /// Добавляет участников одним коммитом.
    ///
    /// Возвращает пару: коммит — тем, кто уже в группе, приглашение — новым.
    /// Один коммит на всех, а не по одному на каждого: иначе состав менялся бы
    /// N раз подряд, и каждый промежуточный шаг пришлось бы разослать.
    ///
    /// `key_packages` — пакет и устройство, которому он обязан принадлежать.
    /// Пакет, пришедший не от того устройства, отвергается: сервер здесь
    /// почтовый ящик, а не авторитет.
    pub fn add_members(
        &mut self,
        group_id: &[u8],
        key_packages: &[(Vec<u8>, [u8; KEY_LEN])],
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        if key_packages.is_empty() {
            return Err(CoreError::Rejected("некого добавлять".into()));
        }
        let mut parsed = Vec::with_capacity(key_packages.len());
        for (bytes, expect_device) in key_packages {
            parsed.push(self.parse_key_package(bytes, expect_device)?);
        }

        let mut group = self.load(group_id)?;
        let (commit, welcome, _info) = group
            .add_members(&self.provider, &self.signer, &parsed)
            .map_err(|_| CoreError::Mls("mls add member".into()))?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| CoreError::Mls("mls merge commit".into()))?;

        Ok((
            commit
                .tls_serialize_detached()
                .map_err(|_| CoreError::Mls("mls serialize commit".into()))?,
            welcome
                .tls_serialize_detached()
                .map_err(|_| CoreError::Mls("mls serialize welcome".into()))?,
        ))
    }

    /// Меняет собственный ключ в беседе, не трогая состав.
    ///
    /// Ради этого в MLS и переходят в новую эпоху: пока эпоха не сменилась,
    /// украденные ключи открывают всё, что будет написано дальше. Смена состава
    /// делает это сама, но в диалоге вдвоём состав не меняется никогда — и
    /// свойство, ради которого выбран MLS, не срабатывает ни разу.
    ///
    /// Возвращает коммит, который нужно доставить остальным участникам. Пока
    /// он не дошёл, собеседник остаётся в прежней эпохе и продолжает читать:
    /// MLS держит ключи предыдущей эпохи ровно для таких опозданий.
    pub fn rekey(&mut self, group_id: &[u8]) -> Result<Vec<u8>> {
        let mut group = self.load(group_id)?;
        let bundle = group
            .self_update(&self.provider, &self.signer, LeafNodeParameters::default())
            .map_err(|_| CoreError::Mls("mls self update".into()))?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| CoreError::Mls("mls merge commit".into()))?;

        bundle
            .commit()
            .tls_serialize_detached()
            .map_err(|_| CoreError::Mls("mls serialize commit".into()))
    }

    /// Убирает участника. Возвращает коммит для оставшихся.
    ///
    /// После коммита группа переходит в новую эпоху, и прежние ключи ушедшему
    /// уже не подходят: прочитать то, что будет написано дальше, он не сможет.
    /// Прочитанное раньше остаётся у него — забрать это невозможно, и обещать
    /// обратное нельзя.
    pub fn remove_member(&mut self, group_id: &[u8], device: &[u8; KEY_LEN]) -> Result<Vec<u8>> {
        let mut group = self.load(group_id)?;
        let index = group
            .members()
            .find(|member| {
                verify_binding(&member.credential, member.signature_key.as_slice())
                    .map(|bound| &bound == device)
                    .unwrap_or(false)
            })
            .map(|member| member.index)
            .ok_or_else(|| CoreError::Rejected("такого участника в группе нет".into()))?;

        let (commit, _welcome, _info) = group
            .remove_members(&self.provider, &self.signer, &[index])
            .map_err(|_| CoreError::Mls("mls remove member".into()))?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| CoreError::Mls("mls merge commit".into()))?;

        commit
            .tls_serialize_detached()
            .map_err(|_| CoreError::Mls("mls serialize commit".into()))
    }

    /// Шифрует сообщение в группу.
    ///
    /// В отличие от переписки вдвоём здесь нельзя назвать ожидаемого
    /// собеседника — их много. Проверяем то, что проверить можно: мы сами в
    /// составе, и за каждым листом стоит настоящее устройство (это делает
    /// `snapshot_of`). Кто именно в группе, решает не сервер, а коммиты, и
    /// добавить лишний лист втихую он не может.
    pub fn encrypt_group(&mut self, group_id: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut group = self.load(group_id)?;
        let snapshot = snapshot_of(&group)?;
        if !snapshot.members.contains(&self.device_pub) {
            return Err(CoreError::Anomaly("нас самих нет в составе группы".into()));
        }

        let ciphertext = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(|_| CoreError::Mls("mls encrypt".into()))?
            .tls_serialize_detached()
            .map_err(|_| CoreError::Mls("mls serialize".into()))?;

        guard_no_plaintext(&ciphertext, plaintext)?;
        Ok(ciphertext)
    }

    /// Состав группы: устройства участников, включая нас.
    pub fn members(&self, group_id: &[u8]) -> Result<Vec<[u8; KEY_LEN]>> {
        Ok(snapshot_of(&self.load(group_id)?)?.members)
    }

    /// Состояние беседы для сверки и проверок. Попутно перепроверяет привязку
    /// каждого участника: испорченный состав обнаружится здесь, а не на глазок.
    pub fn inspect(&self, group_id: &[u8]) -> Result<Snapshot> {
        let group = self.load(group_id)?;
        snapshot_of(&group)
    }

    /// Шифрует сообщение, предварительно убедившись, что группа выглядит так,
    /// как мы ожидаем.
    ///
    /// `expect_peer` — устройство, которому мы собирались написать. Проверка не
    /// теоретическая: если сервер сумел подсунуть в беседу лишний лист, отправка
    /// вслепую отдала бы ему открытый текст. Лучше отказаться и сказать вслух.
    pub fn encrypt(
        &mut self,
        group_id: &[u8],
        plaintext: &[u8],
        expect_peer: &[u8; KEY_LEN],
    ) -> Result<Vec<u8>> {
        let mut group = self.load(group_id)?;
        self.check_pair(&snapshot_of(&group)?, expect_peer)?;

        let ciphertext = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(|_| CoreError::Mls("mls encrypt".into()))?
            .tls_serialize_detached()
            .map_err(|_| CoreError::Mls("mls serialize".into()))?;

        guard_no_plaintext(&ciphertext, plaintext)?;
        Ok(ciphertext)
    }

    /// Диалог один на один: ровно мы и ровно тот, кому пишем.
    fn check_pair(&self, snapshot: &Snapshot, expect_peer: &[u8; KEY_LEN]) -> Result<()> {
        if snapshot.members.len() != 2 {
            return Err(CoreError::Anomaly(format!(
                "в беседе {} участников вместо двух",
                snapshot.members.len()
            )));
        }
        if !snapshot.members.contains(&self.device_pub) {
            return Err(CoreError::Anomaly("нас самих нет в составе беседы".into()));
        }
        if !snapshot.members.contains(expect_peer) {
            return Err(CoreError::Anomaly("получателя нет в составе беседы".into()));
        }
        Ok(())
    }

    /// Разбирает всё, что приезжает конвертом: Welcome, сообщение, коммит.
    pub fn process(&mut self, bytes: &[u8]) -> Result<Incoming> {
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(|_| CoreError::BadFrame)?;

        match message.extract() {
            MlsMessageBodyIn::Welcome(welcome) => self.join(welcome),
            MlsMessageBodyIn::PublicMessage(message) => self.apply(message.into()),
            MlsMessageBodyIn::PrivateMessage(message) => self.apply(message.into()),
            // KeyPackage и GroupInfo конвертами не ходят.
            _ => Err(CoreError::BadFrame),
        }
    }

    fn join(&mut self, welcome: Welcome) -> Result<Incoming> {
        // Приглашение, которое уже принимали, второй раз не разворачивается:
        // KeyPackage, на который оно выписано, одноразовый и уже израсходован.
        // Это ровно та же повторная доставка, что и у обычных сообщений, —
        // конверт надо подтвердить, а не пугать человека ошибкой.
        let staged =
            StagedWelcome::new_from_welcome(&self.provider, &join_config(), welcome, None)
                .map_err(|_| CoreError::AlreadyProcessed("приглашение уже принято"))?;

        // Кто нас позвал. Если подпись устройства над MLS-ключом не сходится,
        // приглашение отвергается целиком: в группу зовут не того.
        let sender = staged
            .welcome_sender()
            .map_err(|_| CoreError::BadFrame)?;
        let peer_device = verify_binding(sender.credential(), sender.signature_key().as_slice())?;

        let group = staged
            .into_group(&self.provider)
            .map_err(|_| CoreError::Mls("mls join group".into()))?;

        Ok(Incoming::Joined { group_id: group.group_id().as_slice().to_vec(), peer_device })
    }

    fn apply(&mut self, protocol: ProtocolMessage) -> Result<Incoming> {
        let group_id = protocol.group_id().as_slice().to_vec();
        let mut group = self.load(&group_id)?;

        // Причина сохраняется целиком: по глухому «mls process» нельзя было
        // отличить повтор уже разобранного конверта от настоящего рассинхрона,
        // а лечатся они противоположно — первый надо подтвердить и забыть,
        // второй имеет смысл попробовать ещё раз.
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(|err| classify(&err.to_string()))?;

        // Привязка проверяется на каждом сообщении, а не только при вступлении:
        // состав группы может измениться, и новый лист тоже обязан доказать,
        // что за ним стоит настоящее устройство.
        let Sender::Member(index) = processed.sender().clone() else {
            return Err(CoreError::BadFrame);
        };
        let member = group
            .members()
            .find(|member| member.index == index)
            .ok_or(CoreError::BadFrame)?;
        let sender_device = verify_binding(&member.credential, member.signature_key.as_slice())?;

        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => {
                Ok(Incoming::Message { group_id, sender_device, plaintext: message.into_bytes() })
            }
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                group
                    .merge_staged_commit(&self.provider, *commit)
                    .map_err(|_| CoreError::Mls("mls merge".into()))?;
                Ok(Incoming::Handled)
            }
            _ => Ok(Incoming::Handled),
        }
    }

    fn load(&self, group_id: &[u8]) -> Result<MlsGroup> {
        let mut group = MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(|_| CoreError::Mls("mls load group".into()))?
            .ok_or(CoreError::NoCredentials)?;

        // Беседы, заведённые до добивки, донастраиваются на месте. Иначе она
        // появилась бы только в новых, а защищать надо в первую очередь те, в
        // которых уже переписываются.
        if group.configuration().padding_size() != PADDING_BLOCK {
            group
                .set_configuration(self.provider.storage(), &join_config())
                .map_err(|_| CoreError::Mls("mls set config".into()))?;
        }
        Ok(group)
    }

    /// KeyPackage проверяется и по правилам MLS, и по привязке к тому
    /// устройству, которому мы собирались писать. Сервер здесь не авторитет,
    /// а почтовый ящик: подменённый KeyPackage обязан отвалиться.
    fn parse_key_package(&self, bytes: &[u8], expect_device: &[u8; KEY_LEN]) -> Result<KeyPackage> {
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(|_| CoreError::BadFrame)?;
        let MlsMessageBodyIn::KeyPackage(incoming) = message.extract() else {
            return Err(CoreError::BadFrame);
        };
        let key_package = incoming
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|_| CoreError::BadFrame)?;

        let leaf = key_package.leaf_node();
        let bound = verify_binding(leaf.credential(), leaf.signature_key().as_slice())?;
        if &bound != expect_device {
            return Err(CoreError::Rejected("key_package_device_mismatch".into()));
        }
        Ok(key_package)
    }
}

/// Настройки, с которыми беседа живёт после вступления.
fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder().padding_size(PADDING_BLOCK).build()
}

fn snapshot_of(group: &MlsGroup) -> Result<Snapshot> {
    let mut members = Vec::new();
    for member in group.members() {
        members.push(verify_binding(&member.credential, member.signature_key.as_slice())?);
    }
    Ok(Snapshot {
        epoch: group.epoch().as_u64(),
        epoch_authenticator: group.epoch_authenticator().as_slice().to_vec(),
        members,
    })
}

/// Канарейка: тело сообщения не имеет права быть видимым в шифротексте.
///
/// Настоящее шифрование этого никогда не допустит — проверка ловит не слабость
/// алгоритма, а обрыв в проводке: пропущенный вызов, перепутанный буфер,
/// вернувшийся отладочный путь. Стоит одно сравнение на сообщение.
///
/// Короткие тела не проверяются: на восьми байтах случайное совпадение — это
/// уже 2^-64, а на одном-двух оно вполне реально и дало бы ложную тревогу.
fn guard_no_plaintext(ciphertext: &[u8], plaintext: &[u8]) -> Result<()> {
    const MIN_CHECKED: usize = 8;
    if plaintext.len() >= MIN_CHECKED
        && ciphertext.windows(plaintext.len()).any(|window| window == plaintext)
    {
        return Err(CoreError::Anomaly("открытый текст виден в шифротексте".into()));
    }
    Ok(())
}

/// `device_pub || Ed25519_sign(device_priv, "obsidian-mls-v1" || mls_pub)`
fn bind_credential(device: &keys::SecretKey, mls_public: &[u8]) -> Vec<u8> {
    let mut identity = Vec::with_capacity(CREDENTIAL_LEN);
    identity.extend_from_slice(&device.public());
    identity.extend_from_slice(&device.sign(&binding_message(mls_public)));
    identity
}

fn binding_message(mls_public: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(DOMAIN_MLS.len() + mls_public.len());
    message.extend_from_slice(DOMAIN_MLS);
    message.extend_from_slice(mls_public);
    message
}

/// Возвращает ключ устройства, за которым стоит этот MLS-лист.
pub fn verify_binding(credential: &Credential, mls_public: &[u8]) -> Result<[u8; KEY_LEN]> {
    let basic = BasicCredential::try_from(credential.clone()).map_err(|_| CoreError::BadFrame)?;
    let identity = basic.identity();
    if identity.len() != CREDENTIAL_LEN {
        return Err(CoreError::BadFrame);
    }
    let (device_pub, signature) = identity.split_at(KEY_LEN);

    if !keys::verify(signature, &binding_message(mls_public), device_pub) {
        return Err(CoreError::Rejected("mls_binding_invalid".into()));
    }
    device_pub.try_into().map_err(|_| CoreError::BadKeyLength)
}

/// Разбор снимка. `MemoryStorage` умеет serialize/deserialize только под фичей
/// test-utils, включать которую в боевой сборке не хочется, — зато поле
/// `values` публично, и формат снимка остаётся нашим.
fn restore_storage(provider: &OpenMlsRustCrypto, snapshot: &[u8]) -> Result<()> {
    let mut cursor = 0usize;
    let mut take = |len: usize| -> Result<&[u8]> {
        let end = cursor.checked_add(len).ok_or(CoreError::StoreLocked)?;
        if end > snapshot.len() {
            return Err(CoreError::StoreLocked);
        }
        let slice = &snapshot[cursor..end];
        cursor = end;
        Ok(slice)
    };
    let read_u64 = |slice: &[u8]| -> Result<u64> {
        Ok(u64::from_be_bytes(slice.try_into().map_err(|_| CoreError::StoreLocked)?))
    };

    let count = read_u64(take(8)?)?;
    let mut values = provider.storage().values.write().expect("mls storage poisoned");
    values.clear();

    for _ in 0..count {
        let key_len = read_u64(take(8)?)? as usize;
        let value_len = read_u64(take(8)?)? as usize;
        let key = take(key_len)?.to_vec();
        let value = take(value_len)?.to_vec();
        values.insert(key, value);
    }
    Ok(())
}

/// Отличает «этот конверт уже разобран» от настоящей ошибки.
///
/// Разбор идёт по тексту ошибки OpenMLS, а не по типу: нужные варианты лежат в
/// нескольких вложенных перечислениях, часть из которых наружу не
/// экспортируется. Текст хрупче типа, поэтому неизвестное сообщение считается
/// настоящей ошибкой — в худшем случае конверт лишний раз попробуют разобрать,
/// а не потеряют.
///
/// Все три случая означают одно: ключ для этого сообщения уже израсходован.
/// Так выглядит повторная доставка после потерянного подтверждения — она
/// нормальна и не должна ни пугать человека, ни застревать в очереди.
fn classify(message: &str) -> CoreError {
    const CONSUMED: [&str; 3] = [
        "too old to be processed",
        "deleted to preserve forward secrecy",
        "Generation is too old",
    ];
    if CONSUMED.iter().any(|marker| message.contains(marker)) {
        return CoreError::AlreadyProcessed("сообщение уже было разобрано");
    }
    CoreError::Mls(format!("mls process: {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::SecretKey;

    /// Полный путь диалога: Алиса приглашает Боба и пишет ему.
    fn pair() -> (Mls, SecretKey, Mls, SecretKey) {
        let alice_device = SecretKey::generate();
        let bob_device = SecretKey::generate();
        let alice = Mls::create(&alice_device).unwrap();
        let bob = Mls::create(&bob_device).unwrap();
        (alice, alice_device, bob, bob_device)
    }

    #[test]
    fn conversation_round_trip() {
        let (mut alice, _ad, mut bob, bob_device) = pair();

        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();

        match bob.process(&welcome).unwrap() {
            Incoming::Joined { group_id: joined, .. } => assert_eq!(joined, group_id),
            other => panic!("ожидали Joined, получили {other:?}"),
        }

        let ciphertext = alice.encrypt(&group_id, b"secret message", &bob_device.public()).unwrap();
        match bob.process(&ciphertext).unwrap() {
            Incoming::Message { plaintext, .. } => assert_eq!(plaintext, b"secret message"),
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    /// Короткие сообщения не должны отличаться по длине конверта.
    ///
    /// Это и есть смысл добивки: сервер видит размер, и без неё «печатает»,
    /// «да» и «нет, давай завтра» различались бы одним только числом байт.
    #[test]
    fn short_messages_look_the_same_on_the_wire() {
        let (mut alice, _ad, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        let bodies: Vec<Vec<u8>> = vec![
            "да".as_bytes().to_vec(),
            "нет, давай завтра в три".as_bytes().to_vec(),
            crate::access::typing_signal(true).into_bytes(),
            vec![b'x'; 100],
        ];
        let sizes: Vec<usize> = bodies
            .iter()
            .map(|body| alice.encrypt(&group_id, body, &bob_device.public()).unwrap().len())
            .collect();

        let first = sizes[0];
        assert!(
            sizes.iter().all(|size| *size == first),
            "короткие сообщения обязаны быть одной длины, получили {sizes:?}",
        );

        // И при этом всё ещё читаются: добивку снимает сам MLS.
        let ciphertext = alice.encrypt(&group_id, "да".as_bytes(), &bob_device.public()).unwrap();
        match bob.process(&ciphertext).unwrap() {
            Incoming::Message { plaintext, .. } => assert_eq!(plaintext, "да".as_bytes()),
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    /// Длина растёт ступенями, а не байт в байт.
    #[test]
    fn length_grows_in_steps() {
        let (mut alice, _ad, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        let mut size = |bytes: usize| {
            alice.encrypt(&group_id, &vec![b'x'; bytes], &bob_device.public()).unwrap().len()
        };
        let small = size(10);
        let bigger = size(600);
        assert!(bigger > small, "большое сообщение обязано быть длиннее");
        // Разница кратна шагу: точный размер письма наружу не выходит.
        assert_eq!((bigger - small) % PADDING_BLOCK, 0, "шаг обязан быть кратен добивке");
    }

    /// Смена ключа переводит беседу в новую эпоху, и переписка продолжается.
    #[test]
    fn a_rekey_moves_the_epoch_and_keeps_the_thread() {
        let (mut alice, _ad, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        let before = alice.inspect(&group_id).unwrap().epoch_authenticator.clone();

        let commit = alice.rekey(&group_id).unwrap();
        let after = alice.inspect(&group_id).unwrap().epoch_authenticator.clone();
        assert_ne!(before, after, "эпоха обязана смениться");

        // Собеседник догоняет коммитом и снова видит то же состояние.
        bob.process(&commit).unwrap();
        assert_eq!(
            bob.inspect(&group_id).unwrap().epoch_authenticator,
            after,
            "после коммита обе стороны обязаны сойтись",
        );

        // И переписка продолжается в обе стороны.
        let ciphertext = alice.encrypt(&group_id, b"after rekey", &bob_device.public()).unwrap();
        match bob.process(&ciphertext).unwrap() {
            Incoming::Message { plaintext, .. } => assert_eq!(plaintext, b"after rekey"),
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    /// Состав от смены ключа не меняется — иначе это была бы другая операция.
    #[test]
    fn a_rekey_does_not_touch_the_membership() {
        let (mut alice, _ad, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        let before = alice.members(&group_id).unwrap();
        alice.rekey(&group_id).unwrap();
        assert_eq!(alice.members(&group_id).unwrap(), before);
    }

    /// Группа втроём: оба приглашённых читают одно и то же сообщение.
    #[test]
    fn group_round_trip() {
        let alice_device = SecretKey::generate();
        let bob_device = SecretKey::generate();
        let carol_device = SecretKey::generate();
        let mut alice = Mls::create(&alice_device).unwrap();
        let mut bob = Mls::create(&bob_device).unwrap();
        let mut carol = Mls::create(&carol_device).unwrap();

        let group_id = alice.create_group().unwrap();

        // Боб добавляется первым: он же получит коммит о приходе Кэрол.
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (_commit, welcome) = alice
            .add_members(&group_id, &[(bob_package, bob_device.public())])
            .unwrap();
        bob.process(&welcome).unwrap();

        let carol_package = carol.key_packages(1).unwrap().remove(0);
        let (commit, welcome) = alice
            .add_members(&group_id, &[(carol_package, carol_device.public())])
            .unwrap();
        bob.process(&commit).unwrap();
        carol.process(&welcome).unwrap();

        assert_eq!(alice.members(&group_id).unwrap().len(), 3);

        let ciphertext = alice.encrypt_group(&group_id, "всем привет".as_bytes()).unwrap();
        for member in [&mut bob, &mut carol] {
            match member.process(&ciphertext).unwrap() {
                Incoming::Message { plaintext, .. } => assert_eq!(plaintext, "всем привет".as_bytes()),
                other => panic!("ожидали Message, получили {other:?}"),
            }
        }
    }

    /// Исключённый не прочитает написанное после его ухода.
    ///
    /// Прочитанное раньше у него остаётся — забрать это невозможно, и проверка
    /// намеренно утверждает ровно то, что правда.
    #[test]
    fn removed_member_loses_the_thread() {
        let alice_device = SecretKey::generate();
        let bob_device = SecretKey::generate();
        let carol_device = SecretKey::generate();
        let mut alice = Mls::create(&alice_device).unwrap();
        let mut bob = Mls::create(&bob_device).unwrap();
        let mut carol = Mls::create(&carol_device).unwrap();

        let group_id = alice.create_group().unwrap();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (_c, welcome) = alice
            .add_members(&group_id, &[(bob_package, bob_device.public())])
            .unwrap();
        bob.process(&welcome).unwrap();

        let carol_package = carol.key_packages(1).unwrap().remove(0);
        let (commit, welcome) = alice
            .add_members(&group_id, &[(carol_package, carol_device.public())])
            .unwrap();
        bob.process(&commit).unwrap();
        carol.process(&welcome).unwrap();

        // До исключения Кэрол читает.
        let before = alice.encrypt_group(&group_id, "пока все свои".as_bytes()).unwrap();
        assert!(matches!(carol.process(&before).unwrap(), Incoming::Message { .. }));

        let commit = alice.remove_member(&group_id, &carol_device.public()).unwrap();
        bob.process(&commit).unwrap();
        let _ = carol.process(&commit);

        assert_eq!(alice.members(&group_id).unwrap().len(), 2);

        // После исключения — уже нет, а оставшийся Боб читает по-прежнему.
        let after = alice.encrypt_group(&group_id, "теперь без неё".as_bytes()).unwrap();
        assert!(
            !matches!(carol.process(&after), Ok(Incoming::Message { .. })),
            "исключённая не должна читать написанное после ухода"
        );
        match bob.process(&after).unwrap() {
            Incoming::Message { plaintext, .. } => assert_eq!(plaintext, "теперь без неё".as_bytes()),
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    /// Групповой шифротекст тоже не должен содержать открытого текста.
    #[test]
    fn group_ciphertext_does_not_leak_plaintext() {
        let alice_device = SecretKey::generate();
        let bob_device = SecretKey::generate();
        let mut alice = Mls::create(&alice_device).unwrap();
        let mut bob = Mls::create(&bob_device).unwrap();

        let group_id = alice.create_group().unwrap();
        let package = bob.key_packages(1).unwrap().remove(0);
        alice.add_members(&group_id, &[(package, bob_device.public())]).unwrap();

        let ciphertext = alice.encrypt_group(&group_id, b"topsecret").unwrap();
        assert!(!ciphertext.windows(9).any(|w| w == b"topsecret"));
    }

    #[test]
    fn ciphertext_does_not_leak_plaintext() {
        let (mut alice, _ad, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        let ciphertext = alice.encrypt(&group_id, b"topsecret", &bob_device.public()).unwrap();
        assert!(!ciphertext.windows(9).any(|w| w == b"topsecret"));
    }

    #[test]
    fn reply_travels_back() {
        let (mut alice, alice_device, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        let reply = bob.encrypt(&group_id, b"got it", &alice_device.public()).unwrap();
        match alice.process(&reply).unwrap() {
            Incoming::Message { plaintext, .. } => assert_eq!(plaintext, b"got it"),
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    #[test]
    fn sender_is_bound_to_the_device_key() {
        let (mut alice, alice_device, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();

        // Боб узнаёт, кто именно его позвал — не «какой-то участник».
        match bob.process(&welcome).unwrap() {
            Incoming::Joined { peer_device, .. } => assert_eq!(peer_device, alice_device.public()),
            other => panic!("ожидали Joined, получили {other:?}"),
        }

        let ciphertext = alice.encrypt(&group_id, b"hi", &bob_device.public()).unwrap();
        match bob.process(&ciphertext).unwrap() {
            Incoming::Message { sender_device, .. } => assert_eq!(sender_device, alice_device.public()),
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    /// Сервер отдал KeyPackage не того устройства — приглашать нельзя.
    #[test]
    fn key_package_of_a_different_device_is_rejected() {
        let (mut alice, _ad, bob, _bd) = pair();
        let mallory_device = SecretKey::generate();

        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let error = alice.start_conversation(&bob_package, &mallory_device.public()).unwrap_err();

        assert!(matches!(error, CoreError::Rejected(ref code) if code == "key_package_device_mismatch"));
    }

    /// Ради этого всё и затевалось: обе стороны считают одно и то же значение.
    #[test]
    fn both_sides_derive_the_same_epoch_authenticator() {
        let (mut alice, alice_device, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        let from_alice = alice.inspect(&group_id).unwrap();
        let from_bob = bob.inspect(&group_id).unwrap();

        assert_eq!(from_alice.epoch_authenticator, from_bob.epoch_authenticator);
        assert_eq!(from_alice.epoch, from_bob.epoch);
        assert!(!from_alice.epoch_authenticator.is_empty());

        // И состав у обоих один и тот же: мы вдвоём.
        let mut mine = from_alice.members.clone();
        let mut theirs = from_bob.members.clone();
        mine.sort();
        theirs.sort();
        assert_eq!(mine, theirs);
        assert!(mine.contains(&alice_device.public()));
        assert!(mine.contains(&bob_device.public()));
    }

    /// Посторонний считает своё значение и совпасть с нашим не может.
    #[test]
    fn a_third_party_cannot_match_the_epoch_authenticator() {
        let (mut alice, _ad, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        // Отдельная беседа тех же людей — уже другая эпоха и другое значение.
        let second_package = bob.key_packages(1).unwrap().remove(0);
        let (other_id, other_welcome) =
            alice.start_conversation(&second_package, &bob_device.public()).unwrap();
        bob.process(&other_welcome).unwrap();

        assert_ne!(
            alice.inspect(&group_id).unwrap().epoch_authenticator,
            alice.inspect(&other_id).unwrap().epoch_authenticator
        );
    }

    #[test]
    fn sending_to_the_wrong_device_is_refused() {
        let (mut alice, _ad, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        // Тот же шифротекст, но адресат не тот — отправка обязана встать.
        let stranger = SecretKey::generate().public();
        let error = alice.encrypt(&group_id, b"secret", &stranger).unwrap_err();

        assert!(matches!(error, CoreError::Anomaly(_)), "получили {error:?}");
        // А правильному адресату — проходит.
        assert!(alice.encrypt(&group_id, b"secret", &bob_device.public()).is_ok());
    }

    #[test]
    fn plaintext_canary_catches_a_broken_pipeline() {
        let body = "сообщение".as_bytes();

        // Настоящий шифротекст канарейку не трогает.
        assert!(guard_no_plaintext(&[0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77], body).is_ok());

        // А вот «шифротекст», внутри которого лежит тело, — это авария.
        let mut broken = b"header----".to_vec();
        broken.extend_from_slice(body);
        broken.extend_from_slice(b"----tail");
        assert!(matches!(guard_no_plaintext(&broken, body), Err(CoreError::Anomaly(_))));
        // Слишком короткое тело не проверяется: ложная тревога хуже пропуска.
        assert!(guard_no_plaintext(b"abc", b"abc").is_ok());
    }

    #[test]
    fn garbage_does_not_panic() {
        let (mut alice, _ad, _bob, _bd) = pair();
        assert!(alice.process(&[]).is_err());
        assert!(alice.process(&[0xff; 64]).is_err());
        assert!(alice.process(b"not an mls message at all").is_err());
    }

    #[test]
    fn state_survives_a_snapshot_round_trip() {
        let (mut alice, alice_device, mut bob, bob_device) = pair();
        let bob_package = bob.key_packages(1).unwrap().remove(0);
        let (group_id, welcome) = alice.start_conversation(&bob_package, &bob_device.public()).unwrap();
        bob.process(&welcome).unwrap();

        // Клиент перезапустился: состояние поднято из запечатанного снимка.
        let snapshot = alice.snapshot();
        let public = alice.signer_public();
        drop(alice);
        let mut alice = Mls::restore(&alice_device, &public, &snapshot).unwrap();

        let ciphertext = alice.encrypt(&group_id, b"after restart", &bob_device.public()).unwrap();
        match bob.process(&ciphertext).unwrap() {
            Incoming::Message { plaintext, .. } => assert_eq!(plaintext, b"after restart"),
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    #[test]
    fn truncated_snapshot_is_rejected() {
        let (alice, alice_device, _bob, _bd) = pair();
        let snapshot = alice.snapshot();
        let public = alice.signer_public();

        assert!(Mls::restore(&alice_device, &public, &snapshot[..snapshot.len() / 2]).is_err());
        assert!(Mls::restore(&alice_device, &public, &[]).is_err());
    }
}

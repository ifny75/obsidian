use thiserror::Error;

pub type Result<T> = std::result::Result<T, CoreError>;

/// Ошибки никогда не несут содержимого сообщений и ключей — только причину.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("key must be 32 bytes")]
    BadKeyLength,
    #[error("frame is malformed")]
    BadFrame,
    #[error("unexpected opcode {0:#04x}")]
    UnknownOpcode(u8),
    #[error("server rejected us: {0}")]
    Rejected(String),
    /// Криптография сошлась, но состояние выглядит подозрительно: не тот
    /// состав группы, лишний участник, несовпавшая привязка. Отличается от
    /// обычной ошибки тем, что это возможная атака, а не сбой.
    #[error("anomaly: {0}")]
    Anomaly(String),
    /// Код восстановления не разобран. Причина хранится текстом, потому что
    /// её показывают человеку: «код введён с ошибкой» и «в коде посторонний
    /// символ» требуют разных действий.
    #[error("recovery code: {0}")]
    BadRecoveryCode(&'static str),
    /// Конверт уже разобран раньше. Обычное следствие потерянного
    /// подтверждения, а не поломки: сервер держит конверт до ACK и присылает
    /// его снова, если ACK не дошёл.
    #[error("envelope already processed: {0}")]
    AlreadyProcessed(&'static str),
    /// Сбой внутри MLS: не удалось зашифровать, разобрать, слить коммит.
    ///
    /// Отдельно от [`CoreError::Transport`] намеренно. Раньше и то и другое было
    /// транспортной ошибкой, а клиент по ней решает «сокет мёртв, надо
    /// переподключиться». Из-за этого любая беда с состоянием группы
    /// превращалась в бесконечный цикл переподключений: связь была цела, а
    /// клиент рвал её сам и на новом соединении спотыкался о то же самое.
    #[error("mls failure: {0}")]
    Mls(String),
    #[error("wrong password or corrupted store")]
    StoreLocked,
    #[error("store not initialised")]
    NoCredentials,
    #[error("storage failure")]
    Storage(#[from] rusqlite::Error),
    #[error("encoding failure")]
    Encoding(#[from] serde_json::Error),
    #[error("transport failure: {0}")]
    Transport(String),
}

package app.obsidian.core;

/**
 * Сборка команд для ядра. Словарь общий с Windows-клиентом — он описан в
 * obsidian-core/src/command.rs, и новая возможность добавляется там.
 *
 * <p>JSON собирается вручную, без org.json: объекты здесь плоские и заранее
 * известные, зато класс остаётся обычной Java и проверяется без эмулятора.
 */
public final class Commands {

    private Commands() {
    }

    /** Есть ли уже личность в этой базе. Работает без подключения. */
    public static String status() {
        return "{\"type\":\"status\"}";
    }

    /** Заведённые беседы — события о них живут только в текущей сессии. */
    public static String conversations() {
        return "{\"type\":\"conversations\"}";
    }

    public static String disconnect() {
        return "{\"type\":\"disconnect\"}";
    }

    /** Вход уже существующей личностью. */
    public static String connect(String url) {
        StringBuilder out = new StringBuilder("{\"type\":\"connect\",\"url\":");
        quote(out, url);
        return out.append('}').toString();
    }

    /**
     * Регистрация по инвайту. {@code handle} может быть null — имя необязательно.
     */
    public static String register(String url, String handle, String invite) {
        StringBuilder out = new StringBuilder("{\"type\":\"register\",\"url\":");
        quote(out, url);
        out.append(",\"handle\":");
        quoteOrNull(out, handle);
        out.append(",\"invite\":");
        quoteOrNull(out, invite);
        return out.append('}').toString();
    }

    /** {@code recipientDevice} — 64 шестнадцатеричных символа. */
    public static String send(String recipientDevice, String body) {
        StringBuilder out = new StringBuilder("{\"type\":\"send\",\"recipient_device\":");
        quote(out, recipientDevice);
        out.append(",\"body\":");
        quote(out, body);
        return out.append('}').toString();
    }

    /**
     * Страница истории. {@code before} — курсор из предыдущей страницы, null —
     * «с самого свежего». Постранично, а не всё сразу: переписка с фотографиями
     * и голосовыми — это мегабайты base64 через границу JNI на каждое открытие.
     */
    public static String history(String conversation, int limit, String before) {
        StringBuilder out = new StringBuilder("{\"type\":\"history\",\"conversation\":");
        quote(out, conversation);
        out.append(",\"limit\":").append(limit).append(",\"before\":");
        quoteOrNull(out, before);
        return out.append('}').toString();
    }

    public static String fingerprint(String identity) {
        StringBuilder out = new StringBuilder("{\"type\":\"fingerprint\",\"identity\":");
        quote(out, identity);
        return out.append('}').toString();
    }

    public static String verify(String peerDevice) {
        StringBuilder out = new StringBuilder("{\"type\":\"verify\",\"peer_device\":");
        quote(out, peerDevice);
        return out.append('}').toString();
    }

    public static String profileGet(String query) {
        StringBuilder out = new StringBuilder("{\"type\":\"profile_get\",\"query\":");
        quote(out, query);
        return out.append('}').toString();
    }

    /** Показать код восстановления. Работает без подключения. */
    public static String recoveryCode() {
        return "{\"type\":\"recovery_code\"}";
    }

    /** Восстановление личности по записанному коду. */
    public static String recover(String url, String code) {
        StringBuilder out = new StringBuilder("{\"type\":\"recover\",\"url\":");
        quote(out, url);
        out.append(",\"code\":");
        quote(out, code);
        return out.append('}').toString();
    }

    /**
     * Включить восстановление по логину и паролю. Требует подключения: на
     * сервер кладётся запечатанная копия ключа.
     */
    public static String recoverySetup(String login, String password) {
        StringBuilder out = new StringBuilder("{\"type\":\"recovery_setup\",\"login\":");
        quote(out, login);
        out.append(",\"password\":");
        quote(out, password);
        return out.append('}').toString();
    }

    /** Убрать запечатанную копию с сервера. */
    public static String recoveryForget() {
        return "{\"type\":\"recovery_forget\"}";
    }

    /** Восстановление личности по логину и паролю. */
    public static String recoverPassword(String url, String login, String password) {
        StringBuilder out = new StringBuilder("{\"type\":\"recover_password\",\"url\":");
        quote(out, url);
        out.append(",\"login\":");
        quote(out, login);
        out.append(",\"password\":");
        quote(out, password);
        return out.append('}').toString();
    }

    public static String profileSet(String avatarMime, String avatarBase64) {
        StringBuilder out = new StringBuilder("{\"type\":\"profile_set\",\"avatar_mime\":");
        quoteOrNull(out, avatarMime);
        out.append(",\"avatar_base64\":");
        quoteOrNull(out, avatarBase64);
        return out.append('}').toString();
    }

    // --- удаление ---------------------------------------------------------------

    public static String deleteMessage(String conversation, String id, boolean forBoth) {
        StringBuilder out = new StringBuilder("{\"type\":\"delete_message\",\"conversation\":");
        quote(out, conversation);
        out.append(",\"id\":");
        quote(out, id);
        return out.append(",\"for_both\":").append(forBoth).append('}').toString();
    }

    public static String clearConversation(String conversation) {
        StringBuilder out = new StringBuilder("{\"type\":\"clear_conversation\",\"conversation\":");
        quote(out, conversation);
        return out.append('}').toString();
    }

    public static String deleteConversation(String conversation) {
        StringBuilder out = new StringBuilder("{\"type\":\"delete_conversation\",\"conversation\":");
        quote(out, conversation);
        return out.append('}').toString();
    }

    public static String typing(String recipientDevice, boolean active) {
        StringBuilder out = new StringBuilder("{\"type\":\"typing\",\"recipient_device\":");
        quote(out, recipientDevice);
        return out.append(",\"active\":").append(active).append('}').toString();
    }

    // --- приватность ----------------------------------------------------------

    public static String privacyGet() {
        return "{\"type\":\"privacy_get\"}";
    }

    /**
     * Правила уезжают целиком, готовым документом.
     *
     * Собирать вложенный JSON вручную здесь было бы источником опечаток, а
     * тянуть org.json в этот класс не хочется: он намеренно остаётся обычной
     * Java и проверяется без эмулятора. Поэтому вызывающий передаёт уже
     * сериализованный документ — тот самый, что пришёл из ядра.
     */
    public static String privacySet(String privacyJson) {
        return "{\"type\":\"privacy_set\",\"privacy\":" + privacyJson + "}";
    }

    // --- книга отношений --------------------------------------------------------

    public static String directoryList() {
        return "{\"type\":\"directory_list\"}";
    }

    /** {@code standing} — contact, approved, pending либо blocked. */
    public static String directorySet(String device, String standing) {
        StringBuilder out = new StringBuilder("{\"type\":\"directory_set\",\"device\":");
        quote(out, device);
        out.append(",\"standing\":");
        quote(out, standing);
        return out.append('}').toString();
    }

    public static String directoryForget(String device) {
        StringBuilder out = new StringBuilder("{\"type\":\"directory_forget\",\"device\":");
        quote(out, device);
        return out.append('}').toString();
    }

    // --- юзернеймы --------------------------------------------------------------

    public static String usernameSet(String name, boolean discoverable) {
        StringBuilder out = new StringBuilder("{\"type\":\"username_set\",\"name\":");
        quote(out, name);
        return out.append(",\"discoverable\":").append(discoverable).append('}').toString();
    }

    public static String usernameClear() {
        return "{\"type\":\"username_clear\"}";
    }

    public static String usernameLookup(String name) {
        StringBuilder out = new StringBuilder("{\"type\":\"username_lookup\",\"name\":");
        quote(out, name);
        return out.append('}').toString();
    }

    // --- значок и цвет профиля --------------------------------------------------

    /** Пустое поле означает «не трогать», "none" — «убрать». */
    public static String profileDecor(String emblem, String color) {
        StringBuilder out = new StringBuilder("{\"type\":\"profile_decor\"");
        if (emblem != null) {
            out.append(",\"emblem\":");
            quote(out, emblem);
        }
        if (color != null) {
            out.append(",\"color\":");
            quote(out, color);
        }
        return out.append('}').toString();
    }

    // --- панель владельца -------------------------------------------------------

    /** {@code offset} — с какого места списка продолжать. */
    public static String adminGet(int offset) {
        return "{\"type\":\"admin_get\",\"offset\":" + offset + "}";
    }

    public static String adminAction(String action, String reference) {
        StringBuilder out = new StringBuilder("{\"type\":\"admin_action\",\"action\":");
        quote(out, action);
        out.append(",\"reference\":");
        quote(out, reference);
        return out.append('}').toString();
    }

    // --- кому можно писать ------------------------------------------------------

    public static String accessGet() {
        return "{\"type\":\"access_get\"}";
    }

    /** {@code policy} — everyone либо passes. */
    public static String accessSet(String policy) {
        StringBuilder out = new StringBuilder("{\"type\":\"access_set\",\"policy\":");
        quote(out, policy);
        return out.append('}').toString();
    }

    /** {@code ttlSec} = 0 — бессрочное приглашение. */
    public static String passInvite(String label, boolean oneTime, long ttlSec) {
        StringBuilder out = new StringBuilder("{\"type\":\"pass_invite\",\"label\":");
        quoteOrNull(out, label);
        out.append(",\"one_time\":").append(oneTime);
        return out.append(",\"ttl_sec\":").append(ttlSec).append('}').toString();
    }

    public static String passRevoke(String hash) {
        StringBuilder out = new StringBuilder("{\"type\":\"pass_revoke\",\"hash\":");
        quote(out, hash);
        return out.append('}').toString();
    }

    private static void quoteOrNull(StringBuilder out, String value) {
        if (value == null || value.isEmpty()) {
            out.append("null");
        } else {
            quote(out, value);
        }
    }

    /**
     * Экранирование по RFC 8259. Текст сообщения приходит от пользователя,
     * поэтому кавычка или перевод строки не должны ломать разбор на той стороне.
     * Не-ASCII отдаётся как есть: JSON — это UTF-8.
     */
    static void quote(StringBuilder out, String value) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                case '\b':
                    out.append("\\b");
                    break;
                case '\f':
                    out.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }
}

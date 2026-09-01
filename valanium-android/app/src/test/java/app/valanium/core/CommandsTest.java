package app.valanium.core;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Сборка команд — обычная Java, поэтому проверяется без эмулятора:
 * {@code ./gradlew :app:test}.
 *
 * <p>Главное здесь — экранирование: текст сообщения пишет пользователь, и
 * кавычка или перевод строки не должны ломать разбор JSON на стороне ядра.
 */
public class CommandsTest {

    @Test
    public void recoveryCommandsMatchTheCoreVocabulary() {
        assertEquals("{\"type\":\"recovery_code\"}", Commands.recoveryCode());
        assertEquals("{\"type\":\"recovery_forget\"}", Commands.recoveryForget());
        assertEquals(
                "{\"type\":\"recover\",\"url\":\"wss://x/ws\",\"code\":\"AAAAA BBBBB\"}",
                Commands.recover("wss://x/ws", "AAAAA BBBBB"));
        assertEquals(
                "{\"type\":\"recovery_setup\",\"login\":\"alice\",\"password\":\"long enough\"}",
                Commands.recoverySetup("alice", "long enough"));
        assertEquals(
                "{\"type\":\"recover_password\",\"url\":\"wss://x/ws\",\"login\":\"alice\",\"password\":\"p\"}",
                Commands.recoverPassword("wss://x/ws", "alice", "p"));
    }

    /** Пароль — произвольный текст: кавычка в нём не должна ломать разбор. */
    @Test
    public void passwordsWithQuotesSurviveEscaping() {
        assertEquals(
                "{\"type\":\"recovery_setup\",\"login\":\"bob\",\"password\":\"a\\\"b\\\\c\"}",
                Commands.recoverySetup("bob", "a\"b\\c"));
    }

    @Test
    public void simpleCommandsAreLiteral() {
        assertEquals("{\"type\":\"status\"}", Commands.status());
        assertEquals("{\"type\":\"conversations\"}", Commands.conversations());
        assertEquals("{\"type\":\"disconnect\"}", Commands.disconnect());
    }

    @Test
    public void connectCarriesUrl() {
        assertEquals(
                "{\"type\":\"connect\",\"url\":\"wss://valanium.example/ws\"}",
                Commands.connect("wss://valanium.example/ws"));
    }

    @Test
    public void missingHandleBecomesNullNotEmptyString() {
        // Ядро отличает «имя не задано» от «имя пустое»: пустое оно отвергнет.
        String expected = "{\"type\":\"register\",\"url\":\"wss://x/ws\",\"handle\":null,\"invite\":\"code\"}";
        assertEquals(expected, Commands.register("wss://x/ws", null, "code"));
        assertEquals(expected, Commands.register("wss://x/ws", "", "code"));
    }

    @Test
    public void historyAndFingerprint() {
        assertEquals(
                "{\"type\":\"history\",\"conversation\":\"aabb\",\"limit\":40,\"before\":null}",
                Commands.history("aabb", 40, null));
        assertEquals("{\"type\":\"fingerprint\",\"identity\":\"ff\"}", Commands.fingerprint("ff"));
    }

    /** Курсор следующей страницы уезжает как есть — ядро его само и выдало. */
    @Test
    public void historyCarriesThePageCursor() {
        assertEquals(
                "{\"type\":\"history\",\"conversation\":\"aabb\",\"limit\":40,\"before\":\"1700:12\"}",
                Commands.history("aabb", 40, "1700:12"));
    }

    /** Документ правил уезжает как есть — его собрало ядро, а не мы. */
    @Test
    public void privacyDocumentTravelsWhole() {
        assertEquals(
                "{\"type\":\"privacy_set\",\"privacy\":{\"voice\":{\"scope\":\"nobody\"}}}",
                Commands.privacySet("{\"voice\":{\"scope\":\"nobody\"}}"));
        assertEquals("{\"type\":\"privacy_get\"}", Commands.privacyGet());
    }

    @Test
    public void directoryCommandsCarryTheDevice() {
        assertEquals(
                "{\"type\":\"directory_set\",\"device\":\"aa\",\"standing\":\"blocked\"}",
                Commands.directorySet("aa", "blocked"));
        assertEquals(
                "{\"type\":\"directory_forget\",\"device\":\"aa\"}",
                Commands.directoryForget("aa"));
    }

    @Test
    public void usernameCommandsAreShaped() {
        assertEquals(
                "{\"type\":\"username_set\",\"name\":\"mira\",\"discoverable\":true}",
                Commands.usernameSet("mira", true));
        assertEquals("{\"type\":\"username_clear\"}", Commands.usernameClear());
        assertEquals(
                "{\"type\":\"username_lookup\",\"name\":\"mira\"}",
                Commands.usernameLookup("mira"));
    }

    /** Пустая заметка уезжает как null, а не пустой строкой. */
    @Test
    public void inviteWithoutLabelSendsNull() {
        assertEquals(
                "{\"type\":\"pass_invite\",\"label\":null,\"one_time\":true,\"ttl_sec\":3600}",
                Commands.passInvite("", true, 3600));
        assertEquals(
                "{\"type\":\"pass_invite\",\"label\":\"для Миры\",\"one_time\":false,\"ttl_sec\":0}",
                Commands.passInvite("для Миры", false, 0));
    }

    @Test
    public void accessCommandsAreShaped() {
        assertEquals("{\"type\":\"access_get\"}", Commands.accessGet());
        assertEquals("{\"type\":\"access_set\",\"policy\":\"passes\"}", Commands.accessSet("passes"));
        assertEquals("{\"type\":\"pass_revoke\",\"hash\":\"ff\"}", Commands.passRevoke("ff"));
    }

    @Test
    public void quotesInsideMessageAreEscaped() {
        assertEquals(
                "{\"type\":\"send\",\"recipient_device\":\"ab\",\"body\":\"он сказал \\\"да\\\"\"}",
                Commands.send("ab", "он сказал \"да\""));
    }

    @Test
    public void newlinesAndBackslashesAreEscaped() {
        assertEquals(
                "{\"type\":\"send\",\"recipient_device\":\"ab\",\"body\":\"первая\\nвторая\"}",
                Commands.send("ab", "первая\nвторая"));
        assertEquals(
                "{\"type\":\"send\",\"recipient_device\":\"ab\",\"body\":\"C:\\\\путь\"}",
                Commands.send("ab", "C:\\путь"));
    }

    @Test
    public void controlCharactersBecomeEscapes() {
        assertEquals(
                "{\"type\":\"send\",\"recipient_device\":\"ab\",\"body\":\"до\\u0001после\"}",
                Commands.send("ab", "до\u0001после"));
    }

    @Test
    public void nonAsciiStaysAsIs() {
        // JSON — это UTF-8, экранировать кириллицу незачем.
        assertEquals(
                "{\"type\":\"send\",\"recipient_device\":\"ab\",\"body\":\"привет ✓\"}",
                Commands.send("ab", "привет ✓"));
    }
}

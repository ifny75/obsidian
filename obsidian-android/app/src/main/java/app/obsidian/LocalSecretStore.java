package app.obsidian;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Хранит ключ локальной базы зашифрованным ключом из Android Keystore.
 *
 * <h2>Замок приложения</h2>
 *
 * По умолчанию ключ доступен приложению всегда: база открывается мгновенно, и
 * это правильное поведение по умолчанию — мессенджер, который спрашивает
 * отпечаток при каждом запуске, начинают закрывать вместо того, чтобы им
 * пользоваться.
 *
 * Включённый замок переносит секрет под второй ключ Keystore, заведённый с
 * setUserAuthenticationRequired. Дальше решает система: без свежей
 * разблокировки владельцем (отпечаток, лицо, PIN — что настроено) ключ
 * попросту не выдаётся, и расшифровать секрет базы не может даже наше
 * собственное приложение.
 *
 * <h2>Что замок закрывает, а что нет</h2>
 *
 * Закрывает открытие базы: телефон в чужих руках, приложение запускают заново
 * — без подтверждения дальше заставки не пройти. И закрывает вытаскивание
 * секрета из настроек: он зашифрован ключом, который система не отдаёт.
 *
 * Не закрывает уже открытую базу: пока приложение работает, ключ живёт в
 * памяти ядра, и фоновая служба продолжает принимать сообщения. Иначе замок
 * означал бы «мессенджер не работает, пока на него не смотрят».
 *
 * <h2>Почему это выключено по умолчанию</h2>
 *
 * Замок требует настроенной блокировки экрана. У кого её нет — включить
 * нельзя, и делать вид, что включили, нельзя тем более: ключ с требованием
 * аутентификации на телефоне без пароля не заводится вовсе.
 */
final class LocalSecretStore {

    private static final String KEY_ALIAS = "obsidian.database.key.v1";
    /** Тот же секрет, но под ключом, который система отдаёт только владельцу. */
    private static final String LOCKED_ALIAS = "obsidian.database.key.locked.v1";
    private static final String PREFS = "obsidian.secure.local";
    private static final String VALUE = "database_secret";
    private static final String IV = "database_secret_iv";
    /** Сколько секунд после подтверждения ключ остаётся доступным. 0 — замка нет. */
    private static final String LOCK_SECONDS = "lock_seconds";

    private final Context context;
    private final SharedPreferences preferences;

    LocalSecretStore(Context context) {
        this.context = context.getApplicationContext();
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Включён ли замок. */
    boolean locked() {
        return lockSeconds() > 0;
    }

    /** Через сколько секунд бездействия спрашивать снова. 0 — не спрашивать. */
    int lockSeconds() {
        return preferences.getInt(LOCK_SECONDS, 0);
    }

    /** Есть ли на телефоне то, чем подтверждать: PIN, узор, пароль, биометрия. */
    boolean deviceCredentialAvailable() {
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    /**
     * Переносит секрет под ключ с подтверждением.
     *
     * Порядок важен: сначала читаем секрет старым ключом, потом заводим новый,
     * потом перезаписываем и только затем удаляем старый. Прервись это
     * посередине — секрет останется читаемым хотя бы одним из ключей.
     */
    void enableLock(int seconds) throws Exception {
        if (!deviceCredentialAvailable()) {
            throw new IllegalStateException("no device credential");
        }
        String secret = load();
        if (secret == null) {
            throw new IllegalStateException("nothing to lock");
        }
        deleteKey(LOCKED_ALIAS);
        createKey(LOCKED_ALIAS, seconds);
        preferences.edit().putInt(LOCK_SECONDS, seconds).commit();
        try {
            save(secret);
        } catch (Exception failed) {
            // Не вышло перезаписать — откатываемся на прежний ключ, иначе
            // человек останется с базой, которую нечем открыть.
            preferences.edit().putInt(LOCK_SECONDS, 0).commit();
            deleteKey(LOCKED_ALIAS);
            throw failed;
        }
        deleteKey(KEY_ALIAS);
    }

    /** Возвращает секрет под обычный ключ. Требует уже пройденного подтверждения. */
    void disableLock() throws Exception {
        String secret = load();
        if (secret == null) {
            throw new IllegalStateException("nothing to unlock");
        }
        preferences.edit().putInt(LOCK_SECONDS, 0).commit();
        deleteKey(KEY_ALIAS);
        save(secret);
        deleteKey(LOCKED_ALIAS);
    }

    String load() throws Exception {
        String encoded = preferences.getString(VALUE, null);
        String encodedIv = preferences.getString(IV, null);
        if (encoded == null || encodedIv == null) {
            return null;
        }

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(),
                new GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP)));
        byte[] plain = cipher.doFinal(Base64.decode(encoded, Base64.NO_WRAP));
        return new String(plain, StandardCharsets.UTF_8);
    }

    void save(String secret) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(secret.getBytes(StandardCharsets.UTF_8));
        preferences.edit()
                .putString(VALUE, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .commit();
    }

    static String randomSecret() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private SecretKey key() throws Exception {
        String alias = locked() ? LOCKED_ALIAS : KEY_ALIAS;
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry existing = store.getEntry(alias, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }
        return createKey(alias, locked() ? lockSeconds() : 0);
    }

    /** Заводит ключ. seconds больше нуля — с требованием подтверждения. */
    private SecretKey createKey(String alias, int seconds) throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true);

        if (seconds > 0) {
            spec.setUserAuthenticationRequired(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Годится и биометрия, и код разблокировки: навязывать палец
                // нельзя, у части людей его просто нет в настройках.
                spec.setUserAuthenticationParameters(
                        seconds,
                        KeyProperties.AUTH_BIOMETRIC_STRONG
                                | KeyProperties.AUTH_DEVICE_CREDENTIAL);
            } else {
                spec.setUserAuthenticationValidityDurationSeconds(seconds);
            }
        }
        generator.init(spec.build());
        return generator.generateKey();
    }

    private void deleteKey(String alias) {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(alias);
        } catch (Exception ignored) {
            // Нечего удалять или хранилище недоступно — не повод падать:
            // лишний неиспользуемый ключ безвреден.
        }
    }
}

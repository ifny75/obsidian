package app.valanium.core;

import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Мост к valanium-core. Ни криптографии, ни ключей, ни протокола здесь нет —
 * всё это живёт в Rust. Наружу торчат команды и события в JSON.
 *
 * <p>События забираются опросом, а не колбэком: колбэк из Rust-потока в JVM
 * потребовал бы AttachCurrentThread и GlobalRef и легко даёт UB при ошибке.
 * Один фоновый поток, крутящий {@link #poll(int)}, не требует ничего.
 *
 * <p><b>Про блокировку.</b> {@link #poll(int)} висит на нативной стороне до
 * таймаута, а {@link #close()} освобождает ту самую сессию — вызов close во
 * время poll был бы use-after-free. Поэтому poll держит read-замок, а close
 * ждёт write-замок: закрытие произойдёт не раньше, чем poll вернётся.
 */
public final class Core {

    static {
        System.loadLibrary("valanium");
    }

    private static native long nativeInit(String dbPath, String password);

    private static native boolean nativeVerifyDatabaseKey(String dbPath, String password);

    private static native boolean nativeVerifyRelease(String manifest, String signature);

    private static native int nativeSubmit(long handle, String json);

    private static native String nativePoll(long handle, int timeoutMs);

    private static native void nativeShutdown(long handle);

    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    /** 0 — сессии нет. Меняется только под write-замком. */
    private long handle;

    /**
     * Открывает локальную базу. Пароль дальше не хранится: им выводится ключ
     * запечатывания записей и он остаётся в нативной части.
     *
     * @return false — чаще всего неверный пароль.
     */
    public boolean open(String dbPath, String password) {
        lock.writeLock().lock();
        try {
            if (handle != 0) {
                return true;
            }
            handle = nativeInit(dbPath, password);
            return handle != 0;
        } finally {
            lock.writeLock().unlock();
        }
    }

    /** Проверяет старый пароль по зашифрованному keyring до сохранения в Keystore. */
    public boolean verifyDatabaseKey(String dbPath, String password) {
        return nativeVerifyDatabaseKey(dbPath, password);
    }

    /** Проверяет точные байты манифеста закреплённым offline release-ключом. */
    public boolean verifyRelease(String manifest, String signature) {
        return nativeVerifyRelease(manifest, signature);
    }

    public boolean isOpen() {
        lock.readLock().lock();
        try {
            return handle != 0;
        } finally {
            lock.readLock().unlock();
        }
    }

    /** Команда в формате JSON — см. {@link Commands}. */
    public boolean submit(String json) {
        lock.readLock().lock();
        try {
            return handle != 0 && nativeSubmit(handle, json) == 0;
        } finally {
            lock.readLock().unlock();
        }
    }

    /** Одно событие в JSON; ждёт до timeoutMs. null — ничего не пришло. */
    public String poll(int timeoutMs) {
        lock.readLock().lock();
        try {
            return handle == 0 ? null : nativePoll(handle, timeoutMs);
        } finally {
            lock.readLock().unlock();
        }
    }

    /** Идемпотентно: повторный вызов ничего не делает. */
    public void close() {
        lock.writeLock().lock();
        try {
            if (handle != 0) {
                nativeShutdown(handle);
                handle = 0;
            }
        } finally {
            lock.writeLock().unlock();
        }
    }
}

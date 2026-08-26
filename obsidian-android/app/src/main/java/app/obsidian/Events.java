package app.obsidian;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * События ядра доезжают до интерфейса. Поток опроса живёт в сервисе, а
 * подписчики хотят получать события на главном потоке — здесь переход.
 *
 * <p>Список подписчиков copy-on-write: подписка и отписка происходят в
 * onStart/onStop активности, то есть редко, а обход — на каждом событии.
 */
public final class Events {

    public interface Listener {
        void onEvent(JSONObject event);
    }

    private static final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());

    private Events() {
    }

    public static void subscribe(Listener listener) {
        listeners.add(listener);
    }

    public static void unsubscribe(Listener listener) {
        listeners.remove(listener);
    }

    /** Вызывается из потока опроса. Разбор здесь, доставка — на главном. */
    static void publish(String json) {
        final JSONObject event;
        try {
            event = new JSONObject(json);
        } catch (Exception malformed) {
            // Ядро прислало не-JSON: это баг ядра, но ронять приложение незачем.
            return;
        }
        main.post(() -> {
            for (Listener listener : listeners) {
                listener.onEvent(event);
            }
        });
    }
}

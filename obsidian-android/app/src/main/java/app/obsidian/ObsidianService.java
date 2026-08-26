package app.obsidian;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import app.obsidian.core.Core;

/**
 * Держит соединение живым. Без foreground-сервиса Doze прибивает WebSocket, и
 * сообщения перестают приходить, пока экран выключен.
 *
 * <p>Сервис владеет ядром и потоком опроса. Ядро — синглтон процесса: база
 * открывается один раз, поворот экрана и пересоздание активности его не трогают.
 */
public final class ObsidianService extends Service {

    private static final String CHANNEL = "obsidian.connection";
    private static final int NOTIFICATION_ID = 1;
    /** Шаг опроса. Поток спит в нативной части, процессор не жжётся. */
    private static final int POLL_TIMEOUT_MS = 500;

    private static final Core core = new Core();

    private volatile boolean running;
    private Thread poller;

    /** Ядро процесса. Активность открывает базу до старта сервиса. */
    public static Core core() {
        return core;
    }

    public static void start(Context context) {
        Intent intent = new Intent(context, ObsidianService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, ObsidianService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            createChannel();
            startForeground(NOTIFICATION_ID, buildNotification());
        } catch (RuntimeException unavailable) {
            // Некоторые hardened-системы могут запретить foreground-сервис.
            // Не роняем весь процесс: активность подхватит опрос событий сама.
            Events.publish("{\"type\":\"service_unavailable\"}");
            stopSelf();
            return;
        }

        running = true;
        poller = new Thread(this::pollLoop, "obsidian-poll");
        poller.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Система вправе убить сервис при нехватке памяти — просим поднять его
        // обратно: соединение важнее экономии.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (poller != null) {
            // poll держит read-замок и вернётся не позже таймаута, после чего
            // close получит write-замок. Ждём именно поэтому.
            try {
                poller.join(2000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        core.close();
        super.onDestroy();
    }

    private void pollLoop() {
        while (running) {
            String event = core.poll(POLL_TIMEOUT_MS);
            if (event != null) {
                Events.publish(event);
            }
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW);
        // Тихо и без всплытия: это индикатор, а не уведомление о сообщении.
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);

        // В уведомлении не должно быть ни имён, ни текстов — оно видно на
        // заблокированном экране.
        return builder
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.notification_connected))
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .build();
    }
}

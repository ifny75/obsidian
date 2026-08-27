package app.obsidian;

import android.app.Activity;
import android.app.AlertDialog;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.net.Uri;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import app.obsidian.core.Commands;

/** Нативный мобильный интерфейс поверх общего Rust-ядра Obsidian. */
public final class MainActivity extends Activity implements Events.Listener {

    private static final String SERVER_URL = "wss://getobsidian.xyz/ws";
    private static final String RELEASES_URL = "https://getobsidian.xyz/v1/releases/latest";
    private static final String APP_VERSION = "0.5.6";
    /** Сколько сообщений поднимать за раз. Остальное — по прокрутке вверх. */
    private static final int HISTORY_PAGE = 40;

    /**
     * Уже поднятая переписка — на время сеанса.
     *
     * Хранятся готовые пузыри, поэтому повторное открытие чата не стоит ничего:
     * ни обращения к ядру, ни расшифровки, ни повторного разбора base64 у фото
     * и голосовых. Только в памяти и намеренно: расшифрованный текст в
     * SharedPreferences пережил бы закрытие приложения и обошёл бы весь смысл
     * запечатанной базы.
     */
    private final Map<String, ChatPage> pages = new LinkedHashMap<>();

    /** Правила приватности целиком — тот же документ, что лежит в ядре. */
    private JSONObject privacy;
    /** Книга отношений: устройство → запись. */
    private final Map<String, JSONObject> directory = new LinkedHashMap<>();
    private JSONObject access;
    private String username;
    private View screenPrivacy;
    private View screenPrivacySection;
    private View screenUsername;
    private View screenSecurity;
    private View screenAdmin;
    private View screenChatSettings;
    private View screenData;

    /**
     * Открытые каналы: лента, которую ведёт один человек.
     *
     * Единственное место, где содержимое уходит на сервер незашифрованным, — и
     * потому единственное, где интерфейс обязан об этом сказать вслух. Канал
     * открыт по своей природе: подписаться может кто угодно, значит и ключ
     * достался бы любому. Предупреждение висит над лентой, а не в настройках.
     */
    private final Map<String, JSONObject> channels = new LinkedHashMap<>();
    private View screenChannel;
    private String openChannel;
    private Long channelOldest;

    /** Нижний островок: три корневых экрана и размытая подложка. */
    private BlurPanel tabBar;

    /** Признаёт ли сервер это устройство владельцем. Решает сервер, не мы. */
    private boolean admin;

    /** Умеет ли сервер значки и цвета. Старый рвёт соединение на таком кадре. */
    private boolean decorSupported;

    /** Свои значок и цвет. Пусто — не выбраны. */
    private String myEmblem = "";
    private String myColor = "";
    private View screenAppearance;

    /**
     * Куда вернёт «назад».
     *
     * Раньше «назад» с любого экрана вело на список переписок, а из приватности
     * и оформления не вело никуда — приложение просто закрывалось. Теперь путь
     * запоминается: раздел приватности → список разделов → настройки → главная.
     */
    private final List<View> history = new ArrayList<>();
    private View currentScreen;

    /**
     * Куда идёт переход: 1 — вглубь, -1 — назад.
     *
     * Экран приезжает с той стороны, куда движется путь, и уезжает в
     * противоположную. Без этого «вперёд» и «назад» выглядят одинаково, и
     * взгляд теряет, где он оказался.
     */
    private int navDirection = 1;

    /** Чем сейчас отфильтрован список переписок. Пусто — показываем всё. */
    private String listFilter = "";

    /** Имя, по которому спросили каталог, и что ответили. */
    private String lookupQuery;
    private JSONObject lookupHit;
    private boolean lookupMissed;
    private Runnable lookupSoon;
    private LinearLayout privacyGroups;
    private LinearLayout requestList;

    /** Состояние одной беседы в кэше. */
    private static final class ChatPage {
        final List<View> bubbles = new ArrayList<>();
        String oldest;
        boolean hasMore = true;
        boolean loading;
        boolean loaded;
        /** Отрицательное — «прокрутить вниз», как при первом открытии. */
        int scrollY = -1;
    }

    private ChatPage page(String conversation) {
        ChatPage entry = pages.get(conversation);
        if (entry == null) {
            entry = new ChatPage();
            pages.put(conversation, entry);
        }
        return entry;
    }
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private static final int AVATAR_PICK_REQUEST = 1002;
    private static final int PHOTO_PICK_REQUEST = 1003;
    private static final int MICROPHONE_PERMISSION_REQUEST = 1004;
    /** Дольше не пишем: сообщение обязано пролезть в один кадр сервера. */
    private static final int MAX_VOICE_SEC = 120;
    private static final String CONTENT_PREFIX = "\u2063OBS1:";

    private final Map<String, String> conversations = new LinkedHashMap<>();
    private final Map<String, Profile> profiles = new LinkedHashMap<>();

    private View screenBoot;
    private View screenMigrate;
    private View screenEntry;
    private View screenChat;
    private View screenConversation;
    private View screenProfile;
    private View screenSettings;
    private EditText migrationPassword;
    private EditText handle;
    private EditText invite;
    private Button entrySubmit;
    private TextView myDevice;
    private View status;
    private String statusText = "";
    private EditText newPeer;
    private LinearLayout contactList;
    private LinearLayout messages;
    private ScrollView messagesScroll;
    private EditText composer;
    private TextView peerName;
    private TextView peerAvatar;
    private TextView myChatCode;
    private TextView profileChatCode;
    private TextView profileFingerprint;
    private TextView profileAvatar;
    private SeekBar messageTextSize;
    private SeekBar messageWidth;
    private TextView messageTextValue;
    private TextView messageWidthValue;
    private TextView settingsPreviewIn;
    private TextView settingsPreviewOut;
    private SeekBar interfaceScale;
    private TextView interfaceScaleValue;
    private Switch compactMessages;
    private Switch squareAvatars;
    private SeekBar cornerRadius;
    private SeekBar bubbleRadius;
    private TextView cornerRadiusValue;
    private TextView bubbleRadiusValue;
    private View screenRecover;
    private View recoverFormCode;
    private View recoverFormPassword;
    private EditText recoverCode;
    private EditText recoverLogin;
    private EditText recoverPassword;
    private Button recoverSubmit;
    private TextView recoverError;
    private boolean recoverByCode = true;
    private TextView recoveryCodeText;
    private Button recoveryCodeToggle;
    private Button recoveryCodeCopy;
    private Button recoveryPasswordSave;
    private EditText recoveryLogin;
    private EditText recoveryPassword;
    private TextView recoveryStatus;
    private String recoveryCodeValue = "";
    private View recordingBar;
    private TextView recordingTime;
    private android.widget.ImageButton recordVoice;
    private MediaRecorder voiceRecorder;
    private File voiceFile;
    private long voiceStartedAt;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Runnable voiceTicker;
    private MediaPlayer voicePlayer;
    private SharedPreferences appearancePreferences;
    private final Set<String> readIds = new HashSet<>();
    private final Set<String> sentReadIds = new HashSet<>();

    private String currentPeer;
    private String myDeviceHex = "";
    private String myIdentityHex = "";
    private String ownChatCode = "";
    private String pendingChatCode;
    private boolean profilesSupported;
    private volatile boolean localPolling;
    private Thread localPoller;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();
        setContentView(R.layout.activity_main);

        screenBoot = findViewById(R.id.screen_boot);
        screenMigrate = findViewById(R.id.screen_migrate);
        screenEntry = findViewById(R.id.screen_entry);
        screenChat = findViewById(R.id.screen_chat);
        screenConversation = findViewById(R.id.screen_conversation);
        screenProfile = findViewById(R.id.screen_profile);
        screenSettings = findViewById(R.id.screen_settings);
        screenPrivacy = findViewById(R.id.screen_privacy);
        screenPrivacySection = findViewById(R.id.screen_privacy_section);
        screenChannel = findViewById(R.id.screen_channel);
        tabBar = findViewById(R.id.tab_bar);
        screenUsername = findViewById(R.id.screen_username);
        screenSecurity = findViewById(R.id.screen_security);
        screenAdmin = findViewById(R.id.screen_admin);
        screenChatSettings = findViewById(R.id.screen_chat_settings);
        screenData = findViewById(R.id.screen_data);
        screenAppearance = findViewById(R.id.screen_appearance);
        privacyGroups = findViewById(R.id.privacy_groups);
        requestList = findViewById(R.id.request_list);
        migrationPassword = findViewById(R.id.migration_password);
        handle = findViewById(R.id.handle);
        invite = findViewById(R.id.invite);
        invite.setVisibility(View.GONE);
        entrySubmit = findViewById(R.id.entry_submit);
        myDevice = findViewById(R.id.my_device);
        status = findViewById(R.id.status);
        status.setOnClickListener(v -> toast(statusText));
        newPeer = findViewById(R.id.new_peer);
        contactList = findViewById(R.id.contact_list);
        messages = findViewById(R.id.messages);
        messagesScroll = findViewById(R.id.messages_scroll);
        composer = findViewById(R.id.composer);
        peerName = findViewById(R.id.peer_name);
        peerAvatar = findViewById(R.id.peer_avatar);
        myChatCode = findViewById(R.id.my_chat_code);
        profileChatCode = findViewById(R.id.profile_chat_code);
        profileFingerprint = findViewById(R.id.profile_fingerprint);
        profileAvatar = findViewById(R.id.profile_avatar);
        messageTextSize = findViewById(R.id.message_text_size);
        messageWidth = findViewById(R.id.message_width);
        messageTextValue = findViewById(R.id.message_text_value);
        messageWidthValue = findViewById(R.id.message_width_value);
        settingsPreviewIn = findViewById(R.id.settings_preview_in);
        settingsPreviewOut = findViewById(R.id.settings_preview_out);
        interfaceScale = findViewById(R.id.interface_scale);
        interfaceScaleValue = findViewById(R.id.interface_scale_value);
        compactMessages = findViewById(R.id.compact_messages);
        squareAvatars = findViewById(R.id.square_avatars);
        cornerRadius = findViewById(R.id.corner_radius);
        bubbleRadius = findViewById(R.id.bubble_radius);
        cornerRadiusValue = findViewById(R.id.corner_radius_value);
        bubbleRadiusValue = findViewById(R.id.bubble_radius_value);
        screenRecover = findViewById(R.id.screen_recover);
        recoverFormCode = findViewById(R.id.recover_form_code);
        recoverFormPassword = findViewById(R.id.recover_form_password);
        recoverCode = findViewById(R.id.recover_code);
        recoverLogin = findViewById(R.id.recover_login);
        recoverPassword = findViewById(R.id.recover_password);
        recoverSubmit = findViewById(R.id.recover_submit);
        recoverError = findViewById(R.id.recover_error);
        recoveryCodeText = findViewById(R.id.recovery_code_text);
        recoveryCodeToggle = findViewById(R.id.recovery_code_toggle);
        recoveryCodeCopy = findViewById(R.id.recovery_code_copy);
        recoveryPasswordSave = findViewById(R.id.recovery_password_save);
        recoveryLogin = findViewById(R.id.recovery_login);
        recoveryPassword = findViewById(R.id.recovery_password);
        recoveryStatus = findViewById(R.id.recovery_status);
        recordingBar = findViewById(R.id.recording_bar);
        recordingTime = findViewById(R.id.recording_time);
        recordVoice = findViewById(R.id.record_voice);

        findViewById(R.id.migrate).setOnClickListener(v -> migrateLegacyDatabase());
        findViewById(R.id.reset_legacy).setOnClickListener(v -> confirmResetLegacyDatabase());
        entrySubmit.setOnClickListener(v -> register());
        findViewById(R.id.send).setOnClickListener(v -> send());
        findViewById(R.id.open_chat).setOnClickListener(v -> openNewChat());
        myDevice.setOnClickListener(v -> copyDevice());
        myChatCode.setOnClickListener(v -> copyChatCode());
        profileChatCode.setOnClickListener(v -> copyChatCode());
        findViewById(R.id.chat_back).setOnClickListener(v -> goBack());
        findViewById(R.id.profile_back).setOnClickListener(v -> goBack());
        findViewById(R.id.settings_back).setOnClickListener(v -> goBack());
        findViewById(R.id.privacy_back).setOnClickListener(v -> goBack());
        findViewById(R.id.privacy_section_back).setOnClickListener(v -> goBack());
        findViewById(R.id.appearance_back).setOnClickListener(v -> goBack());
        findViewById(R.id.open_appearance).setOnClickListener(v -> open(screenAppearance));
        findViewById(R.id.open_profile_row).setOnClickListener(v -> open(screenProfile));
        findViewById(R.id.chat_code_row).setOnClickListener(v -> copyChatCode());
        findViewById(R.id.nav_chats).setOnClickListener(v -> switchTab(screenChat));
        findViewById(R.id.channel_back).setOnClickListener(v -> goBack());
        findViewById(R.id.channel_create).setOnClickListener(v -> askNewChannel());
        findViewById(R.id.channel_find).setOnClickListener(v -> askFindChannel());
        findViewById(R.id.channel_subscribe).setOnClickListener(v -> toggleSubscription());
        findViewById(R.id.channel_send).setOnClickListener(v -> publishPost());
        findViewById(R.id.nav_settings).setOnClickListener(v -> switchTab(screenSettings));
        findViewById(R.id.nav_profile).setOnClickListener(v -> switchTab(screenProfile));
        findViewById(R.id.username_back).setOnClickListener(v -> goBack());
        findViewById(R.id.security_back).setOnClickListener(v -> goBack());
        findViewById(R.id.admin_back).setOnClickListener(v -> goBack());
        findViewById(R.id.chat_settings_back).setOnClickListener(v -> goBack());
        findViewById(R.id.data_back).setOnClickListener(v -> goBack());
        findViewById(R.id.open_username).setOnClickListener(v -> open(screenUsername));
        findViewById(R.id.open_security).setOnClickListener(v -> open(screenSecurity));
        findViewById(R.id.open_emblem).setOnClickListener(v -> chooseEmblem());
        findViewById(R.id.open_profile_color).setOnClickListener(v -> chooseProfileColor());
        findViewById(R.id.open_fingerprint).setOnClickListener(v -> showFingerprint());
        findViewById(R.id.copy_chat_code_row).setOnClickListener(v -> copyChatCode());
        findViewById(R.id.copy_device_row).setOnClickListener(v -> copyDevice());
        findViewById(R.id.copy_identity_row).setOnClickListener(v -> {
            if (myIdentityHex.isEmpty()) return;
            copyToClipboard(myIdentityHex, getString(R.string.identity_copied));
        });
        findViewById(R.id.open_admin).setOnClickListener(v -> openAdmin());
        wireAdmin();
        wireData();
        findViewById(R.id.copy_chat_code).setOnClickListener(v -> copyChatCode());
        findViewById(R.id.open_chat_settings).setOnClickListener(v -> open(screenChatSettings));
        findViewById(R.id.open_data).setOnClickListener(v -> {
            open(screenData);
            renderDataSizes();
        });
        findViewById(R.id.open_privacy).setOnClickListener(v -> {
            open(screenPrivacy);
            renderPrivacySections();
        });
        findViewById(R.id.open_invites).setOnClickListener(v -> showInvites());
        findViewById(R.id.peer_name).setOnClickListener(v -> {
            if (currentPeer != null) showPeerCard(currentPeer);
        });
        findViewById(R.id.peer_avatar).setOnClickListener(v -> {
            if (currentPeer != null) showPeerCard(currentPeer);
        });
        findViewById(R.id.reply_cancel).setOnClickListener(v -> setReply(null, null));
        wireUsername();
        wireTyping();
        wireSearch();
        wireListTabs();
        findViewById(R.id.avatar_upload).setOnClickListener(v -> chooseAvatar());
        findViewById(R.id.attach_photo).setOnClickListener(v -> choosePhoto());
        findViewById(R.id.verify_peer).setOnClickListener(v -> { if (currentPeer != null) submit(Commands.verify(currentPeer)); });
        configureRecovery();
        configureVoice();
        configurePreferences();
        wireChatSettings();
        configureInsets();

        show(screenBoot);
        requestNotificationPermission();
        try {
            if (ObsidianService.core().isOpen()) {
                getWindow().getDecorView().post(() -> {
                    startEventDelivery();
                    submit(Commands.status());
                });
            } else {
                autoOpenDatabase();
            }
        } catch (Throwable error) {
            showStartupError(error);
        }
        new Handler(Looper.getMainLooper()).postDelayed(this::checkForUpdates, 1800);
    }

    @Override
    protected void onStart() {
        super.onStart();
        Events.subscribe(this);
        try {
            if (ObsidianService.core().isOpen() && !canUseForegroundService()) {
                startLocalPolling();
            }
        } catch (Throwable error) {
            showStartupError(error);
        }
    }

    @Override
    protected void onStop() {
        stopRecording(false);
        stopVoicePlayback();
        stopLocalPolling();
        Events.unsubscribe(this);
        super.onStop();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
            int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == MICROPHONE_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startRecording();
            } else {
                toast(getString(R.string.voice_permission_needed));
            }
            return;
        }
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED
                && ObsidianService.core().isOpen()) {
            stopLocalPolling();
            startEventDelivery();
        } else if (ObsidianService.core().isOpen()) {
            startLocalPolling();
            toast(getString(R.string.background_limited));
        }
    }

    private void configureWindow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.BLACK);
        window.setNavigationBarColor(Color.BLACK);
        // Тёмный режим системных иконок уже задан темой. Не запрашиваем
        // InsetsController до появления DecorView: Android 17 в таком случае
        // выбрасывает NPE внутри PhoneWindow ещё до setContentView().
    }

    private void configureInsets() {
        if (Build.VERSION.SDK_INT < 30) return;
        View root = findViewById(R.id.app_root);
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars());
            Insets ime = windowInsets.getInsets(WindowInsets.Type.ime());
            view.setPadding(dp(16), bars.top + dp(8), dp(16),
                    Math.max(bars.bottom, ime.bottom) + dp(8));
            return windowInsets;
        });
        root.requestApplyInsets();
    }

    private void configurePreferences() {
        SharedPreferences preferences = getSharedPreferences("appearance", MODE_PRIVATE);
        appearancePreferences = preferences;
        int savedTextSize = preferences.contains("message_text_size")
                ? preferences.getInt("message_text_size", 15)
                : (preferences.getBoolean("large_text", false) ? 18 : 15);
        int savedWidth = preferences.getInt("message_width", 72);
        messageTextSize.setProgress(Math.max(0, Math.min(8, savedTextSize - 12)));
        messageWidth.setProgress(Math.max(0, Math.min(34, savedWidth - 58)));
        interfaceScale.setProgress(Math.max(0, Math.min(30, preferences.getInt("interface_scale", 100) - 85)));
        compactMessages.setChecked(preferences.getBoolean("compact_messages", false));
        messageTextSize.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                preferences.edit().putInt("message_text_size", progress + 12).apply();
                applyPreferencePreview();
                // Превью обновляется на каждом шаге; историю перечитываем один раз
                // после отпускания ползунка, чтобы не засыпать ядро командами.
            }
            @Override public void onStartTrackingTouch(SeekBar bar) {}
            @Override public void onStopTrackingTouch(SeekBar bar) { reloadHistory(); }
        });
        messageWidth.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                preferences.edit().putInt("message_width", progress + 58).apply();
                applyPreferencePreview();
            }
            @Override public void onStartTrackingTouch(SeekBar bar) {}
            @Override public void onStopTrackingTouch(SeekBar bar) { reloadHistory(); }
        });
        compactMessages.setOnCheckedChangeListener((button, checked) -> {
            preferences.edit().putBoolean("compact_messages", checked).apply();
            applyPreferencePreview();
            reloadHistory();
        });
        interfaceScale.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                preferences.edit().putInt("interface_scale", progress + 85).apply();
                interfaceScaleValue.setText((progress + 85) + "%");
                applyInterfaceScale(findViewById(R.id.app_root), (progress + 85) / 100f);
                applyPreferencePreview();
            }
            @Override public void onStartTrackingTouch(SeekBar bar) {}
            @Override public void onStopTrackingTouch(SeekBar bar) { reloadHistory(); }
        });
        findViewById(R.id.accent_white).setOnClickListener(v -> setAccent(Color.rgb(244,244,244)));
        findViewById(R.id.accent_blue).setOnClickListener(v -> setAccent(Color.rgb(112,168,255)));
        findViewById(R.id.accent_violet).setOnClickListener(v -> setAccent(Color.rgb(169,140,255)));
        findViewById(R.id.accent_green).setOnClickListener(v -> setAccent(Color.rgb(103,212,163)));
        findViewById(R.id.accent_coral).setOnClickListener(v -> setAccent(Color.rgb(237,134,116)));
        findViewById(R.id.dividers_full).setOnClickListener(v -> setDividers("full"));
        findViewById(R.id.dividers_soft).setOnClickListener(v -> setDividers("soft"));
        findViewById(R.id.dividers_none).setOnClickListener(v -> setDividers("none"));
        cornerRadius.setProgress(Math.max(0, Math.min(16, preferences.getInt("corner_radius", 24) - 8)));
        bubbleRadius.setProgress(Math.max(0, Math.min(22, preferences.getInt("bubble_radius", 24) - 6)));
        squareAvatars.setChecked(preferences.getBoolean("square_avatars", false));

        cornerRadius.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                preferences.edit().putInt("corner_radius", progress + 8).apply();
                applyPreferencePreview();
                applyDividers();
            }
            @Override public void onStartTrackingTouch(SeekBar bar) {}
            @Override public void onStopTrackingTouch(SeekBar bar) {}
        });
        bubbleRadius.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                preferences.edit().putInt("bubble_radius", progress + 6).apply();
                applyPreferencePreview();
            }
            @Override public void onStartTrackingTouch(SeekBar bar) {}
            @Override public void onStopTrackingTouch(SeekBar bar) { reloadHistory(); }
        });
        squareAvatars.setOnCheckedChangeListener((button, checked) -> {
            preferences.edit().putBoolean("square_avatars", checked).apply();
            renderPeers();
            if (currentPeer != null) updateConversationHeader(currentPeer);
        });

        findViewById(R.id.theme_dark).setOnClickListener(v -> setTheme("dark"));
        findViewById(R.id.theme_black).setOnClickListener(v -> setTheme("black"));
        findViewById(R.id.theme_light).setOnClickListener(v -> setTheme("light"));
        findViewById(R.id.settings_reset).setOnClickListener(v -> resetAppearance());
        wireWallpaper();

        applyInterfaceScale(findViewById(R.id.app_root), (interfaceScale.getProgress() + 85) / 100f);
        applyTheme();
        applyAccent();
        applyDividers();
        applyPreferencePreview();
        applyWallpaper();
        installPressFeedback(findViewById(R.id.app_root));
        // Список диалогов перестраивается целиком — без этого строки появляются
        // и исчезают рывком.
        contactList.setLayoutTransition(new android.animation.LayoutTransition());
        // Под островком меняется картинка — значит, размытие надо пересчитать.
        ((View) contactList.getParent()).setOnScrollChangeListener(
                (view, x, y, oldX, oldY) -> tabBar.invalidate());

        // Догрузка старого — по приближении к верху, а не по достижению.
        // Запас в один экран нужен, чтобы страница успела прийти до того, как
        // человек упрётся в пустоту: обращение к ядру асинхронное, и «дожать до
        // края и ждать» читается как зависание.
        messagesScroll.setOnScrollChangeListener((view, x, y, oldX, oldY) -> {
            if (y >= oldY || currentPeer == null) return;
            String conversation = conversations.get(currentPeer);
            if (conversation != null && y < messagesScroll.getHeight()) loadOlder(conversation);
        });
    }

    // --- тема ------------------------------------------------------------------

    private String themeName() {
        return appearancePreferences == null ? "dark" : appearancePreferences.getString("theme", "dark");
    }

    private int themeButtonId() {
        switch (themeName()) {
            case "black": return R.id.theme_black;
            case "light": return R.id.theme_light;
            default: return R.id.theme_dark;
        }
    }

    private int themeBackground() {
        switch (themeName()) {
            case "black": return Color.rgb(0, 0, 0);
            case "light": return Color.rgb(242, 242, 240);
            default: return Color.rgb(5, 5, 5);
        }
    }

    private int themePanel() {
        switch (themeName()) {
            case "black": return Color.rgb(7, 7, 7);
            case "light": return Color.rgb(255, 255, 255);
            default: return Color.rgb(14, 14, 14);
        }
    }

    /** Фон входящего пузыря: он не акцентный и обязан читаться на фоне панели. */
    private int themeIncomingBubble() {
        switch (themeName()) {
            case "black": return Color.rgb(16, 16, 16);
            case "light": return Color.rgb(232, 232, 229);
            default: return Color.rgb(22, 22, 22);
        }
    }

    private int themeText() {
        return "light".equals(themeName()) ? Color.rgb(16, 16, 16) : Color.rgb(245, 245, 243);
    }

    private void setTheme(String name) {
        appearancePreferences.edit().putString("theme", name).apply();
        applyTheme();
        applyDividers();
        applyAccent();
        reloadHistory();
    }

    private void applyTheme() {
        int background = themeBackground();
        findViewById(R.id.app_root).setBackgroundColor(background);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowInsetsController controller =
                    getWindow().getInsetsController();
            if (controller != null) {
                int light = "light".equals(themeName())
                        ? android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        : 0;
                controller.setSystemBarsAppearance(light,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
            }
        }
        applyThemeText(findViewById(R.id.app_root));
    }

    /**
     * Перекрашивает основной текст под тему.
     *
     * Трогаются только надписи, которые в тёмной теме были белыми: приглушённые
     * и мелкие подписи читаются на обоих фонах, и их перекраска убила бы
     * иерархию. Исходный цвет запоминается тегом — иначе после первого же
     * переключения отличить «был белым» от «стал чёрным» было бы нечем.
     */
    private void applyThemeText(View view) {
        if (view instanceof TextView) {
            TextView label = (TextView) view;
            Object stored = label.getTag(R.id.base_text_color_tag);
            int original;
            if (stored instanceof Integer) {
                original = (Integer) stored;
            } else {
                original = label.getCurrentTextColor();
                label.setTag(R.id.base_text_color_tag, original);
            }
            if (original == Color.rgb(245, 245, 243) || original == Color.WHITE) {
                label.setTextColor(themeText());
            }
        }
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) applyThemeText(group.getChildAt(i));
        }
    }

    private void resetAppearance() {
        appearancePreferences.edit().clear().apply();
        messageTextSize.setProgress(3);
        messageWidth.setProgress(14);
        interfaceScale.setProgress(15);
        cornerRadius.setProgress(16);
        bubbleRadius.setProgress(18);
        compactMessages.setChecked(false);
        squareAvatars.setChecked(false);
        applyInterfaceScale(findViewById(R.id.app_root), 1f);
        applyTheme();
        applyAccent();
        applyDividers();
        applyPreferencePreview();
        applyWallpaper();
        renderPeers();
        reloadHistory();
        toast(getString(R.string.settings_reset_done));
    }

    // --- обои переписки ----------------------------------------------------------

    /**
     * Узоры обоев.
     *
     * Рисуются на устройстве цветом темы, а не картинками: файл обоев пришлось
     * бы где-то хранить и как-то переносить, а узор из двух градиентов весит
     * ноль и меняет цвет вместе с акцентом.
     */
    private static final String[][] WALLPAPERS = {
            {"none", "wallpaper_none"},
            {"aurora", "wallpaper_aurora"},
            {"mesh", "wallpaper_mesh"},
            {"grid", "wallpaper_grid"},
            {"dots", "wallpaper_dots"},
            {"rays", "wallpaper_rays"},
    };

    private String wallpaperName() {
        return appearancePreferences == null ? "none"
                : appearancePreferences.getString("wallpaper", "none");
    }

    private int wallpaperIntensity() {
        return appearancePreferences == null ? 45
                : appearancePreferences.getInt("wallpaper_intensity", 45);
    }

    private void wireWallpaper() {
        SeekBar intensity = findViewById(R.id.wallpaper_intensity);
        intensity.setProgress(wallpaperIntensity());
        intensity.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                appearancePreferences.edit().putInt("wallpaper_intensity", progress).apply();
                ((TextView) findViewById(R.id.wallpaper_intensity_value)).setText(progress + "%");
                applyWallpaper();
            }
            @Override public void onStartTrackingTouch(SeekBar bar) {}
            @Override public void onStopTrackingTouch(SeekBar bar) {}
        });
        ((TextView) findViewById(R.id.wallpaper_intensity_value))
                .setText(wallpaperIntensity() + "%");
        renderWallpaperGrid();
    }

    /** Образцы обоев: выбор глазами, а не по названию. */
    private void renderWallpaperGrid() {
        LinearLayout host = findViewById(R.id.wallpaper_grid);
        if (host == null) return;
        host.removeAllViews();
        String current = wallpaperName();
        for (String[] spec : WALLPAPERS) {
            final String key = spec[0];
            LinearLayout cell = new LinearLayout(this);
            cell.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams cellParams = new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            if (host.getChildCount() > 0) cellParams.leftMargin = dp(6);
            cell.setLayoutParams(cellParams);

            View sample = new View(this);
            sample.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(40)));
            GradientDrawable frame = new GradientDrawable();
            frame.setColor(themeBackground());
            frame.setCornerRadius(dp(9));
            frame.setStroke(dp(key.equals(current) ? 2 : 1),
                    key.equals(current) ? accentColor() : getColor(R.color.obsidian_line));
            // Образцу нужен свой масштаб: пятно радиусом в экран внутри клетки
            // в палец шириной выглядит просто заливкой.
            Drawable pattern = wallpaperPattern(key, dp(64));
            sample.setBackground(pattern == null ? frame
                    : new LayerDrawable(new Drawable[]{frame, pattern}));
            sample.setClipToOutline(true);
            cell.addView(sample);

            TextView label = new TextView(this);
            label.setText(getString(getResources().getIdentifier(
                    spec[1], "string", getPackageName())));
            label.setTextColor(getColor(key.equals(current)
                    ? R.color.obsidian_white : R.color.obsidian_muted));
            label.setTextSize(9);
            label.setGravity(Gravity.CENTER);
            label.setPadding(0, dp(4), 0, 0);
            cell.addView(label);

            cell.setOnClickListener(v -> {
                appearancePreferences.edit().putString("wallpaper", key).apply();
                applyWallpaper();
            });
            host.addView(cell);
        }
    }

    /** Кладёт обои под ленту сообщений. */
    private void applyWallpaper() {
        View host = findViewById(R.id.messages_scroll);
        if (host != null) {
            Drawable pattern = wallpaperPattern(wallpaperName(),
                    getResources().getDisplayMetrics().widthPixels);
            if (pattern != null) {
                pattern.setAlpha(Math.round(wallpaperIntensity() * 255 / 100f));
            }
            host.setBackground(pattern);
        }
        renderWallpaperGrid();
    }

    /**
     * Узор без учёта насыщенности; {@code null} — обоев нет.
     *
     * `base` — ширина, от которой считается размер пятен: у ленты это экран, у
     * образца в настройках — сама клетка.
     */
    private Drawable wallpaperPattern(String name, int base) {
        int accent = accentColor();
        switch (name) {
            case "aurora":
                return new LayerDrawable(new Drawable[]{
                        glow(accent, base, 0.12f, 0f, 0.40f, 1.5f),
                        glow(accent, base, 0.88f, 1f, 0.26f, 1.4f),
                });
            case "mesh":
                return new LayerDrawable(new Drawable[]{
                        glow(accent, base, 0.22f, 0.28f, 0.34f, 0.9f),
                        glow(accent, base, 0.78f, 0.72f, 0.24f, 0.85f),
                        glow(accent, base, 0.55f, 0.12f, 0.18f, 0.75f),
                });
            case "grid":
            case "dots":
            case "rays":
                return tile(accent, name);
            default:
                return null;
        }
    }

    /** Мягкое пятно света: круговой градиент от цвета темы в прозрачность. */
    private GradientDrawable glow(int accent, int base, float x, float y, float strength,
            float radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.RECTANGLE);
        shape.setGradientType(GradientDrawable.RADIAL_GRADIENT);
        shape.setGradientCenter(x, y);
        shape.setGradientRadius(base * radius);
        shape.setColors(new int[]{
                Color.argb(Math.round(255 * strength), Color.red(accent), Color.green(accent),
                        Color.blue(accent)),
                Color.TRANSPARENT,
        });
        return shape;
    }

    /**
     * Повторяющийся узор.
     *
     * Клетка рисуется один раз и размножается системой — иначе на длинной ленте
     * пришлось бы держать картинку во весь экран.
     */
    private Drawable tile(int accent, String kind) {
        int step = dp("dots".equals(kind) ? 22 : "grid".equals(kind) ? 34 : 30);
        Bitmap bitmap = Bitmap.createBitmap(step, step, Bitmap.Config.ARGB_8888);
        android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
        android.graphics.Paint paint = new android.graphics.Paint(
                android.graphics.Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.argb("dots".equals(kind) ? 86 : 56, Color.red(accent),
                Color.green(accent), Color.blue(accent)));

        if ("grid".equals(kind)) {
            paint.setStrokeWidth(dp(1));
            canvas.drawLine(0, 0, step, 0, paint);
            canvas.drawLine(0, 0, 0, step, paint);
        } else if ("dots".equals(kind)) {
            canvas.drawCircle(step / 2f, step / 2f, dp(1.4f), paint);
        } else {
            // Полосы наискось: клетка квадратная, поэтому узор сходится краями
            // сам, без подгонки.
            paint.setStrokeWidth(dp(8));
            canvas.drawLine(-step, step, step, -step, paint);
            canvas.drawLine(0, step * 2f, step * 2f, 0, paint);
        }
        BitmapDrawable drawable = new BitmapDrawable(getResources(), bitmap);
        drawable.setTileModeXY(android.graphics.Shader.TileMode.REPEAT,
                android.graphics.Shader.TileMode.REPEAT);
        return drawable;
    }

    private int cornerRadiusDp() {
        return cornerRadius == null ? 24 : cornerRadius.getProgress() + 8;
    }

    private int bubbleRadiusDp() {
        return bubbleRadius == null ? 24 : bubbleRadius.getProgress() + 6;
    }

    private void applyInterfaceScale(View view, float scale) {
        if (view instanceof TextView) {
            TextView text = (TextView) view;
            Object stored = text.getTag(R.id.base_text_size_tag);
            float base = stored instanceof Float ? (Float) stored : text.getTextSize() / getResources().getDisplayMetrics().scaledDensity;
            if (!(stored instanceof Float)) text.setTag(R.id.base_text_size_tag, base);
            text.setTextSize(base * scale);
        }
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) applyInterfaceScale(group.getChildAt(i), scale);
        }
    }

    private int accentColor() {
        return appearancePreferences == null ? Color.rgb(244,244,244)
                : appearancePreferences.getInt("accent_color", Color.rgb(244,244,244));
    }

    private void setAccent(int color) {
        appearancePreferences.edit().putInt("accent_color", color).apply();
        applyAccent();
        reloadHistory();
    }

    private void applyAccent() {
        int accent = accentColor();
        int text = Color.luminance(accent) > .55 ? Color.BLACK : Color.WHITE;
        for (int id : new int[]{R.id.send, R.id.migrate, R.id.entry_submit,
                R.id.recover_submit}) {
            Button button = findViewById(id);
            button.setBackgroundTintList(ColorStateList.valueOf(accent));
            button.setTextColor(text);
        }
        // Кнопка «добавить» рисуется значком: у неё красится сам значок, а не текст.
        ImageView add = findViewById(R.id.open_chat);
        add.setBackgroundTintList(ColorStateList.valueOf(accent));
        add.setImageTintList(ColorStateList.valueOf(text));
        settingsPreviewOut.setBackgroundTintList(ColorStateList.valueOf(accent));
        settingsPreviewOut.setTextColor(text);
        messageTextSize.setProgressTintList(ColorStateList.valueOf(accent));
        messageWidth.setProgressTintList(ColorStateList.valueOf(accent));
        interfaceScale.setProgressTintList(ColorStateList.valueOf(accent));
        cornerRadius.setProgressTintList(ColorStateList.valueOf(accent));
        bubbleRadius.setProgressTintList(ColorStateList.valueOf(accent));
        // Сегменты подсвечены акцентом — их надо перекрасить вместе с ним.
        highlightSegment(recoverByCode ? R.id.recover_mode_code : R.id.recover_mode_password,
                R.id.recover_mode_code, R.id.recover_mode_password);
        highlightSegment(themeButtonId(), R.id.theme_dark, R.id.theme_black, R.id.theme_light);
        String dividers = appearancePreferences.getString("dividers", "full");
        highlightSegment("soft".equals(dividers) ? R.id.dividers_soft
                        : "none".equals(dividers) ? R.id.dividers_none : R.id.dividers_full,
                R.id.dividers_full, R.id.dividers_soft, R.id.dividers_none);
    }

    private void setDividers(String mode) {
        appearancePreferences.edit().putString("dividers", mode).apply();
        applyDividers();
    }

    private void applyDividers() {
        String mode = appearancePreferences.getString("dividers", "full");
        int line = "none".equals(mode) ? Color.TRANSPARENT
                : ("soft".equals(mode) ? Color.rgb(24,24,24) : Color.rgb(48,48,48));
        applyPanelStyle(findViewById(R.id.app_root), line);
    }

    private void applyPanelStyle(View view, int line) {
        // Полоса записи красная по смыслу, а не по теме: перекрасить её общим
        // стилем панелей значило бы потерять единственный сигнал «идёт запись».
        // Панель — та, у которой фон нарисован фигурой. Строка настроек одета в
        // отклик на нажатие (RippleDrawable), и раньше она попадала под ту же
        // гребёнку: каждая строка получала рамку со скруглением и превращалась
        // в отдельную карточку, а отклик на нажатие пропадал.
        if (view instanceof LinearLayout && view.getBackground() instanceof GradientDrawable
                && view.getParent() != messages && view.getId() != R.id.recording_bar) {
            GradientDrawable panel = new GradientDrawable();
            panel.setColor(themePanel());
            panel.setCornerRadius(view.getId() == R.id.composer_row ? dp(999) : dp(cornerRadiusDp()));
            panel.setStroke(dp(1), line);
            view.setBackground(panel);
        }
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) applyPanelStyle(group.getChildAt(i), line);
        }
    }

    private int messageTextSp() {
        return messageTextSize.getProgress() + 12;
    }

    private int messageWidthPercent() {
        return messageWidth.getProgress() + 58;
    }

    private void applyPreferencePreview() {
        int textSize = messageTextSp();
        int width = messageWidthPercent();
        messageTextValue.setText(textSize + " px");
        messageWidthValue.setText(width + "%");
        float scale = (interfaceScale.getProgress() + 85) / 100f;
        settingsPreviewIn.setTextSize(textSize * scale);
        settingsPreviewOut.setTextSize(textSize * scale);
        int horizontal = compactMessages.isChecked() ? 10 : 14;
        int vertical = compactMessages.isChecked() ? 7 : 10;
        settingsPreviewIn.setPadding(dp(horizontal), dp(vertical), dp(horizontal), dp(vertical));
        settingsPreviewOut.setPadding(dp(horizontal), dp(vertical), dp(horizontal), dp(vertical));
        int maxWidth = Math.max(dp(180), getResources().getDisplayMetrics().widthPixels * width / 100 - dp(32));
        settingsPreviewIn.setMaxWidth(maxWidth);
        settingsPreviewOut.setMaxWidth(maxWidth);
        cornerRadiusValue.setText(cornerRadiusDp() + " dp");
        bubbleRadiusValue.setText(bubbleRadiusDp() + " dp");
        settingsPreviewIn.setBackground(bubbleBackground(false));
        settingsPreviewOut.setBackground(bubbleBackground(true));
        settingsPreviewIn.setTextColor(themeText());
        settingsPreviewOut.setTextColor(
                Color.luminance(accentColor()) > .55 ? Color.BLACK : Color.WHITE);
    }

    /** Общая форма пузыря: одна на переписку и на превью в настройках. */
    private GradientDrawable bubbleBackground(boolean outgoing) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(outgoing ? accentColor() : themeIncomingBubble());
        background.setCornerRadius(dp(bubbleRadiusDp()));
        if (!outgoing) {
            String dividers = appearancePreferences == null
                    ? "full" : appearancePreferences.getString("dividers", "full");
            background.setStroke(dp(1), "none".equals(dividers) ? Color.TRANSPARENT
                    : "light".equals(themeName()) ? Color.rgb(219, 219, 214) : Color.rgb(45, 45, 45));
        }
        return background;
    }

    private void reloadHistory() {
        if (currentPeer == null) return;
        String conversation = conversations.get(currentPeer);
        if (TextUtils.isEmpty(conversation)) return;
        // Оформление сменилось: собранные пузыри устарели целиком. Без сброса
        // новый размер текста и скругления достались бы только новым сообщениям.
        pages.remove(conversation);
        messages.removeAllViews();
        loadOlder(conversation);
    }

    private void chooseAvatar() {
        if (!profilesSupported) {
            toast("Сервер ещё не обновлён для аватаров");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        startActivityForResult(intent, AVATAR_PICK_REQUEST);
    }

    private void choosePhoto() {
        if (currentPeer == null) return;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        startActivityForResult(intent, PHOTO_PICK_REQUEST);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if ((requestCode != AVATAR_PICK_REQUEST && requestCode != PHOTO_PICK_REQUEST)
                || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        final boolean avatar = requestCode == AVATAR_PICK_REQUEST;
        // Декодирование — в фоне: большой снимок иначе подвешивает интерфейс.
        new Thread(() -> {
            try (InputStream input = getContentResolver().openInputStream(data.getData())) {
                Bitmap source = BitmapFactory.decodeStream(input);
                if (source == null) throw new IOException("image decode failed");
                runOnUiThread(() -> openEditor(source, avatar));
            } catch (Exception error) {
                runOnUiThread(() -> toast("Не удалось прочитать изображение"));
            }
        }, avatar ? "obsidian-avatar" : "obsidian-photo").start();
    }

    /**
     * Правка снимка перед отправкой.
     *
     * У аватара кадр заперт квадратом: он всё равно показывается в круге, и
     * обрезать его вслепую — значит промахиваться.
     */
    private void openEditor(Bitmap source, boolean avatar) {
        int limit = avatar ? 340_000 : 700_000;
        new PhotoEditor(this, source, avatar ? 1f : 0f, limit, (base64, width, height) -> {
            if (avatar) {
                submit(Commands.profileSet("image/jpeg", base64));
                toast("Аватар загружается…");
                return;
            }
            if (currentPeer == null) return;
            String body = encodeContent("image", logicalId(), null, base64);
            submit(Commands.send(currentPeer, body));
            addBubble(body, true);
        }).show();
    }

    // --- локальный ключ и автоматический вход ---------------------------------

    private void autoOpenDatabase() {
        new Thread(() -> {
            File db = databaseFile();
            LocalSecretStore secrets = new LocalSecretStore(this);
            try {
                String secret = secrets.load();
                if (secret == null && db.exists()) {
                    runOnUiThread(() -> show(screenMigrate));
                    return;
                }
                if (secret == null) {
                    secret = LocalSecretStore.randomSecret();
                    secrets.save(secret);
                }
                boolean opened = ObsidianService.core().open(db.getAbsolutePath(), secret);
                runOnUiThread(() -> finishOpen(opened));
            } catch (Throwable error) {
                runOnUiThread(() -> showStartupError(error));
            }
        }, "obsidian-auto-open").start();
    }

    private void migrateLegacyDatabase() {
        String secret = migrationPassword.getText().toString();
        if (secret.isEmpty()) return;
        findViewById(R.id.migrate).setEnabled(false);

        new Thread(() -> {
            File db = databaseFile();
            boolean verified = ObsidianService.core()
                    .verifyDatabaseKey(db.getAbsolutePath(), secret);
            if (!verified) {
                runOnUiThread(() -> {
                    findViewById(R.id.migrate).setEnabled(true);
                    toast(getString(R.string.wrong_password));
                });
                return;
            }
            try {
                new LocalSecretStore(this).save(secret);
                boolean opened = ObsidianService.core().open(db.getAbsolutePath(), secret);
                runOnUiThread(() -> finishOpen(opened));
            } catch (Throwable error) {
                runOnUiThread(() -> showStartupError(error));
            }
        }, "obsidian-migrate").start();
    }

    private void confirmResetLegacyDatabase() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.reset_database_title)
                .setMessage(R.string.reset_database_confirmation)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.reset_database_action,
                        (dialog, which) -> resetLegacyDatabase())
                .show();
    }

    private void resetLegacyDatabase() {
        findViewById(R.id.reset_legacy).setEnabled(false);
        new Thread(() -> {
            try {
                archiveLegacyDatabase();
                String secret = LocalSecretStore.randomSecret();
                new LocalSecretStore(this).save(secret);
                boolean opened = ObsidianService.core()
                        .open(databaseFile().getAbsolutePath(), secret);
                runOnUiThread(() -> finishOpen(opened));
            } catch (Throwable error) {
                runOnUiThread(() -> {
                    findViewById(R.id.reset_legacy).setEnabled(true);
                    showFatal(getString(R.string.reset_database_error));
                });
            }
        }, "obsidian-reset").start();
    }

    private void archiveLegacyDatabase() throws IOException {
        File db = databaseFile();
        File backup = new File(getFilesDir(),
                "legacy-backups/" + System.currentTimeMillis());
        if (!backup.mkdirs() && !backup.isDirectory()) {
            throw new IOException("cannot create backup directory");
        }
        File[] files = {
                db,
                new File(db.getAbsolutePath() + "-wal"),
                new File(db.getAbsolutePath() + "-shm")
        };
        for (File source : files) {
            if (source.exists() && !source.renameTo(new File(backup, source.getName()))) {
                throw new IOException("cannot archive " + source.getName());
            }
        }
    }

    private void finishOpen(boolean opened) {
        if (!opened) {
            showFatal(getString(R.string.database_error));
            return;
        }
        migrationPassword.setText("");
        startEventDelivery();
        submit(Commands.status());
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private boolean canUseForegroundService() {
        return Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * На Android 13+ foreground-сервис запускается только после разрешения на
     * уведомления. При отказе приложение остаётся полностью рабочим, пока оно
     * открыто: события забирает локальный поток активности.
     */
    private void startEventDelivery() {
        if (!canUseForegroundService()) {
            startLocalPolling();
            return;
        }
        stopLocalPolling();
        try {
            ObsidianService.start(this);
        } catch (RuntimeException error) {
            startLocalPolling();
            toast(getString(R.string.background_limited));
        }
    }

    private synchronized void startLocalPolling() {
        if (localPolling || !ObsidianService.core().isOpen()) return;
        localPolling = true;
        localPoller = new Thread(() -> {
            while (localPolling) {
                String event = ObsidianService.core().poll(500);
                if (event != null) Events.publish(event);
            }
        }, "obsidian-activity-poll");
        localPoller.start();
    }

    private void stopLocalPolling() {
        Thread poller;
        synchronized (this) {
            localPolling = false;
            poller = localPoller;
            localPoller = null;
        }
        if (poller != null && poller != Thread.currentThread()) {
            try {
                poller.join(700);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private File databaseFile() {
        return new File(getFilesDir(), "obsidian.db");
    }

    // --- действия --------------------------------------------------------------

    private void register() {
        entrySubmit.setEnabled(false);
        entrySubmit.setText(R.string.connecting);
        submit(Commands.register(SERVER_URL, handle.getText().toString().trim(), null));
    }

    private void checkForUpdates() {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(RELEASES_URL).openConnection();
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setRequestProperty("Accept", "application/json");
                try (InputStream stream = connection.getInputStream();
                     ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[4096];
                    int count;
                    while ((count = stream.read(chunk)) != -1) bytes.write(chunk, 0, count);
                    JSONObject release = new JSONObject(bytes.toString("UTF-8")).getJSONObject("android");
                    String latest = release.getString("version");
                    String url = release.getString("url");
                    if (compareVersions(latest, APP_VERSION) > 0) {
                        runOnUiThread(() -> new AlertDialog.Builder(this)
                                .setTitle("Доступно обновление " + latest)
                                .setMessage("Скачать новую Public Beta? Установка начнётся только после подтверждения Android.")
                                .setPositiveButton("Скачать", (dialog, which) ->
                                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))))
                                .setNegativeButton("Позже", null)
                                .show());
                    }
                }
            } catch (Exception ignored) {
                // Проверка не должна мешать запуску и работе офлайн.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "obsidian-update-check").start();
    }

    private static int compareVersions(String left, String right) {
        String[] a = left.split("\\.");
        String[] b = right.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int av = i < a.length ? Integer.parseInt(a[i]) : 0;
            int bv = i < b.length ? Integer.parseInt(b[i]) : 0;
            if (av != bv) return Integer.compare(av, bv);
        }
        return 0;
    }

    private void openNewChat() {
        String raw = newPeer.getText().toString().trim();
        if (raw.startsWith("@")) {
            String name = raw.substring(1).toLowerCase(Locale.ROOT);
            if (name.isEmpty()) return;
            submit(Commands.usernameLookup(name));
            return;
        }
        String chatCode = raw.toUpperCase(Locale.ROOT);
        if (chatCode.matches("OBS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}")) {
            if (!profilesSupported) {
                toast("Сервер ещё не обновлён для кодов чата");
                return;
            }
            pendingChatCode = chatCode;
            submit(Commands.profileGet(chatCode));
            return;
        }
        String peer = raw.toLowerCase(Locale.ROOT);
        if (!peer.matches("[0-9a-f]{64}")) {
            toast(getString(R.string.bad_device));
            return;
        }
        if (peer.equals(myDeviceHex)) {
            toast(getString(R.string.own_device));
            return;
        }
        newPeer.setText("");
        conversations.putIfAbsent(peer, null);
        renderPeers();
        selectPeer(peer);
    }

    private void send() {
        String text = composer.getText().toString().trim();
        if (text.isEmpty() || currentPeer == null) return;
        composer.setText("");
        String body = replyId == null
                ? encodeContent("text", logicalId(), text, null)
                : encodeReply("text", logicalId(), text, replyId, replyText);
        setReply(null, null);
        submit(Commands.send(currentPeer, body));
        addBubble(body, true);
    }

    /**
     * Сообщает собеседнику, что мы набираем текст.
     *
     * Сигнал редкий намеренно: каждый — отдельный шифрованный конверт. Слать его
     * на каждую букву значило бы утроить трафик и без пользы вращать храповик
     * MLS. Раз в четыре секунды достаточно, чтобы надпись не гасла.
     */
    private long typingSentAt;

    /**
     * Поле под верхней полосой работает и поиском, и добавлением.
     *
     * Пока набирают — отсеивает уже открытые переписки. По «Go» или кнопке «+»
     * разбирает набранное: @имя ищется на сервере, код OBS- и адрес устройства
     * открывают переписку.
     */
    private void wireSearch() {
        newPeer.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
            }

            @Override
            public void afterTextChanged(android.text.Editable s) {
                String next = s.toString().trim().toLowerCase(Locale.ROOT);
                if (next.equals(listFilter)) return;
                listFilter = next;
                scheduleLookup(next);
                renderPeers();
            }
        });
        newPeer.setOnEditorActionListener((view, actionId, event) -> {
            openNewChat();
            return true;
        });
    }

    /**
     * Спрашивает каталог, не дожидаясь нажатия.
     *
     * Пауза в наборе нужна не для красоты: сервер считает поиски и режет частые
     * — по одному запросу на букву мы бы упёрлись в этот предел на первом же
     * имени.
     *
     * Показать людей «по первым буквам» нельзя, и это не недоделка. Сервер
     * хранит не имена, а их хеши, и умеет отвечать только на имя целиком: по
     * началу имени искать негде. Именно это и мешает постороннему выкачать
     * список всех, кто здесь есть. Уже знакомые при этом отсеиваются с первой
     * буквы — они лежат на устройстве, спрашивать о них некого.
     */
    private void scheduleLookup(String raw) {
        if (lookupSoon != null) ui.removeCallbacks(lookupSoon);
        String name = raw.startsWith("@") ? raw.substring(1) : raw;
        boolean searchable = name.matches("[a-z][a-z0-9_]{2,19}");
        if (!searchable) {
            // Набор перестал быть похож на имя — старый ответ больше не про него.
            lookupQuery = null;
            lookupHit = null;
            lookupMissed = false;
            return;
        }
        if (name.equals(lookupQuery)) return;
        lookupSoon = () -> {
            lookupQuery = name;
            lookupHit = null;
            lookupMissed = false;
            submit(Commands.usernameLookup(name));
        };
        ui.postDelayed(lookupSoon, 450);
    }

    private void wireTyping() {
        composer.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
            }

            @Override
            public void afterTextChanged(android.text.Editable s) {
                if (currentPeer == null || s.length() == 0) return;
                if (!permits("typing", currentPeer)) return;
                long now = System.currentTimeMillis();
                if (now - typingSentAt < 4000) return;
                typingSentAt = now;
                submit(Commands.typing(currentPeer, true));
            }
        });
    }

    private static String logicalId() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    /** Тело сообщения с цитатой. Формат общий с ПК-клиентом. */
    private static String encodeReply(String type, String id, String text, String replyId, String replyText) {
        try {
            JSONObject reply = new JSONObject().put("id", replyId).put("text", replyText);
            JSONObject value = new JSONObject().put("v", 1).put("type", type).put("id", id).put("reply", reply);
            if (text != null) value.put("text", text);
            return CONTENT_PREFIX + value;
        } catch (Exception ignored) {
            // Не смогли собрать цитату — отправляем обычным сообщением, а не
            // роняем отправку целиком.
            return encodeContent(type, id, text, null);
        }
    }

    private static String encodeContent(String type, String id, String text, String data) {
        try {
            JSONObject value = new JSONObject().put("v", 1).put("type", type).put("id", id);
            if (text != null) value.put("text", text);
            if (data != null) value.put("mime", "image/jpeg").put("data", data);
            return CONTENT_PREFIX + value;
        } catch (Exception ignored) { return text == null ? "" : text; }
    }

    private static JSONObject parseContent(String body) {
        try {
            if (body != null && body.startsWith(CONTENT_PREFIX)) return new JSONObject(body.substring(CONTENT_PREFIX.length()));
        } catch (Exception ignored) {}
        try { return new JSONObject().put("type", "text").put("text", body == null ? "" : body); }
        catch (Exception impossible) { return new JSONObject(); }
    }

    private void sendRead(String peer, Set<String> ids) {
        if (peer == null || ids.isEmpty()) return;
        try {
            Set<String> fresh = new HashSet<>(ids);
            fresh.removeAll(sentReadIds);
            if (fresh.isEmpty()) return;
            sentReadIds.addAll(fresh);
            JSONObject value = new JSONObject().put("v", 1).put("type", "read").put("ids", new JSONArray(fresh));
            submit(Commands.send(peer, CONTENT_PREFIX + value));
        } catch (Exception ignored) {}
    }

    private void applyRead(JSONArray ids) {
        if (ids == null) return;
        for (int i = 0; i < ids.length(); i++) readIds.add(ids.optString(i));
        for (int i = 0; i < messages.getChildCount(); i++) {
            View child = messages.getChildAt(i);
            if (child.getTag() instanceof String && readIds.contains(child.getTag())) {
                TextView delivery = child.findViewWithTag("delivery");
                if (delivery != null) delivery.setText("✓✓ прочитано");
            }
        }
    }

    private void submit(String command) {
        if (!ObsidianService.core().submit(command)) {
            toast(getString(R.string.core_busy));
        }
    }

    // --- события ядра ----------------------------------------------------------

    @Override
    public void onEvent(JSONObject event) {
        switch (event.optString("type")) {
            case "status":
                onStatus(event);
                break;
            case "registered":
                setMyDevice(event.optString("device"));
                invite.setText("");
                break;
            case "authenticated":
                admin = event.optBoolean("admin");
                findViewById(R.id.open_admin).setVisibility(admin ? View.VISIBLE : View.GONE);
                show(screenChat);
                setStatus(getString(R.string.status_online));
                submit(Commands.conversations());
                submit(Commands.privacyGet());
                submit(Commands.directoryList());
                submit(Commands.accessGet());
                break;
            case "connected":
                profilesSupported = event.optBoolean("profiles");
                decorSupported = event.optBoolean("decor");
                setStatus(getString(R.string.status_connecting));
                break;
            case "disconnected":
                setStatus(getString(R.string.status_reconnecting));
                break;
            case "service_unavailable":
                startLocalPolling();
                toast(getString(R.string.background_limited));
                break;
            case "conversations":
                onConversations(event.optJSONArray("items"));
                break;
            case "conversation_started":
                conversations.put(event.optString("peer_device"), event.optString("conversation"));
                renderPeers();
                break;
            case "message":
                onMessage(event);
                break;
            case "history":
                onHistory(event);
                break;
            case "privacy":
                privacy = event.optJSONObject("privacy");
                if (screenPrivacySection.getVisibility() == View.VISIBLE) renderPrivacy();
                break;
            case "directory":
                directory.clear();
                JSONArray entries = event.optJSONArray("entries");
                if (entries != null) {
                    for (int i = 0; i < entries.length(); i++) {
                        JSONObject entry = entries.optJSONObject(i);
                        if (entry != null) directory.put(entry.optString("device"), entry);
                    }
                }
                renderRequests();
                break;
            case "username":
                username = event.isNull("name") ? null : event.optString("name");
                renderUsername();
                break;
            case "username_found":
                onUsernameFound(event);
                break;
            case "access":
                access = event;
                break;
            case "peer_typing":
                if (event.optString("peer_device").equals(currentPeer)) {
                    ((TextView) findViewById(R.id.peer_state)).setText(
                            event.optBoolean("active") ? getString(R.string.typing) : getString(R.string.secure_chat));
                }
                break;
            case "deleted":
                onDeleted(event);
                break;
            case "conversation_cleared":
                onConversationCleared(event);
                break;
            case "fingerprint":
                profileFingerprint.setText(event.optString("fingerprint", "—"));
                break;
            case "profile":
                onProfile(event);
                break;
            case "admin":
                onAdminReport(event);
                break;
            case "channels":
                onChannels(event);
                break;
            case "channel_post":
                onChannelPost(event);
                break;
            case "verification":
                new AlertDialog.Builder(this).setTitle("Проверка защищённого чата")
                        .setMessage("Код пары устройств:\n" + event.optString("safety_number")
                                + "\n\nКод эпохи " + event.optLong("epoch") + ":\n" + event.optString("epoch_code")
                                + "\n\nСверьте эти числа с собеседником по другому каналу.")
                        .setPositiveButton("Готово", null).show();
                break;
            case "recovery_code":
                showRecoveryCode(event.optString("code"));
                break;
            case "recovery_saved":
                recoveryPasswordSave.setEnabled(true);
                recoveryPassword.setText("");
                setRecoveryStatus(getString(R.string.recovery_saved, event.optString("login")), false);
                break;
            case "recovery_forgotten":
                setRecoveryStatus(getString(R.string.recovery_forgotten), false);
                break;
            case "failed":
                onFailed(event);
                break;
            default:
                break;
        }
    }

    private void onStatus(JSONObject event) {
        if (!event.optBoolean("has_identity")) {
            show(screenEntry);
            entrySubmit.setEnabled(true);
            entrySubmit.setText(R.string.register);
            return;
        }
        setMyDevice(event.optString("device"));
        myIdentityHex = event.optString("identity");
        ((TextView) findViewById(R.id.my_identity)).setText(shortHex(myIdentityHex));
        submit(Commands.fingerprint(myIdentityHex));
        submit(Commands.conversations());
        setStatus(getString(R.string.status_connecting));
        submit(Commands.connect(SERVER_URL));
    }

    private void onFailed(JSONObject event) {
        String code = event.optString("code");

        // Отказы восстановления показываются на своём экране, а не тостом: там
        // человек только что нажал кнопку и ждёт ответа именно на неё.
        String recovery = recoveryError(code);
        if (recovery != null && screenRecover.getVisibility() == View.VISIBLE) {
            recoverError.setText(recovery);
            resetRecoverButton();
            return;
        }
        if (recovery != null && screenProfile.getVisibility() == View.VISIBLE) {
            recoveryPasswordSave.setEnabled(true);
            setRecoveryStatus(recovery, true);
            return;
        }

        if ("entry_required".equals(code) || "invite_invalid".equals(code)
                || "handle_taken".equals(code) || "bad_handle".equals(code)) {
            show(screenEntry);
            entrySubmit.setEnabled(true);
            entrySubmit.setText(R.string.register);
        }
        toast(code + ": " + event.optString("message"));
    }

    private void onConversations(JSONArray items) {
        if (items == null) return;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null) {
                conversations.put(item.optString("peer_device"), item.optString("conversation"));
                if (profilesSupported) submit(Commands.profileGet(item.optString("peer_device")));
            }
        }
        renderPeers();
    }

    private void onMessage(JSONObject event) {
        String conversation = event.optString("conversation");
        String peer = peerOf(conversation);
        if (peer == null) {
            peer = event.optString("sender_device");
            conversations.put(peer, conversation);
            renderPeers();
        }
        String body = event.optString("body");
        JSONObject content = parseContent(body);
        if ("read".equals(content.optString("type"))) {
            applyRead(content.optJSONArray("ids"));
        } else if (peer.equals(currentPeer)) {
            addBubble(body, false);
            String id = content.optString("id");
            if (!id.isEmpty()) sendRead(peer, java.util.Collections.singleton(id));
        } else {
            toast(getString(R.string.new_message, shortHex(peer)));
        }
    }

    private void onHistory(JSONObject event) {
        String conversation = event.optString("conversation");
        if (TextUtils.isEmpty(conversation)) return;
        JSONArray items = event.optJSONArray("messages");

        ChatPage entry = page(conversation);
        entry.loading = false;
        entry.loaded = true;
        entry.hasMore = event.optBoolean("has_more");
        if (items != null && items.length() > 0) {
            JSONObject last = items.optJSONObject(items.length() - 1);
            if (last != null) entry.oldest = last.optString("cursor");
        }
        if (items == null) return;

        // Отметки о прочтении разбираем до сборки пузырей: иначе галочки на уже
        // построенных сообщениях останутся одинарными до следующего события.
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            JSONObject content = parseContent(item.optString("body"));
            if ("read".equals(content.optString("type"))) {
                applyRead(content.optJSONArray("ids"));
                if (item.optBoolean("outgoing")) {
                    JSONArray ids = content.optJSONArray("ids");
                    if (ids != null) for (int j = 0; j < ids.length(); j++) sentReadIds.add(ids.optString(j));
                }
            }
        }

        // Ядро отдаёт новейшие первыми — на экране порядок обратный.
        List<View> fresh = new ArrayList<>();
        Set<String> incoming = new HashSet<>();
        for (int i = items.length() - 1; i >= 0; i--) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            JSONObject content = parseContent(item.optString("body"));
            if ("read".equals(content.optString("type"))) continue;
            View bubble = buildBubble(item.optString("body"), item.optBoolean("outgoing"));
            if (bubble == null) continue;
            fresh.add(bubble);
            if (!item.optBoolean("outgoing") && !content.optString("id").isEmpty()) {
                incoming.add(content.optString("id"));
            }
        }
        // Страница всегда старше того, что уже лежит в кэше.
        entry.bubbles.addAll(0, fresh);

        // Ответ мог опоздать: пока он шёл, человек успел уйти в другую беседу.
        if (!conversation.equals(conversations.get(currentPeer))) return;

        if (entry.bubbles.size() == fresh.size()) {
            entry.scrollY = -1;
            paintConversation(conversation);
        } else {
            // Догрузка вверх: держим содержимое на месте, а не прыгаем.
            final int heightBefore = messages.getHeight();
            final int offset = messagesScroll.getScrollY();
            for (int i = fresh.size() - 1; i >= 0; i--) messages.addView(fresh.get(i), 0);
            messages.post(() ->
                    messagesScroll.scrollTo(0, messages.getHeight() - heightBefore + offset));
        }
        sendRead(currentPeer, incoming);
    }

    private void onProfile(JSONObject event) {
        Profile profile = new Profile(
                event.optString("device"),
                event.optString("chat_code"),
                event.optString("handle", ""),
                event.optString("avatar_mime", ""),
                event.optString("avatar_base64", ""));
        profile.emblem = optText(event, "emblem");
        profile.color = optText(event, "color");
        profiles.put(profile.device, profile);
        if (profile.device.equals(myDeviceHex)) {
            ownChatCode = profile.chatCode;
            myEmblem = optText(event, "emblem");
            myColor = optText(event, "color");
            myChatCode.setText(profile.chatCode);
            profileChatCode.setText(profile.chatCode);
            applyAvatar(profileAvatar, profile, "ME");
            renderOwnProfile();
        }
        if (profile.chatCode.equals(pendingChatCode)) {
            pendingChatCode = null;
            newPeer.setText("");
            if (profile.device.equals(myDeviceHex)) {
                toast(getString(R.string.own_device));
            } else {
                conversations.putIfAbsent(profile.device, null);
                renderPeers();
                selectPeer(profile.device);
            }
        }
        if (profile.device.equals(currentPeer)) updateConversationHeader(profile.device);
        renderPeers();
    }

    // --- отрисовка -------------------------------------------------------------

    /**
     * Переключение экранов с проявлением.
     *
     * Анимируется только появление: уходящий экран прячется сразу. Иначе два
     * полноэкранных слоя на мгновение накладываются, и сквозь верхний видно
     * нижний — панели полупрозрачные.
     */
    /**
     * Три корневых экрана островка.
     *
     * Это именно переключение, а не переход вглубь: путь назад обрывается, и
     * «назад» с любой вкладки закрывает приложение, а не гоняет по кругу.
     */
    private void switchTab(View screen) {
        history.clear();
        navDirection = screen == screenChat ? -1 : 1;
        show(screen);
    }

    /**
     * Островок виден только на корневых экранах.
     *
     * В переписке и в глубоких разделах он бы закрывал строку ввода и нижние
     * строки списка, а пользы там от него нет.
     */
    private void updateTabBar(View screen) {
        boolean root = screen == screenChat || screen == screenSettings || screen == screenProfile;
        tabBar.setVisibility(root ? View.VISIBLE : View.GONE);
        if (!root) return;

        // Размывать надо именно тот экран, что под островком.
        tabBar.setSource(screen);
        int accent = accentColor();
        for (int[] tab : new int[][]{
                {R.id.nav_chats, R.id.nav_chats_icon, R.id.nav_chats_label},
                {R.id.nav_settings, R.id.nav_settings_icon, R.id.nav_settings_label},
                {R.id.nav_profile, R.id.nav_profile_icon, R.id.nav_profile_label},
        }) {
            boolean active = (tab[0] == R.id.nav_chats && screen == screenChat)
                    || (tab[0] == R.id.nav_settings && screen == screenSettings)
                    || (tab[0] == R.id.nav_profile && screen == screenProfile);
            ((ImageView) findViewById(tab[1])).setImageTintList(
                    ColorStateList.valueOf(active ? accent : getColor(R.color.obsidian_muted)));
            ((TextView) findViewById(tab[2])).setTextColor(
                    active ? accent : getColor(R.color.obsidian_muted));
        }
    }

    /** Уходит вглубь, запоминая, откуда пришли. */
    private void open(View screen) {
        if (currentScreen != null && currentScreen != screen) history.add(currentScreen);
        navDirection = 1;
        show(screen);
    }

    /**
     * Шаг назад.
     *
     * @return {@code false}, если возвращаться некуда — тогда «назад» отдаётся
     *         системе и закрывает приложение, но только на самом верху.
     */
    private boolean goBack() {
        if (history.isEmpty()) return false;
        navDirection = -1;
        show(history.remove(history.size() - 1));
        return true;
    }

    private void show(View screen) {
        currentScreen = screen;
        if (tabBar != null) updateTabBar(screen);
        // Следующий переход снова считается движением вглубь, пока не сказано
        // иначе: «назад» выставляет знак сам.
        int enter = navDirection;
        navDirection = 1;
        // Корневые экраны обрывают путь: возвращаться из них уже некуда.
        if (screen == screenChat || screen == screenEntry || screen == screenBoot
                || screen == screenMigrate) {
            history.clear();
        }
        for (View candidate : new View[]{screenBoot, screenMigrate, screenEntry, screenRecover,
                screenChat, screenConversation, screenProfile, screenSettings, screenPrivacy,
                screenPrivacySection, screenAppearance, screenUsername, screenSecurity,
                screenAdmin, screenChatSettings, screenData, screenChannel}) {
            if (candidate == null) continue;
            if (candidate != screen) {
                candidate.animate().cancel();
                candidate.setVisibility(View.GONE);
                continue;
            }
            boolean alreadyShown = candidate.getVisibility() == View.VISIBLE;
            candidate.setVisibility(View.VISIBLE);
            if (alreadyShown) continue;
            // Начинаем не с нуля: уходящий экран прячется сразу, и при полной
            // прозрачности входящего между ними мелькает пустота.
            candidate.setAlpha(0.35f);
            candidate.setTranslationY(0f);
            candidate.setTranslationX(enter * dp(22));
            candidate.animate()
                    .alpha(1f)
                    .translationX(0f)
                    .setDuration(220)
                    .setInterpolator(new android.view.animation.DecelerateInterpolator(1.6f))
                    .start();
        }
    }

    /**
     * Отклик на нажатие: кнопка слегка проседает.
     *
     * Ставится обходом дерева, а не в стиле: стилей у кнопок несколько, и
     * забыть одну из них было бы легко, а разнобой в отклике заметен сразу.
     * Обработчик именно OnTouchListener, а не stateListAnimator, — последний
     * теряется, когда фон кнопки переустанавливают из кода (а это делает
     * applyAccent).
     */
    private void installPressFeedback(View view) {
        if (view instanceof Button || view instanceof android.widget.ImageButton) {
            view.setOnTouchListener((target, event) -> {
                int action = event.getActionMasked();
                if (action == android.view.MotionEvent.ACTION_DOWN) {
                    target.animate().scaleX(.96f).scaleY(.96f).setDuration(90).start();
                } else if (action == android.view.MotionEvent.ACTION_UP
                        || action == android.view.MotionEvent.ACTION_CANCEL) {
                    target.animate().scaleX(1f).scaleY(1f).setDuration(130).start();
                }
                return false; // клик обрабатывает обычный OnClickListener
            });
        }
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) installPressFeedback(group.getChildAt(i));
        }
    }

    private void showFatal(String message) {
        show(screenBoot);
        ((TextView) findViewById(R.id.boot_status)).setText(message);
    }

    private void showStartupError(Throwable error) {
        String type = error.getClass().getSimpleName();
        showFatal(getString(R.string.startup_error, type));
    }

    private void setMyDevice(String device) {
        myDeviceHex = device;
        myDevice.setText(shortHex(device));
    }

    private void copyDevice() {
        if (myDeviceHex.isEmpty()) return;
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Obsidian device", myDeviceHex));
        toast(getString(R.string.device_copied));
    }

    /** Переписки, подходящие под строку поиска. */
    private List<String> matchingPeers() {
        List<String> found = new ArrayList<>();
        for (String peer : conversations.keySet()) {
            if (listFilter.isEmpty() || haystack(peer).contains(listFilter)) found.add(peer);
        }
        return found;
    }

    private String haystack(String peer) {
        Profile profile = profiles.get(peer);
        StringBuilder out = new StringBuilder(displayName(peer)).append(' ').append(peer);
        if (profile != null) out.append(' ').append(profile.chatCode).append(' ').append(profile.handle);
        return out.toString().toLowerCase(Locale.ROOT);
    }

    private TextView listNotice(String text) {
        TextView notice = new TextView(this);
        notice.setText(text);
        notice.setTextColor(getColor(R.color.obsidian_muted));
        notice.setTextSize(14);
        notice.setGravity(Gravity.CENTER);
        notice.setPadding(0, dp(80), 0, dp(40));
        return notice;
    }

    private void copyChatCode() {
        if (ownChatCode.isEmpty()) {
            toast(getString(R.string.chat_code_waiting));
            return;
        }
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Obsidian chat code", ownChatCode));
        toast("Код для чата скопирован");
    }

    /**
     * Состояние связи — цветом точки, а не строкой.
     *
     * Слова при этом никуда не деваются: три состояния одним цветом различает
     * не каждый глаз, и человеку должно быть чем проверить себя. Точка
     * подписана для чтения с экрана и отвечает словами по нажатию.
     */
    private void setStatus(String text) {
        statusText = text;
        View dot = findViewById(R.id.status_dot);
        int color = getString(R.string.status_online).equals(text)
                ? getColor(R.color.obsidian_green)
                : getString(R.string.status_reconnecting).equals(text)
                        ? getColor(R.color.obsidian_danger)
                        : Color.rgb(224, 178, 92);
        dot.setBackgroundTintList(ColorStateList.valueOf(color));
        status.setContentDescription(text);
        ((TextView) findViewById(R.id.status_text)).setText(text);
        // Смена состояния коротко подсвечивается: иначе точку легко не заметить.
        dot.animate().cancel();
        dot.setScaleX(0.6f);
        dot.setScaleY(0.6f);
        dot.animate().scaleX(1f).scaleY(1f).setDuration(220)
                .setInterpolator(new android.view.animation.OvershootInterpolator(2f))
                .start();
    }

    private void renderPeers() {
        contactList.removeAllViews();
        if (lookupHit != null) contactList.addView(searchHitRow(lookupHit));
        if (!listFilter.isEmpty() && matchingPeers().isEmpty()) {
            if (lookupHit == null) {
                contactList.addView(listNotice(lookupMissed
                        ? getString(R.string.search_miss) : getString(R.string.nothing_found)));
            }
            return;
        }
        if (conversations.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText("Пока нет контактов\nДобавьте человека по короткому OBS-коду");
            empty.setTextColor(getColor(R.color.obsidian_muted));
            empty.setTextSize(14);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, dp(80), 0, dp(40));
            contactList.addView(empty);
            return;
        }
        for (String peer : matchingPeers()) {
            Profile profile = profiles.get(peer);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(12), dp(10), dp(12), dp(10));
            row.setBackgroundResource(R.drawable.panel_glass);
            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(66));
            rowParams.bottomMargin = dp(8);
            row.setLayoutParams(rowParams);

            TextView avatar = new TextView(this);
            avatar.setGravity(Gravity.CENTER);
            avatar.setTextColor(Color.WHITE);
            avatar.setBackgroundResource(R.drawable.input_glass);
            avatar.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
            applyAvatar(avatar, profile, initials(peer));

            LinearLayout copy = new LinearLayout(this);
            copy.setOrientation(LinearLayout.VERTICAL);
            copy.setPadding(dp(12), 0, 0, 0);
            copy.setLayoutParams(new LinearLayout.LayoutParams(0,
                    LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            TextView title = new TextView(this);
            title.setText(nameWithEmblem(peer));
            title.setTextColor(Color.WHITE);
            title.setTextSize(15);
            TextView subtitle = new TextView(this);
            subtitle.setText(profile != null && !profile.chatCode.isEmpty()
                    ? profile.chatCode : shortHex(peer));
            subtitle.setTextColor(getColor(R.color.obsidian_muted));
            subtitle.setTextSize(11);
            copy.addView(title);
            copy.addView(subtitle);
            row.addView(avatar);
            row.addView(copy);
            row.setOnClickListener(v -> selectPeer(peer));
            contactList.addView(row);
        }
    }

    private void selectPeer(String peer) {
        // Позицию покидаемой беседы запоминаем: вернуться в середину переписки
        // и оказаться внизу — это потерянное место чтения.
        String leaving = conversations.get(currentPeer);
        if (leaving != null && pages.containsKey(leaving)) {
            pages.get(leaving).scrollY = messagesScroll.getScrollY();
        }

        currentPeer = peer;
        updateConversationHeader(peer);
        open(screenConversation);

        String conversation = conversations.get(peer);
        if (TextUtils.isEmpty(conversation)) {
            messages.removeAllViews();
        } else {
            ChatPage entry = page(conversation);
            // Уже открывали — показываем мгновенно и в базу не ходим.
            paintConversation(conversation);
            if (!entry.loaded) loadOlder(conversation);
        }
        if (profilesSupported && !profiles.containsKey(peer)) submit(Commands.profileGet(peer));
    }

    /** Рисует кэш беседы целиком. Пузыри переиспользуются, поэтому это дёшево. */
    private void paintConversation(String conversation) {
        ChatPage entry = page(conversation);
        messages.removeAllViews();
        for (View bubble : entry.bubbles) {
            // Узел мог остаться прикреплённым к прошлой раскладке.
            if (bubble.getParent() instanceof ViewGroup) {
                ((ViewGroup) bubble.getParent()).removeView(bubble);
            }
            messages.addView(bubble);
        }
        if (entry.scrollY < 0) {
            messagesScroll.post(() -> messagesScroll.fullScroll(View.FOCUS_DOWN));
        } else {
            final int target = entry.scrollY;
            messagesScroll.post(() -> messagesScroll.scrollTo(0, target));
        }
    }

    /** Просит следующую страницу — более старую, чем всё, что уже есть. */
    private void loadOlder(String conversation) {
        ChatPage entry = page(conversation);
        if (entry.loading || !entry.hasMore) return;
        entry.loading = true;
        submit(Commands.history(conversation, HISTORY_PAGE, entry.oldest));
    }

    private void updateConversationHeader(String peer) {
        Profile profile = profiles.get(peer);
        peerName.setText(nameWithEmblem(peer));
        applyAvatar(peerAvatar, profile, initials(peer));
    }

    private String displayName(String peer) {
        Profile profile = profiles.get(peer);
        return profile != null && !profile.handle.isEmpty() ? "@" + profile.handle : shortHex(peer);
    }

    /** Имя со значком владельца — тем самым, который он выбрал у себя. */
    private String nameWithEmblem(String peer) {
        Profile profile = profiles.get(peer);
        String glyph = profile == null ? "" : emblemGlyph(profile.emblem);
        return glyph.isEmpty() ? displayName(peer) : displayName(peer) + " " + glyph;
    }

    private String initials(String value) {
        return value == null || value.length() < 2 ? "--" : value.substring(0, 2).toUpperCase(Locale.ROOT);
    }

    private void applyAvatar(TextView view, Profile profile, String fallback) {
        int tint = profile == null ? 0 : profileColor(profile.color);
        if (profile == null || profile.avatarBase64.isEmpty()) {
            view.setText(fallback);
            view.setBackground(avatarPlaceholder(tint));
            return;
        }
        try {
            byte[] bytes = Base64.decode(profile.avatarBase64, Base64.NO_WRAP);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            view.setText("");
            view.setBackground(roundedAvatar(bitmap));
        } catch (RuntimeException error) {
            view.setText(fallback);
            view.setBackground(avatarPlaceholder(tint));
        }
    }

    /** Скругление аватара: круг или квадрат со скруглением, как выбрано. */
    private float avatarRadius() {
        boolean square = squareAvatars != null && squareAvatars.isChecked();
        return square ? dp(10) : dp(999);
    }

    private GradientDrawable avatarPlaceholder() {
        return avatarPlaceholder(0);
    }

    /**
     * Подложка аватара, при желании — цветом профиля.
     *
     * Цвет достаётся именно подложке, а не буквам имени: тёмно-синие или
     * фиолетовые буквы на почти чёрном фоне читаются плохо, и половина палитры
     * оказалась бы негодной. Подложка заметна при любом цвете.
     */
    private GradientDrawable avatarPlaceholder(int tint) {
        boolean light = "light".equals(themeName());
        int base = light ? Color.rgb(232, 232, 229) : Color.rgb(24, 24, 24);
        int line = light ? Color.rgb(219, 219, 214) : Color.rgb(45, 45, 45);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(tint == 0 ? base : blend(tint, base, 0.30f));
        shape.setStroke(dp(1), tint == 0 ? line : blend(tint, line, 0.55f));
        shape.setCornerRadius(avatarRadius());
        return shape;
    }

    /** Смешивает цвета: {@code amount} — доля первого. */
    private static int blend(int color, int onto, float amount) {
        return Color.rgb(
                Math.round(Color.red(color) * amount + Color.red(onto) * (1 - amount)),
                Math.round(Color.green(color) * amount + Color.green(onto) * (1 - amount)),
                Math.round(Color.blue(color) * amount + Color.blue(onto) * (1 - amount)));
    }

    /**
     * Аватар в выбранной форме.
     *
     * BitmapShader, а не обрезка самой картинки: форму меняют переключателем в
     * настройках, и перекодировать все аватары ради этого не нужно.
     */
    private android.graphics.drawable.Drawable roundedAvatar(Bitmap bitmap) {
        android.graphics.drawable.ShapeDrawable shape = new android.graphics.drawable.ShapeDrawable(
                new android.graphics.drawable.shapes.RoundRectShape(
                        new float[]{avatarRadius(), avatarRadius(), avatarRadius(), avatarRadius(),
                                avatarRadius(), avatarRadius(), avatarRadius(), avatarRadius()},
                        null, null));
        shape.getPaint().setShader(new android.graphics.BitmapShader(bitmap,
                android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP));
        return shape;
    }

    /** Собирает пузырь и кладёт его и в ленту, и в кэш открытой беседы. */
    private void addBubble(String body, boolean outgoing) {
        View bubble = buildBubble(body, outgoing);
        if (bubble == null) return;
        String conversation = conversations.get(currentPeer);
        if (conversation != null) {
            ChatPage entry = page(conversation);
            entry.bubbles.add(bubble);
            entry.loaded = true;
        }
        messages.addView(bubble);
        // Сообщение приезжает с той стороны, где стоит его пузырь: своё справа,
        // чужое слева. Так видно, кто написал, ещё до того как прочитан текст.
        bubble.setAlpha(0f);
        bubble.setTranslationY(dp(8));
        bubble.setTranslationX(outgoing ? dp(14) : -dp(14));
        bubble.animate()
                .alpha(1f)
                .translationY(0f)
                .translationX(0f)
                .setDuration(210)
                .setInterpolator(new android.view.animation.DecelerateInterpolator(1.6f))
                .start();
        messagesScroll.post(() -> messagesScroll.fullScroll(View.FOCUS_DOWN));
    }

    /**
     * Собирает пузырь, но никуда его не вставляет.
     *
     * Узел хранится вместе с беседой в кэше и переиспользуется при возврате:
     * заново разбирать base64 фотографии на каждое переключение незачем.
     */
    private View buildBubble(String body, boolean outgoing) {
        return buildBubble(body, outgoing, currentPeer);
    }

    private View buildBubble(String body, boolean outgoing, String peer) {
        JSONObject content = parseContent(body);
        // Отметка о прочтении — не сообщение: она меняет галочки у уже
        // нарисованных пузырей и своего места в ленте не занимает.
        if ("read".equals(content.optString("type"))) {
            applyRead(content.optJSONArray("ids"));
            return null;
        }
        int maxWidth = Math.max(dp(150), getResources().getDisplayMetrics().widthPixels * messageWidthPercent() / 100);
        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        String id = content.optString("id");
        if (!id.isEmpty()) bubble.setTag(id);
        int horizontal = compactMessages.isChecked() ? 12 : 16;
        int vertical = compactMessages.isChecked() ? 8 : 11;
        bubble.setPadding(dp(horizontal), dp(vertical), dp(horizontal), dp(vertical));
        bubble.setBackground(bubbleBackground(outgoing));

        JSONObject reply = content.optJSONObject("reply");
        if (reply != null && !reply.optString("text").isEmpty()) {
            bubble.addView(quoteView(reply.optString("text"), outgoing));
        }

        String rule = contentRule(content.optString("type"));
        if (!outgoing && rule != null && !permits(rule, peer)) {
            // Вместо тишины — заглушка: молча выброшенное вложение выглядело бы
            // как потерянное сообщение, и человек не понял бы, что сработала
            // его же настройка. Показать можно — решение остаётся за ним.
            bubble.addView(hiddenAttachment(body, outgoing, peer, bubble));
        } else if ("voice".equals(content.optString("type"))) {
            bubble.addView(voiceRow(content, outgoing, maxWidth));
        } else if ("image".equals(content.optString("type"))) {
            try {
                byte[] bytes = Base64.decode(content.optString("data"), Base64.NO_WRAP);
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                ImageView image = new ImageView(this);
                image.setAdjustViewBounds(true);
                image.setScaleType(ImageView.ScaleType.CENTER_CROP);
                image.setImageBitmap(bitmap);
                image.setMaxWidth(maxWidth);
                image.setMaxHeight(dp(420));
                image.setLayoutParams(new LinearLayout.LayoutParams(Math.min(maxWidth, dp(330)), LinearLayout.LayoutParams.WRAP_CONTENT));
                bubble.addView(image);
            } catch (RuntimeException ignored) {
                TextView failed = new TextView(this); failed.setText("Не удалось открыть фото"); failed.setTextColor(Color.GRAY); bubble.addView(failed);
            }
        } else {
            TextView text = new TextView(this);
            text.setText(content.optString("text", body));
            text.setTextColor(outgoing
                    ? (Color.luminance(accentColor()) > .55 ? Color.BLACK : Color.WHITE)
                    : themeText());
            text.setTag(R.id.base_text_size_tag, (float) messageTextSp());
            text.setTextSize(messageTextSp() * (interfaceScale.getProgress() + 85) / 100f);
            text.setMaxWidth(maxWidth);
            bubble.addView(text);
        }
        if (outgoing && !id.isEmpty()) {
            TextView delivery = new TextView(this);
            delivery.setTag("delivery");
            delivery.setText(readIds.contains(id) ? "✓✓ прочитано" : "✓ отправлено");
            delivery.setTextColor(outgoing && Color.luminance(accentColor()) > .55 ? Color.DKGRAY : Color.LTGRAY);
            delivery.setTextSize(9);
            delivery.setTag(R.id.base_text_size_tag, 9f);
            delivery.setGravity(Gravity.END);
            LinearLayout.LayoutParams deliveryParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            deliveryParams.gravity = Gravity.END; deliveryParams.topMargin = dp(4); delivery.setLayoutParams(deliveryParams);
            bubble.addView(delivery);
        }

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.gravity = outgoing ? Gravity.END : Gravity.START;
        params.bottomMargin = dp(8);
        params.leftMargin = outgoing ? dp(42) : 0;
        params.rightMargin = outgoing ? 0 : dp(42);
        bubble.setLayoutParams(params);

        String logical = content.optString("id");
        if (!logical.isEmpty()) {
            // Долгое нажатие — мобильный аналог правой кнопки.
            bubble.setOnLongClickListener(v -> {
                showMessageMenu(logical, content.optString("text", ""), outgoing);
                return true;
            });
        }
        return bubble;
    }

    /** Цитата над телом сообщения. */
    private View quoteView(String quoted, boolean outgoing) {
        LinearLayout quote = new LinearLayout(this);
        quote.setOrientation(LinearLayout.VERTICAL);
        quote.setBackgroundResource(R.drawable.quote_block);
        quote.setPadding(dp(9), dp(6), dp(9), dp(6));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(6);
        quote.setLayoutParams(params);

        int ink = outgoing && Color.luminance(accentColor()) > .55 ? Color.DKGRAY : Color.LTGRAY;

        TextView caption = new TextView(this);
        caption.setText(R.string.reply_to);
        caption.setTextColor(ink);
        caption.setTextSize(9);
        quote.addView(caption);

        TextView body = new TextView(this);
        body.setText(quoted);
        body.setTextColor(ink);
        body.setTextSize(11);
        body.setMaxLines(2);
        body.setEllipsize(android.text.TextUtils.TruncateAt.END);
        quote.addView(body);
        return quote;
    }

    private void onDeleted(JSONObject event) {
        String conversation = event.optString("conversation");
        JSONArray ids = event.optJSONArray("ids");
        if (ids == null) return;
        ChatPage entry = pages.get(conversation);
        for (int i = 0; i < ids.length(); i++) {
            String id = ids.optString(i);
            View found = messages.findViewWithTag(id);
            if (found != null) messages.removeView(found);
            if (entry != null) {
                entry.bubbles.removeIf(bubble -> id.equals(bubble.getTag()));
            }
        }
    }

    private void onConversationCleared(JSONObject event) {
        String conversation = event.optString("conversation");
        pages.remove(conversation);
        if (event.optBoolean("forgotten")) {
            String peer = peerOf(conversation);
            if (peer != null) conversations.remove(peer);
            if (peer != null && peer.equals(currentPeer)) {
                currentPeer = null;
                show(screenChat);
            }
            renderPeers();
            toast("Чат удалён");
        } else {
            if (conversation.equals(conversations.get(currentPeer))) messages.removeAllViews();
            toast("Переписка очищена");
        }
    }

    // --- меню сообщения -------------------------------------------------------

    private String replyId;
    private String replyText;

    private void showMessageMenu(String id, String text, boolean outgoing) {
        // Просить об удалении можно только своё: чужую копию мы не
        // контролируем, и пункт обещал бы обратное.
        CharSequence[] items = outgoing
                ? new CharSequence[]{getString(R.string.reply), getString(R.string.copy),
                                     getString(R.string.delete_mine), getString(R.string.delete_both)}
                : new CharSequence[]{getString(R.string.reply), getString(R.string.copy),
                                     getString(R.string.delete_mine)};

        new AlertDialog.Builder(this)
                .setItems(items, (dialog, which) -> {
                    switch (which) {
                        case 0: setReply(id, text); break;
                        case 1: copyToClipboard(text, "Скопировано"); break;
                        case 2: confirmDelete(id, false); break;
                        default: confirmDelete(id, true); break;
                    }
                })
                .show();
    }

    /**
     * Спрашивает перед удалением, если так велено в настройках.
     *
     * Отменить удаление нечем: сообщение стирается из базы, а «у обоих» ещё и
     * уходит просьбой собеседнику. Поэтому вопрос включён по умолчанию, а
     * выключение — осознанный выбор того, кто устал подтверждать.
     */
    private void confirmDelete(String id, boolean forBoth) {
        if (!chatPreference("confirm_delete", true)) {
            deleteMessage(id, forBoth);
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(forBoth ? R.string.delete_both : R.string.delete_mine)
                .setMessage(forBoth ? R.string.delete_both_hint : R.string.delete_mine_hint)
                .setPositiveButton(R.string.delete, (dialog, which) -> deleteMessage(id, forBoth))
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void deleteMessage(String id, boolean forBoth) {
        String conversation = conversations.get(currentPeer);
        if (conversation != null) submit(Commands.deleteMessage(conversation, id, forBoth));
    }

    private void setReply(String id, String text) {
        replyId = id;
        replyText = text;
        View bar = findViewById(R.id.reply_bar);
        bar.setVisibility(id == null ? View.GONE : View.VISIBLE);
        if (id != null) {
            ((TextView) findViewById(R.id.reply_text)).setText(getString(R.string.reply_to) + ": " + text);
        }
    }

    // --- профиль собеседника ---------------------------------------------------

    private void showPeerCard(String device) {
        Profile profile = profiles.get(device);
        JSONObject entry = directory.get(device);
        String standing = entry == null ? "" : entry.optString("standing");

        StringBuilder body = new StringBuilder();
        body.append(profile != null && profile.handle != null && !profile.handle.isEmpty()
                ? "@" + profile.handle : "юзернейм не указан").append("\n\n");
        body.append("Положение: ").append(standingLabel(standing)).append('\n');
        if (profile != null && profile.chatCode != null) {
            body.append("Код для чата: ").append(profile.chatCode).append('\n');
        }
        body.append("Устройство: ").append(shortHex(device));

        boolean isContact = "contact".equals(standing);
        new AlertDialog.Builder(this)
                .setTitle(displayName(device))
                .setMessage(body.toString())
                .setPositiveButton(isContact ? R.string.remove_contact : R.string.add_contact,
                        (dialog, which) -> submit(Commands.directorySet(device, isContact ? "approved" : "contact")))
                .setNeutralButton(R.string.verify_keys, (dialog, which) -> submit(Commands.verify(device)))
                .setNegativeButton("Ещё", (dialog, which) -> showPeerActions(device))
                .show();
    }

    private String standingLabel(String standing) {
        switch (standing) {
            case "contact": return "в контактах";
            case "approved": return "запрос принят";
            case "pending": return "ждёт вашего решения";
            case "blocked": return "заблокирован";
            default: return "не в контактах";
        }
    }

    private void showPeerActions(String device) {
        CharSequence[] items = {
                getString(R.string.clear_chat),
                getString(R.string.delete_chat),
                getString(R.string.block),
        };
        new AlertDialog.Builder(this)
                .setTitle(displayName(device))
                .setItems(items, (dialog, which) -> {
                    String conversation = conversations.get(device);
                    switch (which) {
                        case 0:
                            confirm("Очистить переписку?",
                                    "Сообщения исчезнут с этого устройства. У собеседника они останутся.",
                                    () -> {
                                        if (conversation != null) submit(Commands.clearConversation(conversation));
                                    });
                            break;
                        case 1:
                            confirm("Удалить чат?",
                                    "Переписка и сама беседа исчезнут с этого устройства.",
                                    () -> {
                                        if (conversation != null) submit(Commands.deleteConversation(conversation));
                                    });
                            break;
                        default:
                            confirm("Заблокировать?",
                                    "Его сообщения перестанут приходить и не будут сохраняться.",
                                    () -> submit(Commands.directorySet(device, "blocked")));
                            break;
                    }
                })
                .show();
    }

    /** Подтверждение необратимого действия. */
    private void confirm(String title, String detail, Runnable onYes) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(detail)
                .setPositiveButton("Да", (dialog, which) -> onYes.run())
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    /**
     * Строка голосового: кнопка, полоса и время.
     *
     * Проигрыватель собран вручную, а не через системные контролы: те тянут
     * свою вёрстку, которая не подчиняется ни теме, ни скруглению пузыря.
     */
    private View voiceRow(JSONObject content, boolean outgoing, int maxWidth) {
        int tint = outgoing
                ? (Color.luminance(accentColor()) > .55 ? Color.BLACK : Color.WHITE)
                : themeText();

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumWidth(Math.min(maxWidth, dp(210)));

        Button play = new Button(this);
        play.setText("▶");
        play.setAllCaps(false);
        play.setTextColor(tint);
        play.setStateListAnimator(null);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.argb(38, Color.red(tint), Color.green(tint), Color.blue(tint)));
        play.setBackground(circle);
        play.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));

        android.widget.ProgressBar track = new android.widget.ProgressBar(
                this, null, android.R.attr.progressBarStyleHorizontal);
        track.setMax(1000);
        track.setProgressTintList(ColorStateList.valueOf(tint));
        track.setProgressBackgroundTintList(ColorStateList.valueOf(
                Color.argb(60, Color.red(tint), Color.green(tint), Color.blue(tint))));
        LinearLayout.LayoutParams trackParams =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        trackParams.setMarginStart(dp(10));
        trackParams.setMarginEnd(dp(10));
        track.setLayoutParams(trackParams);

        int seconds = content.optInt("duration");
        TextView time = new TextView(this);
        time.setText(clock(seconds));
        time.setTextColor(tint);
        time.setTextSize(11);
        time.setTag(R.id.base_text_size_tag, 11f);
        time.setAlpha(.75f);

        // На кнопке висит способ запустить именно это голосовое. Так следующее
        // находится обходом ленты, а не по номеру, выданному при сборке.
        play.setTag(R.id.voice_starter_tag,
                (Runnable) () -> playVoice(content, play, track, time, seconds));
        play.setOnClickListener(v -> playVoice(content, play, track, time, seconds));
        row.addView(play);
        row.addView(track);
        row.addView(time);
        return row;
    }

    private void playVoice(JSONObject content, Button play, android.widget.ProgressBar track,
            TextView time, int seconds) {
        if (voicePlayer != null && voicePlayer.isPlaying()) {
            stopVoicePlayback();
            play.setText("▶");
            return;
        }
        try {
            byte[] bytes = Base64.decode(content.optString("data"), Base64.NO_WRAP);
            // Расширение по mime: ПК записывает Opus в WebM, телефон — AAC в MP4,
            // и оба должны открываться на обеих сторонах.
            String extension = content.optString("mime").contains("webm") ? ".webm"
                    : content.optString("mime").contains("ogg") ? ".ogg" : ".m4a";
            File file = new File(getCacheDir(), "play-" + content.optString("id") + extension);
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(bytes);
            }
            stopVoicePlayback();
            MediaPlayer player = new MediaPlayer();
            player.setDataSource(file.getAbsolutePath());
            player.prepare();
            player.start();
            voicePlayer = player;
            play.setText("❚❚");

            Runnable progress = new Runnable() {
                @Override public void run() {
                    if (voicePlayer != player) return;
                    int total = player.getDuration() > 0 ? player.getDuration() : seconds * 1000;
                    if (total > 0) track.setProgress(player.getCurrentPosition() * 1000 / total);
                    time.setText(clock(player.getCurrentPosition() / 1000));
                    ui.postDelayed(this, 120);
                }
            };
            ui.postDelayed(progress, 120);

            player.setOnCompletionListener(done -> {
                ui.removeCallbacks(progress);
                play.setText("▶");
                track.setProgress(0);
                time.setText(clock(seconds));
                stopVoicePlayback();
                file.delete();
                // Следующее — только если о нём просили и оно есть.
                if (chatPreference("voice_autoplay", false)) {
                    Runnable next = nextVoiceAfter(play);
                    if (next != null) ui.postDelayed(next, 250);
                }
            });
        } catch (Exception error) {
            toast(getString(R.string.voice_play_failed));
        }
    }


    // --- восстановление доступа ------------------------------------------------

    private void configureRecovery() {
        findViewById(R.id.open_recover).setOnClickListener(v -> {
            recoverError.setText("");
            show(screenRecover);
        });
        findViewById(R.id.recover_back).setOnClickListener(v -> show(screenEntry));
        findViewById(R.id.recover_mode_code).setOnClickListener(v -> setRecoverMode(true));
        findViewById(R.id.recover_mode_password).setOnClickListener(v -> setRecoverMode(false));
        recoverSubmit.setOnClickListener(v -> submitRecovery());
        setRecoverMode(true);

        recoveryCodeToggle.setOnClickListener(v -> toggleRecoveryCode());
        recoveryCodeCopy.setOnClickListener(v -> {
            if (recoveryCodeValue.isEmpty()) return;
            android.content.ClipboardManager clipboard =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(
                    android.content.ClipData.newPlainText("Obsidian recovery", recoveryCodeValue));
            toast(getString(R.string.recovery_code_copied));
        });
        recoveryPasswordSave.setOnClickListener(v -> saveRecoveryPassword());
        findViewById(R.id.recovery_password_forget)
                .setOnClickListener(v -> submit(Commands.recoveryForget()));
    }

    private void setRecoverMode(boolean byCode) {
        recoverByCode = byCode;
        recoverFormCode.setVisibility(byCode ? View.VISIBLE : View.GONE);
        recoverFormPassword.setVisibility(byCode ? View.GONE : View.VISIBLE);
        recoverError.setText("");
        highlightSegment(byCode ? R.id.recover_mode_code : R.id.recover_mode_password,
                R.id.recover_mode_code, R.id.recover_mode_password);
    }

    /** Подсвечивает выбранную кнопку в группе-сегменте. */
    private void highlightSegment(int active, int... group) {
        for (int id : group) {
            Button button = findViewById(id);
            boolean on = id == active;
            button.setBackgroundTintList(ColorStateList.valueOf(
                    on ? accentColor() : Color.argb(255, 26, 26, 26)));
            button.setTextColor(on
                    ? (Color.luminance(accentColor()) > .55 ? Color.BLACK : Color.WHITE)
                    : getColor(R.color.obsidian_muted));
        }
    }

    private void submitRecovery() {
        recoverError.setText("");
        if (recoverByCode) {
            String code = recoverCode.getText().toString().trim();
            if (code.isEmpty()) return;
            recoverSubmit.setEnabled(false);
            recoverSubmit.setText(R.string.recover_working);
            submit(Commands.recover(SERVER_URL, code));
            return;
        }
        String login = recoverLogin.getText().toString().trim();
        String password = recoverPassword.getText().toString();
        if (login.length() < 3) { recoverError.setText(R.string.recovery_login_min); return; }
        if (password.isEmpty()) return;
        recoverSubmit.setEnabled(false);
        // Argon2id на 128 МиБ считается заметное время; молчащая кнопка
        // выглядела бы как зависание.
        recoverSubmit.setText(R.string.recover_password_working);
        submit(Commands.recoverPassword(SERVER_URL, login, password));
    }

    private void resetRecoverButton() {
        recoverSubmit.setEnabled(true);
        recoverSubmit.setText(R.string.recover_action);
    }

    private void toggleRecoveryCode() {
        if (recoveryCodeText.getVisibility() == View.VISIBLE) {
            // Код не должен оставаться на экране: его слишком легко снять камерой.
            recoveryCodeText.setVisibility(View.GONE);
            recoveryCodeCopy.setVisibility(View.GONE);
            recoveryCodeText.setText("");
            recoveryCodeValue = "";
            recoveryCodeToggle.setText(R.string.recovery_code_show);
            return;
        }
        submit(Commands.recoveryCode());
    }

    private void showRecoveryCode(String code) {
        recoveryCodeValue = code;
        recoveryCodeText.setText(code);
        recoveryCodeText.setVisibility(View.VISIBLE);
        recoveryCodeText.setAlpha(0f);
        recoveryCodeText.animate().alpha(1f).setDuration(180).start();
        recoveryCodeCopy.setVisibility(View.VISIBLE);
        recoveryCodeToggle.setText(R.string.recovery_code_hide);
    }

    private void saveRecoveryPassword() {
        String login = recoveryLogin.getText().toString().trim();
        String password = recoveryPassword.getText().toString();
        if (login.length() < 3) { setRecoveryStatus(getString(R.string.recovery_login_min), true); return; }
        if (password.length() < 10) { setRecoveryStatus(getString(R.string.recovery_password_min), true); return; }
        recoveryPasswordSave.setEnabled(false);
        setRecoveryStatus(getString(R.string.recovery_computing), false);
        submit(Commands.recoverySetup(login, password));
    }

    private void setRecoveryStatus(String message, boolean bad) {
        recoveryStatus.setText(message);
        recoveryStatus.setTextColor(bad ? getColor(R.color.obsidian_danger) : getColor(R.color.obsidian_muted));
    }

    /**
     * Понятный текст отказа. null означает, что отказ не про восстановление и
     * его должен разобрать общий обработчик.
     */
    private String recoveryError(String code) {
        switch (code) {
            case "bad_recovery_code": return getString(R.string.recovery_error_code);
            case "bad_password":
            case "recovery_not_found": return getString(R.string.recovery_error_password);
            case "recovery_rate_limited": return getString(R.string.recovery_error_limit);
            case "identity_exists": return getString(R.string.recovery_error_exists);
            case "login_taken": return getString(R.string.recovery_error_login_taken);
            case "recover": return getString(R.string.recovery_error_generic);
            default: return null;
        }
    }

    // --- голосовые сообщения ---------------------------------------------------

    private void configureVoice() {
        recordVoice.setOnClickListener(v -> {
            if (voiceRecorder != null) { stopRecording(true); return; }
            if (currentPeer == null) return;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                        MICROPHONE_PERMISSION_REQUEST);
                return;
            }
            startRecording();
        });
        findViewById(R.id.recording_stop).setOnClickListener(v -> stopRecording(true));
        findViewById(R.id.recording_cancel).setOnClickListener(v -> stopRecording(false));
    }

    private void startRecording() {
        try {
            voiceFile = new File(getCacheDir(), "voice-" + System.currentTimeMillis() + ".m4a");
            MediaRecorder recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            // Речи хватает с запасом, а две минуты укладываются примерно в 360 КБ
            // — это пролезает в кадр вместе с накладными расходами MLS.
            recorder.setAudioEncodingBitRate(24000);
            recorder.setAudioSamplingRate(24000);
            recorder.setOutputFile(voiceFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            voiceRecorder = recorder;
        } catch (Exception error) {
            voiceRecorder = null;
            toast(getString(R.string.voice_failed));
            return;
        }

        voiceStartedAt = System.currentTimeMillis();
        recordingTime.setText("0:00");
        recordingBar.setVisibility(View.VISIBLE);
        recordingBar.setAlpha(0f);
        recordingBar.animate().alpha(1f).setDuration(160).start();
        pulseRecordingDot();

        voiceTicker = new Runnable() {
            @Override public void run() {
                long elapsed = (System.currentTimeMillis() - voiceStartedAt) / 1000;
                recordingTime.setText(clock(elapsed));
                if (elapsed >= MAX_VOICE_SEC) { stopRecording(true); return; }
                ui.postDelayed(this, 250);
            }
        };
        ui.postDelayed(voiceTicker, 250);
    }

    private void pulseRecordingDot() {
        View dot = findViewById(R.id.recording_dot);
        dot.setAlpha(1f);
        dot.animate().alpha(.2f).setDuration(550).withEndAction(() -> {
            if (voiceRecorder == null) return;
            dot.animate().alpha(1f).setDuration(550).withEndAction(this::pulseRecordingDot).start();
        }).start();
    }

    private void stopRecording(boolean keep) {
        MediaRecorder recorder = voiceRecorder;
        if (recorder == null) return;
        voiceRecorder = null;
        if (voiceTicker != null) ui.removeCallbacks(voiceTicker);
        recordingBar.setVisibility(View.GONE);

        long millis = System.currentTimeMillis() - voiceStartedAt;
        boolean captured;
        try {
            recorder.stop();
            captured = true;
        } catch (RuntimeException tooShort) {
            // MediaRecorder.stop() бросает, если писать было нечего: файл в этом
            // случае повреждён и отправлять его нельзя.
            captured = false;
        } finally {
            recorder.release();
        }

        File file = voiceFile;
        voiceFile = null;
        if (!keep || !captured || millis < 600 || file == null || !file.exists()) {
            if (file != null) file.delete();
            return;
        }
        sendVoice(file, Math.round(millis / 1000f), currentPeer);
    }

    private void sendVoice(File file, int seconds, String peer) {
        new Thread(() -> {
            try {
                byte[] bytes = new byte[(int) file.length()];
                try (InputStream input = new java.io.FileInputStream(file)) {
                    int read = 0;
                    while (read < bytes.length) {
                        int step = input.read(bytes, read, bytes.length - read);
                        if (step < 0) break;
                        read += step;
                    }
                }
                String data = Base64.encodeToString(bytes, Base64.NO_WRAP);
                if (data.length() > 700_000) throw new IOException("voice too large");
                String body = encodeVoice(logicalId(), data, seconds);
                submit(Commands.send(peer, body));
                runOnUiThread(() -> addBubble(body, true));
            } catch (Exception error) {
                runOnUiThread(() -> toast(getString(R.string.voice_too_long)));
            } finally {
                file.delete();
            }
        }, "obsidian-voice").start();
    }

    private static String encodeVoice(String id, String data, int seconds) {
        try {
            JSONObject value = new JSONObject().put("v", 1).put("type", "voice").put("id", id)
                    .put("mime", "audio/mp4").put("data", data).put("duration", seconds);
            return CONTENT_PREFIX + value;
        } catch (Exception impossible) {
            return "";
        }
    }

    private static String clock(long seconds) {
        return seconds / 60 + ":" + String.format(Locale.US, "%02d", seconds % 60);
    }

    /** Останавливает то, что играет сейчас: два голосовых разом — это каша. */
    /** Голосовое, идущее в ленте следом за этим. {@code null} — оно последнее. */
    private Runnable nextVoiceAfter(View current) {
        List<View> buttons = new ArrayList<>();
        collectVoiceButtons(messages, buttons);
        int index = buttons.indexOf(current);
        if (index < 0 || index + 1 >= buttons.size()) return null;
        Object starter = buttons.get(index + 1).getTag(R.id.voice_starter_tag);
        return starter instanceof Runnable ? (Runnable) starter : null;
    }

    private void collectVoiceButtons(View view, List<View> out) {
        if (view.getTag(R.id.voice_starter_tag) instanceof Runnable) out.add(view);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) collectVoiceButtons(group.getChildAt(i), out);
        }
    }

    private void stopVoicePlayback() {
        if (voicePlayer == null) return;
        voicePlayer.release();
        voicePlayer = null;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String peerOf(String conversation) {
        for (Map.Entry<String, String> entry : conversations.entrySet()) {
            if (conversation.equals(entry.getValue())) return entry.getKey();
        }
        return null;
    }

    private static String shortHex(String hex) {
        return hex == null || hex.length() <= 16
                ? (hex == null ? "" : hex)
                : hex.substring(0, 8) + "…" + hex.substring(hex.length() - 8);
    }

    @Override
    public void onBackPressed() {
        if (voiceRecorder != null) {
            // Первое «назад» во время записи отменяет её, а не закрывает экран.
            stopRecording(false);
            return;
        }
        if (screenRecover.getVisibility() == View.VISIBLE) {
            show(screenEntry);
            return;
        }
        if (goBack()) return;
        super.onBackPressed();
    }

    private static final class Profile {
        final String device;
        final String chatCode;
        final String handle;
        final String avatarMime;
        final String avatarBase64;
        /** Значок и цвет собеседника: их выбирает он, а показываем мы. */
        String emblem = "";
        String color = "";

        Profile(String device, String chatCode, String handle, String avatarMime,
                String avatarBase64) {
            this.device = device;
            this.chatCode = chatCode;
            this.handle = "null".equals(handle) ? "" : handle;
            this.avatarMime = "null".equals(avatarMime) ? "" : avatarMime;
            this.avatarBase64 = "null".equals(avatarBase64) ? "" : avatarBase64;
        }
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    /** Кладёт строку в буфер обмена и подтверждает это человеку. */
    private void copyToClipboard(String value, String confirmation) {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Obsidian", value));
        toast(confirmation);
    }

    /** Спокойная заглушка вместо скрытого вложения. */
    private View hiddenAttachment(String body, boolean outgoing, String peer, LinearLayout bubble) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);

        TextView title = new TextView(this);
        title.setText(R.string.attachment_hidden);
        title.setTextColor(getColor(R.color.obsidian_white));
        title.setTextSize(12);
        wrap.addView(title);

        TextView why = new TextView(this);
        why.setText(R.string.attachment_hidden_why);
        why.setTextColor(getColor(R.color.obsidian_muted));
        why.setTextSize(10);
        LinearLayout.LayoutParams whyParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        whyParams.topMargin = dp(4);
        why.setLayoutParams(whyParams);
        wrap.addView(why);

        Button show = new Button(this, null, 0, R.style.Obsidian_Button_Dark_Small);
        show.setText(R.string.show);
        show.setTextSize(10);
        LinearLayout.LayoutParams showParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(34));
        showParams.topMargin = dp(8);
        show.setLayoutParams(showParams);
        show.setOnClickListener(v -> {
            // Пересобираем тот же пузырь без проверки и подменяем им прежний.
            View shown = buildBubble(body, outgoing, null);
            ViewGroup parent = (ViewGroup) bubble.getParent();
            if (shown != null && parent != null) {
                int index = parent.indexOfChild(bubble);
                parent.removeViewAt(index);
                parent.addView(shown, index);
            }
        });
        wrap.addView(show);
        return wrap;
    }

    // --- приватность ------------------------------------------------------------

    /**
     * Описание правил, а не пятнадцать отдельных обработчиков.
     *
     * Порядок и состав повторяют ПК-клиент и {@code privacy.rs}: новое правило
     * добавляется в ядре и здесь, и больше нигде. Пустой список кругов означает
     * полный набор.
     */
    private static final String[][] PRIVACY_SPEC = {
            {"#", "Кто может обращаться"},
            {"direct_messages", "Личные сообщения",
             "Кто может вам написать. Проверяет сервер: постороннему конверт не поставят в очередь вовсе.",
             "everyone,approved,contacts,nobody"},

            {"#", "Что мне можно присылать"},
            {"media", "Фото и видео",
             "Вложения от незнакомых не будут показаны и сохранены.", ""},
            {"voice", "Голосовые сообщения", "", ""},
            {"files", "Файлы", "", ""},
            {"calls", "Звонки", "Звонков пока нет; правило начнёт действовать вместе с ними.", ""},
            {"link_previews", "Превью ссылок",
             "Чтобы показать превью, надо сходить на чужой сайт, и он увидит, что ссылку открыли вы.",
             "everyone,contacts,nobody"},

            {"#", "Что видно обо мне"},
            {"presence", "Сейчас в сети", "", "everyone,contacts,nobody"},
            {"last_seen", "Последняя активность",
             "По времени появления восстанавливают распорядок дня.", "everyone,contacts,nobody"},
            {"read_receipts", "Отчёты о прочтении",
             "Если выключить, собеседник видит «отправлено», но не «прочитано».", "everyone,contacts,nobody"},
            {"typing", "Индикатор набора текста", "", "everyone,contacts,nobody"},
            {"voice_recording_hint", "Показывать запись голосового", "", "everyone,contacts,nobody"},

            {"#", "Профиль и поиск"},
            {"discoverable", "Поиск по юзернейму",
             "«Никто» — сервер не отдаёт вас в поиске совсем.", "everyone,nobody"},
            {"profile_avatar", "Аватар", "", "everyone,contacts,nobody"},
            {"profile_name", "Имя профиля", "", "everyone,contacts,nobody"},
            {"profile_username", "Юзернейм", "", "everyone,contacts,nobody"},
    };

    private static final String DEFAULT_SCOPES = "everyone,approved,contacts,nobody";

    private static String scopeLabel(String scope) {
        switch (scope) {
            case "everyone": return "Все";
            case "approved": return "Одобренные";
            case "contacts": return "Контакты";
            default: return "Никто";
        }
    }

    /** Какая группа правил открыта: пятнадцать правил одним списком не читаются. */
    private int privacyTab;

    /**
     * Помечает выбранное состояние заливкой акцентом.
     *
     * Раньше выбранное отличалось от невыбранного едва заметной подсветкой, и
     * взгляд не находил, где он сейчас. Теперь выбранное — плашка цветом темы,
     * а невыбранное вовсе без фона: рамка одна, у дорожки.
     */
    private void markActive(Button button, boolean active, int activeBackground, int idleBackground) {
        button.setBackgroundResource(active ? activeBackground : idleBackground);
        if (active) {
            // Короткий подъём отмечает выбор. Дольше — и переключение начинает
            // ощущаться медленным.
            button.animate().cancel();
            button.setScaleX(0.94f);
            button.setScaleY(0.94f);
            button.animate().scaleX(1f).scaleY(1f).setDuration(160)
                    .setInterpolator(new android.view.animation.OvershootInterpolator(1.6f))
                    .start();
            int accent = accentColor();
            button.setBackgroundTintList(ColorStateList.valueOf(accent));
            button.setTextColor(Color.luminance(accent) > .55 ? Color.BLACK : Color.WHITE);
        } else {
            button.setBackgroundTintList(null);
            button.setTextColor(getColor(R.color.obsidian_muted));
        }
    }

    /** Иконки разделов приватности — по порядку заголовков в {@link #PRIVACY_SPEC}. */
    private static final int[] PRIVACY_ICONS = {
            R.drawable.ic_chat, R.drawable.ic_image, R.drawable.ic_lock, R.drawable.ic_person,
    };

    /**
     * Разделы приватности отдельными строками, а не вкладками наверху.
     *
     * Вкладки на телефоне уезжали за край и не читались; строка того же вида,
     * что и в настройках, попадает под палец и подписывается целиком.
     */
    private void renderPrivacySections() {
        LinearLayout host = findViewById(R.id.privacy_sections);
        host.removeAllViews();
        int index = 0;
        for (String[] row : PRIVACY_SPEC) {
            if (!"#".equals(row[0])) continue;
            final int position = index;
            if (host.getChildCount() > 0) {
                View line = new View(this);
                LinearLayout.LayoutParams lineParams =
                        new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1));
                lineParams.leftMargin = dp(50);
                line.setLayoutParams(lineParams);
                line.setBackgroundColor(getColor(R.color.obsidian_line));
                host.addView(line);
            }

            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.HORIZONTAL);
            item.setGravity(Gravity.CENTER_VERTICAL);
            item.setPadding(dp(14), 0, dp(14), 0);
            item.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(56)));

            ImageView icon = new ImageView(this);
            icon.setImageResource(PRIVACY_ICONS[Math.min(position, PRIVACY_ICONS.length - 1)]);
            LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(22), dp(22));
            iconParams.rightMargin = dp(14);
            icon.setLayoutParams(iconParams);
            item.addView(icon);

            TextView title = new TextView(this);
            title.setText(row[1]);
            title.setTextColor(getColor(R.color.obsidian_white));
            title.setTextSize(14);
            title.setLayoutParams(new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            item.addView(title);

            ImageView chevron = new ImageView(this);
            chevron.setImageResource(R.drawable.ic_chevron);
            chevron.setAlpha(0.5f);
            chevron.setLayoutParams(new LinearLayout.LayoutParams(dp(16), dp(16)));
            item.addView(chevron);

            item.setBackgroundResource(selectableItemBackground());
            item.setOnClickListener(v -> openPrivacySection(position, title.getText().toString()));
            host.addView(item);
            index++;
        }
    }

    /** Фон-отклик из темы: тот же, что у строк настроек в разметке. */
    private int selectableItemBackground() {
        android.util.TypedValue value = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, value, true);
        return value.resourceId;
    }

    private void openPrivacySection(int section, String title) {
        privacyTab = section;
        ((TextView) findViewById(R.id.privacy_section_title)).setText(title);
        open(screenPrivacySection);
        renderPrivacy();
    }

    private void renderPrivacy() {
        privacyGroups.removeAllViews();
        if (privacy == null) return;

        LinearLayout card = null;
        int group = -1;
        for (String[] row : PRIVACY_SPEC) {
            if ("#".equals(row[0])) {
                group++;
                if (group != privacyTab) {
                    card = null;
                    continue;
                }
                card = new LinearLayout(this);
                card.setOrientation(LinearLayout.VERTICAL);
                card.setBackgroundResource(R.drawable.card_flat);
                card.setPadding(dp(14), dp(4), dp(14), dp(4));
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                params.topMargin = dp(12);
                card.setLayoutParams(params);
                privacyGroups.addView(card);
                continue;
            }
            if (card != null) card.addView(privacyRow(row));
        }
    }

    private View privacyRow(String[] spec) {
        String key = spec[0];
        JSONObject rule = privacy.optJSONObject(key);
        if (rule == null) return new View(this);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, dp(12), 0, dp(12));

        TextView label = new TextView(this);
        label.setText(spec[1]);
        label.setTextColor(getColor(R.color.obsidian_white));
        label.setTextSize(13);
        row.addView(label);

        if (!spec[2].isEmpty()) {
            TextView hint = new TextView(this);
            hint.setText(spec[2]);
            hint.setTextColor(getColor(R.color.obsidian_muted));
            hint.setTextSize(10);
            LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            hintParams.topMargin = dp(3);
            hint.setLayoutParams(hintParams);
            row.addView(hint);
        }

        String[] scopes = (spec[3].isEmpty() ? DEFAULT_SCOPES : spec[3]).split(",");
        LinearLayout segment = new LinearLayout(this);
        segment.setOrientation(LinearLayout.HORIZONTAL);
        // Дорожка: рамка одна на весь ряд, а не вокруг каждого круга.
        segment.setBackgroundResource(R.drawable.segment_track);
        segment.setPadding(dp(3), dp(3), dp(3), dp(3));
        LinearLayout.LayoutParams segmentParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(42));
        segmentParams.topMargin = dp(9);
        segment.setLayoutParams(segmentParams);

        String current = rule.optString("scope");
        for (String scope : scopes) {
            Button choice = new Button(this, null, 0, R.style.Obsidian_Segment);
            choice.setText(scopeLabel(scope));
            markActive(choice, scope.equals(current), R.drawable.chip_active, R.drawable.chip_idle);
            LinearLayout.LayoutParams params =
                    new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
            if (segment.getChildCount() > 0) params.leftMargin = dp(2);
            choice.setLayoutParams(params);
            choice.setOnClickListener(v -> setScope(key, scope));
            segment.addView(choice);
        }
        row.addView(segment);

        LinearLayout foot = new LinearLayout(this);
        foot.setOrientation(LinearLayout.HORIZONTAL);
        foot.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams footParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        footParams.topMargin = dp(7);
        foot.setLayoutParams(footParams);

        TextView counts = new TextView(this);
        counts.setText(exceptionSummary(rule));
        counts.setTextColor(getColor(R.color.obsidian_dim));
        counts.setTextSize(9);
        counts.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        foot.addView(counts);

        Button exceptions = new Button(this, null, 0, R.style.Obsidian_Segment);
        exceptions.setText(R.string.exceptions);
        exceptions.setOnClickListener(v -> showExceptions(key, spec[1]));
        foot.addView(exceptions);
        row.addView(foot);

        return row;
    }

    private String exceptionSummary(JSONObject rule) {
        int allow = rule.optJSONArray("allow") == null ? 0 : rule.optJSONArray("allow").length();
        int deny = rule.optJSONArray("deny") == null ? 0 : rule.optJSONArray("deny").length();
        if (allow == 0 && deny == 0) return getString(R.string.exceptions_none);
        StringBuilder out = new StringBuilder();
        if (allow > 0) out.append("всегда разрешено: ").append(allow);
        if (deny > 0) out.append(out.length() > 0 ? " · " : "").append("никогда: ").append(deny);
        return out.toString();
    }

    private void setScope(String key, String scope) {
        JSONObject rule = privacy.optJSONObject(key);
        if (rule == null) return;
        try {
            rule.put("scope", scope);
        } catch (JSONException ignored) {
            return;
        }
        savePrivacy();
        // Видимость в поиске и политика доступа живут ещё и на сервере: без
        // этого настройка осталась бы записью в локальной базе.
        if ("discoverable".equals(key) && username != null) {
            submit(Commands.usernameSet(username, !"nobody".equals(scope)));
        }
        if ("direct_messages".equals(key)) {
            submit(Commands.accessSet("everyone".equals(scope) ? "everyone" : "passes"));
        }
        renderPrivacy();
    }

    private void savePrivacy() {
        if (privacy != null) submit(Commands.privacySet(privacy.toString()));
    }

    /**
     * Собеседники выбираются из списка, а не вводятся строкой: ключ устройства —
     * 64 символа, и правило с опечаткой молча не сработало бы.
     */
    private void showExceptions(String key, String title) {
        JSONObject rule = privacy.optJSONObject(key);
        if (rule == null) return;

        LinkedHashSet<String> peers = new LinkedHashSet<>(conversations.keySet());
        peers.addAll(directory.keySet());
        addAll(peers, rule.optJSONArray("allow"));
        addAll(peers, rule.optJSONArray("deny"));

        if (peers.isEmpty()) {
            toast("Пока некого добавить: список появится вместе с диалогами");
            return;
        }

        String[] names = new String[peers.size()];
        boolean[] checked = new boolean[peers.size()];
        String[] devices = peers.toArray(new String[0]);
        for (int i = 0; i < devices.length; i++) {
            String state = contains(rule.optJSONArray("deny"), devices[i]) ? " — никогда"
                    : contains(rule.optJSONArray("allow"), devices[i]) ? " — всегда" : "";
            names[i] = displayName(devices[i]) + state;
        }

        new AlertDialog.Builder(this)
                .setTitle(title + " · " + getString(R.string.exceptions))
                .setItems(names, (dialog, which) -> cycleException(key, devices[which]))
                .setNegativeButton("Закрыть", null)
                .show();
    }

    /** По кругу: по правилу → всегда → никогда → по правилу. */
    private void cycleException(String key, String device) {
        JSONObject rule = privacy.optJSONObject(key);
        if (rule == null) return;
        boolean allowed = contains(rule.optJSONArray("allow"), device);
        boolean denied = contains(rule.optJSONArray("deny"), device);

        JSONArray allow = without(rule.optJSONArray("allow"), device);
        JSONArray deny = without(rule.optJSONArray("deny"), device);
        if (!allowed && !denied) allow.put(device);
        else if (allowed) deny.put(device);

        try {
            rule.put("allow", allow);
            rule.put("deny", deny);
        } catch (JSONException ignored) {
            return;
        }
        savePrivacy();
        renderPrivacy();
        toast(displayName(device) + ": " + exceptionSummary(rule));
    }

    private static void addAll(LinkedHashSet<String> into, JSONArray from) {
        if (from == null) return;
        for (int i = 0; i < from.length(); i++) into.add(from.optString(i));
    }

    private static boolean contains(JSONArray array, String value) {
        if (array == null) return false;
        for (int i = 0; i < array.length(); i++) {
            if (value.equals(array.optString(i))) return true;
        }
        return false;
    }

    private static JSONArray without(JSONArray array, String value) {
        JSONArray out = new JSONArray();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            if (!value.equals(array.optString(i))) out.put(array.optString(i));
        }
        return out;
    }

    /**
     * Решает по тому же порядку, что и ядро: запрет, разрешение, круг.
     *
     * Повторяет {@code Rule::permits}. Дублирование осознанное: ядру тело
     * сообщения непрозрачно, тип вложения виден только здесь.
     */
    private boolean permits(String key, String peer) {
        if (privacy == null || peer == null) return true;
        JSONObject rule = privacy.optJSONObject(key);
        if (rule == null) return true;
        if (contains(rule.optJSONArray("deny"), peer)) return false;
        if (contains(rule.optJSONArray("allow"), peer)) return true;

        JSONObject entry = directory.get(peer);
        String standing = entry == null ? "" : entry.optString("standing");
        switch (rule.optString("scope")) {
            case "everyone": return true;
            case "approved": return "contact".equals(standing) || "approved".equals(standing);
            case "contacts": return "contact".equals(standing);
            default: return false;
        }
    }

    private static String contentRule(String type) {
        switch (type) {
            case "image": return "media";
            case "voice": return "voice";
            case "file": return "files";
            default: return null;
        }
    }

    // --- юзернейм ----------------------------------------------------------------

    private void wireUsername() {
        findViewById(R.id.username_save).setOnClickListener(v -> {
            String name = ((EditText) findViewById(R.id.username_input)).getText().toString()
                    .trim().replaceFirst("^@", "");
            if (name.isEmpty()) {
                setUsernameStatus("Введите имя: латиница, цифры и подчёркивание, от 3 до 20 символов.");
                return;
            }
            boolean discoverable = privacy == null
                    || !"nobody".equals(privacy.optJSONObject("discoverable") == null ? ""
                        : privacy.optJSONObject("discoverable").optString("scope"));
            submit(Commands.usernameSet(name, discoverable));
        });
        findViewById(R.id.username_clear).setOnClickListener(v -> {
            if (username == null) setUsernameStatus("Юзернейм не занят.");
            else submit(Commands.usernameClear());
        });
        findViewById(R.id.username_copy).setOnClickListener(v -> {
            if (username == null) setUsernameStatus("Сначала займите имя.");
            else copyToClipboard("@" + username, "Юзернейм скопирован");
        });
    }

    /**
     * Значки: слово на проводе, глиф на экране.
     *
     * Сервер хранит короткое слово из закрытого списка, а не картинку, — иначе
     * рядом с чужим именем можно было бы показать что угодно. Незнакомое слово
     * не рисуется вовсе: у нового сервера список может быть длиннее.
     */
    private static final String[][] EMBLEMS = {
            {"none", "—"}, {"star", "★"}, {"moon", "☾"}, {"leaf", "❦"}, {"flame", "✦"},
            {"drop", "❉"}, {"bolt", "⚡"}, {"heart", "♥"}, {"anchor", "⚓"}, {"crown", "♛"},
            {"orbit", "◎"}, {"shield", "⛨"},
    };

    private static final String[][] PROFILE_COLORS = {
            {"none", "Без цвета", "#929292"},
            {"white", "Белый", "#F4F4F4"},
            {"blue", "Синий", "#70A8FF"},
            {"violet", "Фиолетовый", "#A98CFF"},
            {"green", "Зелёный", "#67D4A3"},
            {"coral", "Коралловый", "#ED8674"},
            {"amber", "Янтарный", "#E7B75F"},
            {"teal", "Бирюзовый", "#5FD0C7"},
            {"rose", "Розовый", "#EE8AB4"},
    };

    /**
     * Пустая строка вместо отсутствующего значения.
     *
     * {@code optString} на Android возвращает для JSON-null строку "null", а не
     * запасное значение: пустое поле профиля превращалось в слово «null», и
     * значок не показывался вовсе.
     */
    private static String optText(JSONObject event, String key) {
        return event.isNull(key) ? "" : event.optString(key, "");
    }

    static String emblemGlyph(String key) {
        if (key == null || key.isEmpty()) return "";
        for (String[] row : EMBLEMS) {
            if (row[0].equals(key)) return "none".equals(key) ? "" : row[1];
        }
        return "";
    }

    static int profileColor(String key) {
        if (key == null || key.isEmpty()) return 0;
        for (String[] row : PROFILE_COLORS) {
            if (row[0].equals(key)) return "none".equals(key) ? 0 : Color.parseColor(row[2]);
        }
        return 0;
    }

    private String colorLabel(String key) {
        for (String[] row : PROFILE_COLORS) {
            if (row[0].equals(key)) return row[1];
        }
        return getString(R.string.not_chosen);
    }

    private void chooseEmblem() {
        if (!decorSupported) {
            toast(getString(R.string.decor_unavailable));
            return;
        }
        String[] labels = new String[EMBLEMS.length];
        for (int i = 0; i < EMBLEMS.length; i++) {
            labels[i] = "none".equals(EMBLEMS[i][0])
                    ? getString(R.string.not_chosen) : EMBLEMS[i][1] + "   " + EMBLEMS[i][0];
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.emblem_label)
                .setItems(labels, (dialog, which) -> {
                    myEmblem = EMBLEMS[which][0];
                    submit(Commands.profileDecor(myEmblem, null));
                    renderOwnProfile();
                })
                .show();
    }

    private void chooseProfileColor() {
        if (!decorSupported) {
            toast(getString(R.string.decor_unavailable));
            return;
        }
        String[] labels = new String[PROFILE_COLORS.length];
        for (int i = 0; i < PROFILE_COLORS.length; i++) labels[i] = PROFILE_COLORS[i][1];
        new AlertDialog.Builder(this)
                .setTitle(R.string.profile_color_label)
                .setItems(labels, (dialog, which) -> {
                    myColor = PROFILE_COLORS[which][0];
                    submit(Commands.profileDecor(null, myColor));
                    renderOwnProfile();
                })
                .show();
    }

    private void showFingerprint() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.fingerprint_label)
                .setMessage(((TextView) findViewById(R.id.profile_fingerprint)).getText()
                        + "\n\n" + getString(R.string.fingerprint_hint))
                .setPositiveButton(R.string.ok, null)
                .show();
    }

    /** Шапка профиля: имя, значок, цвет — то, что видят собеседники. */
    private void renderOwnProfile() {
        TextView name = findViewById(R.id.profile_name);
        name.setText(username == null ? getString(R.string.username_free) : "@" + username);
        name.setTextColor(getColor(R.color.obsidian_white));
        // Свой аватар красится тем же цветом, что увидят собеседники.
        Profile own = profiles.get(myDeviceHex);
        if (own != null) {
            own.color = myColor;
            applyAvatar(profileAvatar, own, "ME");
        } else {
            profileAvatar.setBackground(avatarPlaceholder(profileColor(myColor)));
        }
        ((TextView) findViewById(R.id.profile_emblem)).setText(emblemGlyph(myEmblem));
        ((TextView) findViewById(R.id.open_username_value))
                .setText(username == null ? getString(R.string.not_chosen) : "@" + username);
        ((TextView) findViewById(R.id.open_emblem_value))
                .setText(myEmblem.isEmpty() || "none".equals(myEmblem)
                        ? getString(R.string.not_chosen) : emblemGlyph(myEmblem));
        ((TextView) findViewById(R.id.open_profile_color_value)).setText(colorLabel(myColor));
        ((TextView) findViewById(R.id.profile_chat_code_value))
                .setText(ownChatCode.isEmpty() ? "—" : ownChatCode);
    }

    // --- панель владельца ---------------------------------------------------------

    /** С какого места списка показан текущий разворот. */
    private int adminOffset;

    private void openAdmin() {
        open(screenAdmin);
        adminOffset = 0;
        submit(Commands.adminGet(0));
    }

    private void wireAdmin() {
        findViewById(R.id.admin_refresh)
                .setOnClickListener(v -> submit(Commands.adminGet(adminOffset)));
        findViewById(R.id.admin_users_prev).setOnClickListener(
                v -> submit(Commands.adminGet(Math.max(0, adminOffset - ADMIN_PAGE))));
        findViewById(R.id.admin_users_next).setOnClickListener(
                v -> submit(Commands.adminGet(adminOffset + ADMIN_PAGE)));
        findViewById(R.id.admin_do_block).setOnClickListener(v -> adminAction("block"));
        findViewById(R.id.admin_do_unblock).setOnClickListener(v -> adminAction("unblock"));
    }

    private void adminAction(String action) {
        String reference = ((EditText) findViewById(R.id.admin_reference)).getText().toString().trim();
        if (reference.isEmpty()) {
            setAdminStatus(getString(R.string.admin_reference_hint));
            return;
        }
        submit(Commands.adminAction(action, reference));
    }

    private void setAdminStatus(String text) {
        ((TextView) findViewById(R.id.admin_status)).setText(text);
    }

    /** Счётчики приходят набором: рисуем что дали, а не заранее известные поля. */
    private void onAdminReport(JSONObject event) {
        JSONObject report = event.optJSONObject("report");
        if (report == null) return;
        LinearLayout host = findViewById(R.id.admin_counts);
        host.removeAllViews();
        JSONObject counts = report.optJSONObject("counts");
        if (counts != null) {
            java.util.Iterator<String> keys = counts.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                host.addView(adminLine(adminLabel(key), counts.optString(key)));
            }
        }
        host.addView(adminLine(getString(R.string.admin_online), report.optString("online", "0")));
        renderAdminUsers(report);
        if (!report.isNull("done")) {
            setAdminStatus("block".equals(report.optString("done"))
                    ? getString(R.string.admin_entry_closed) : getString(R.string.admin_unblocked));
            ((EditText) findViewById(R.id.admin_reference)).setText("");
        }
    }

    /** Сколько аккаунтов в развороте. Должно совпадать с ADMIN_PAGE сервера. */
    private static final int ADMIN_PAGE = 40;

    private void renderAdminUsers(JSONObject report) {
        LinearLayout host = findViewById(R.id.admin_users);
        host.removeAllViews();
        adminOffset = report.optInt("offset", 0);
        JSONArray users = report.optJSONArray("users");
        if (users == null || users.length() == 0) {
            host.addView(adminLine(getString(R.string.admin_no_users), ""));
        }
        for (int i = 0; users != null && i < users.length(); i++) {
            JSONObject user = users.optJSONObject(i);
            if (user != null) host.addView(adminUserRow(user));
        }
        findViewById(R.id.admin_users_prev).setEnabled(adminOffset > 0);
        findViewById(R.id.admin_users_next).setEnabled(report.optBoolean("more"));
    }

    private View adminUserRow(JSONObject user) {
        boolean blocked = user.optBoolean("blocked");
        String identity = user.optString("identity");

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(9), 0, dp(9));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.setLayoutParams(new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView title = new TextView(this);
        // Код чата — то, чем владелец узнаёт человека: юзернейма у сервера нет.
        // Ключи приходят от сервера как есть: отчёт панели ядро не переписывает.
        title.setText(optText(user, "chatCode").isEmpty()
                ? shortHex(identity) : user.optString("chatCode"));
        title.setTextColor(getColor(blocked ? R.color.obsidian_danger : R.color.obsidian_white));
        title.setTextSize(13);

        TextView details = new TextView(this);
        long seen = user.optLong("lastSeen", 0);
        details.setText(getString(R.string.admin_user_line, user.optInt("devices"),
                seen > 0 ? java.text.DateFormat.getDateTimeInstance(
                        java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
                        .format(new java.util.Date(seen))
                        : getString(R.string.admin_never_seen)));
        details.setTextColor(getColor(R.color.obsidian_muted));
        details.setTextSize(10);
        copy.addView(title);
        copy.addView(details);
        row.addView(copy);

        Button action = new Button(this, null, 0, R.style.Obsidian_Button_Dark_Small);
        action.setText(blocked ? R.string.admin_open_entry : R.string.admin_close_entry);
        action.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle(blocked ? R.string.admin_open_entry : R.string.admin_close_entry)
                .setMessage(blocked ? R.string.admin_open_hint : R.string.admin_close_hint)
                .setPositiveButton(blocked ? R.string.admin_open_entry : R.string.admin_close_entry,
                        (dialog, which) -> submit(Commands.adminAction(
                                blocked ? "unblock" : "block", identity)))
                .setNegativeButton(R.string.cancel, null)
                .show());
        row.addView(action);
        return row;
    }

    private String adminLabel(String key) {
        switch (key) {
            case "users": return getString(R.string.admin_users);
            case "devices": return getString(R.string.admin_devices);
            case "profiles": return getString(R.string.admin_profiles);
            case "usernames": return getString(R.string.admin_usernames);
            case "recoveries": return getString(R.string.admin_recoveries);
            case "blocked": return getString(R.string.admin_blocked_count);
            case "queued": return getString(R.string.admin_queued);
            case "seenDay": return getString(R.string.admin_seen_day);
            default: return key;
        }
    }

    private View adminLine(String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(6), 0, dp(6));
        TextView left = new TextView(this);
        left.setText(label);
        left.setTextColor(getColor(R.color.obsidian_muted));
        left.setTextSize(12);
        left.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView right = new TextView(this);
        right.setText(value);
        right.setTextColor(getColor(R.color.obsidian_white));
        right.setTextSize(12);
        row.addView(left);
        row.addView(right);
        return row;
    }

    // --- чат и сообщения ----------------------------------------------------------

    private void wireChatSettings() {
        bindSwitch(R.id.chat_enter_sends, "enter_sends", false, checked -> applyEnterSends());
        bindSwitch(R.id.chat_confirm_delete, "confirm_delete", true, checked -> {});
        bindSwitch(R.id.chat_voice_autoplay, "voice_autoplay", false, checked -> {});
        applyEnterSends();
    }

    private void bindSwitch(int id, String key, boolean fallback,
            java.util.function.Consumer<Boolean> after) {
        Switch view = findViewById(id);
        view.setChecked(chatPreference(key, fallback));
        view.setOnCheckedChangeListener((button, checked) -> {
            appearancePreferences.edit().putBoolean(key, checked).apply();
            after.accept(checked);
        });
    }

    private boolean chatPreference(String key, boolean fallback) {
        return appearancePreferences == null ? fallback
                : appearancePreferences.getBoolean(key, fallback);
    }

    /** Enter либо отправляет, либо переносит строку — третьего у клавиатуры нет. */
    private void applyEnterSends() {
        boolean sends = chatPreference("enter_sends", false);
        composer.setImeOptions(sends ? android.view.inputmethod.EditorInfo.IME_ACTION_SEND
                : android.view.inputmethod.EditorInfo.IME_ACTION_NONE);
        composer.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                | (sends ? 0 : android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE));
        composer.setOnEditorActionListener(sends ? (view, actionId, event) -> {
            send();
            return true;
        } : null);
    }

    // --- данные -------------------------------------------------------------------

    private void wireData() {
        findViewById(R.id.data_clear_cache).setOnClickListener(v -> {
            long freed = clearDirectory(getCacheDir());
            renderDataSizes();
            toast(getString(R.string.data_freed, formatBytes(freed)));
        });
        findViewById(R.id.data_clear_chats).setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle(R.string.data_clear_chats)
                .setMessage(R.string.data_chats_hint)
                .setPositiveButton(R.string.data_clear_chats, (dialog, which) -> {
                    for (String conversation : conversations.values()) {
                        if (conversation != null && !conversation.isEmpty()) {
                            submit(Commands.deleteConversation(conversation));
                        }
                    }
                    conversations.clear();
                    pages.clear();
                    renderPeers();
                    renderDataSizes();
                })
                .setNegativeButton(R.string.cancel, null)
                .show());
    }

    private void renderDataSizes() {
        TextView view = findViewById(R.id.data_sizes);
        // SQLite в режиме WAL держит свежие записи в отдельном файле: без него
        // «база» показывала бы четыре килобайта при полной переписке.
        long database = databaseFile().length()
                + new File(getFilesDir(), "obsidian.db-wal").length()
                + new File(getFilesDir(), "obsidian.db-shm").length();
        long cache = directorySize(getCacheDir());
        view.setText(getString(R.string.data_sizes, formatBytes(database), formatBytes(cache),
                conversations.size()));
    }

    private long directorySize(File dir) {
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) return 0;
        long total = 0;
        for (File file : files) total += file.isDirectory() ? directorySize(file) : file.length();
        return total;
    }

    private long clearDirectory(File dir) {
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) return 0;
        long freed = 0;
        for (File file : files) {
            if (file.isDirectory()) {
                freed += clearDirectory(file);
                file.delete();
            } else {
                long size = file.length();
                if (file.delete()) freed += size;
            }
        }
        return freed;
    }

    private String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024f) + " KB";
        return String.format(Locale.ROOT, "%.1f MB", bytes / 1024f / 1024f);
    }

    private void setUsernameStatus(String text) {
        ((TextView) findViewById(R.id.username_status)).setText(text);
    }

    private void renderUsername() {
        ((EditText) findViewById(R.id.username_input)).setText(username == null ? "" : username);
        ((Button) findViewById(R.id.username_save))
                .setText(username == null ? R.string.username_take : R.string.username_change);
        findViewById(R.id.username_clear).setEnabled(username != null);
        findViewById(R.id.username_copy).setEnabled(username != null);
        setUsernameStatus(username == null ? "Не занят." : "Занят.");
        renderOwnProfile();
    }

    private void onUsernameFound(JSONObject event) {
        // Ответ на прошлый набор: пока летел, спросили уже о другом.
        if (lookupQuery != null && !lookupQuery.equals(event.optString("query"))) return;
        lookupMissed = event.isNull("device");
        lookupHit = lookupMissed ? null : event;
        renderPeers();
    }

    /** Найденный человек — такой же строкой, как и переписки. */
    private View searchHitRow(JSONObject event) {
        String device = event.optString("device");
        String handle = event.optString("query");
        profiles.put(device, new Profile(device, event.optString("chat_code"), handle,
                event.optString("avatar_mime"), event.optString("avatar_base64")));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        row.setBackgroundResource(R.drawable.panel_glass);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(66));
        rowParams.bottomMargin = dp(8);
        row.setLayoutParams(rowParams);

        TextView avatar = new TextView(this);
        avatar.setGravity(Gravity.CENTER);
        avatar.setTextColor(Color.WHITE);
        avatar.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
        applyAvatar(avatar, profiles.get(device), initials(device));
        row.addView(avatar);

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.setPadding(dp(12), 0, 0, 0);
        copy.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        TextView title = new TextView(this);
        title.setText("@" + handle);
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        TextView subtitle = new TextView(this);
        subtitle.setText(conversations.containsKey(device)
                ? getString(R.string.search_known) : getString(R.string.search_found));
        subtitle.setTextColor(getColor(R.color.obsidian_muted));
        subtitle.setTextSize(11);
        copy.addView(title);
        copy.addView(subtitle);
        row.addView(copy);

        row.setOnClickListener(v -> {
            if (!conversations.containsKey(device)) {
                submit(Commands.directorySet(device, "approved"));
                conversations.put(device, null);
            }
            clearSearch();
            selectPeer(device);
        });
        return row;
    }

    private void clearSearch() {
        if (lookupSoon != null) ui.removeCallbacks(lookupSoon);
        lookupQuery = null;
        lookupHit = null;
        lookupMissed = false;
        listFilter = "";
        newPeer.setText("");
    }

    // --- запросы ------------------------------------------------------------------

    private void wireListTabs() {
        findViewById(R.id.tab_chats).setOnClickListener(v -> showList(LIST_CHATS));
        findViewById(R.id.tab_requests).setOnClickListener(v -> showList(LIST_REQUESTS));
        findViewById(R.id.tab_channels).setOnClickListener(v -> {
            showList(LIST_CHANNELS);
            submit(Commands.channelList());
        });
        showList(LIST_CHATS);
    }

    private static final int LIST_CHATS = 0;
    private static final int LIST_REQUESTS = 1;
    private static final int LIST_CHANNELS = 2;

    private void showList(int list) {
        contactList.setVisibility(list == LIST_CHATS ? View.VISIBLE : View.GONE);
        requestList.setVisibility(list == LIST_REQUESTS ? View.VISIBLE : View.GONE);
        findViewById(R.id.channel_pane)
                .setVisibility(list == LIST_CHANNELS ? View.VISIBLE : View.GONE);
        markActive(findViewById(R.id.tab_chats), list == LIST_CHATS,
                R.drawable.chip_active, R.drawable.chip_idle);
        markActive(findViewById(R.id.tab_requests), list == LIST_REQUESTS,
                R.drawable.chip_active, R.drawable.chip_idle);
        markActive(findViewById(R.id.tab_channels), list == LIST_CHANNELS,
                R.drawable.chip_active, R.drawable.chip_idle);
    }

    // --- открытые каналы -----------------------------------------------------------

    private void askNewChannel() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(22), dp(8), dp(22), 0);

        EditText handle = new EditText(this);
        handle.setHint(R.string.channel_handle_hint);
        handle.setSingleLine(true);
        EditText title = new EditText(this);
        title.setHint(R.string.channel_title_hint);
        title.setSingleLine(true);
        box.addView(handle);
        box.addView(title);

        new AlertDialog.Builder(this)
                .setTitle(R.string.channel_create)
                // Предупреждение стоит до того, как человек нажал «Завести»:
                // после — оно уже оправдание, а не предупреждение.
                .setMessage(R.string.channel_create_warning)
                .setView(box)
                .setPositiveButton(R.string.channel_create, (dialog, which) -> {
                    String name = handle.getText().toString().trim()
                            .replaceAll("^@", "").toLowerCase(Locale.ROOT);
                    String caption = title.getText().toString().trim();
                    if (name.isEmpty() || caption.isEmpty()) return;
                    submit(Commands.channelCreate(name, caption, null));
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void askFindChannel() {
        EditText input = new EditText(this);
        input.setHint(R.string.channel_find_hint);
        input.setSingleLine(true);
        LinearLayout box = new LinearLayout(this);
        box.setPadding(dp(22), dp(8), dp(22), 0);
        box.addView(input);

        new AlertDialog.Builder(this)
                .setTitle(R.string.channel_find)
                .setView(box)
                .setPositiveButton(R.string.channel_find, (dialog, which) -> {
                    String name = input.getText().toString().trim();
                    if (!name.isEmpty()) submit(Commands.channelFind(name));
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void renderChannelList() {
        LinearLayout host = findViewById(R.id.channel_list);
        host.removeAllViews();
        if (channels.isEmpty()) {
            host.addView(listNotice(getString(R.string.channel_none)));
            return;
        }
        for (JSONObject channel : channels.values()) {
            host.addView(channelRow(channel));
        }
    }

    private View channelRow(JSONObject channel) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        row.setBackgroundResource(R.drawable.panel_glass);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(66));
        params.bottomMargin = dp(8);
        row.setLayoutParams(params);

        TextView mark = new TextView(this);
        mark.setText("◈");
        mark.setGravity(Gravity.CENTER);
        mark.setTextColor(getColor(R.color.obsidian_white));
        mark.setBackground(avatarPlaceholder());
        mark.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.setPadding(dp(12), 0, 0, 0);
        copy.setLayoutParams(new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        TextView title = new TextView(this);
        title.setText(channel.optString("title"));
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        TextView handle = new TextView(this);
        handle.setText("@" + channel.optString("handle")
                + (channel.optBoolean("owner") ? " · " + getString(R.string.channel_yours) : ""));
        handle.setTextColor(getColor(R.color.obsidian_muted));
        handle.setTextSize(11);
        copy.addView(title);
        copy.addView(handle);

        row.addView(mark);
        row.addView(copy);
        row.setOnClickListener(v -> openChannelFeed(channel.optString("id"), null));
        return row;
    }

    private void openChannelFeed(String id, Long before) {
        openChannel = id;
        if (before == null) channelOldest = null;
        submit(Commands.channelFeed(id, before));
    }

    private void renderChannel(JSONObject report) {
        JSONObject channel = report.optJSONObject("channel");
        if (channel == null) return;
        channels.put(channel.optString("id"), channel);
        openChannel = channel.optString("id");
        boolean owner = channel.optBoolean("owner");

        if (screenChannel.getVisibility() != View.VISIBLE) open(screenChannel);
        ((TextView) findViewById(R.id.channel_screen_title)).setText(channel.optString("title"));
        ((TextView) findViewById(R.id.channel_screen_handle)).setText("@"
                + channel.optString("handle")
                + (owner ? " · " + getString(R.string.channel_yours) : ""));
        findViewById(R.id.channel_composer).setVisibility(owner ? View.VISIBLE : View.GONE);

        Button subscribe = findViewById(R.id.channel_subscribe);
        subscribe.setVisibility(owner ? View.GONE : View.VISIBLE);
        subscribe.setText(channel.optBoolean("subscribed")
                ? R.string.channel_unsubscribe : R.string.channel_subscribe);

        LinearLayout feed = findViewById(R.id.channel_feed);
        JSONArray posts = report.optJSONArray("posts");
        if (channelOldest == null) feed.removeAllViews();
        if ((posts == null || posts.length() == 0) && feed.getChildCount() == 0) {
            feed.addView(listNotice(getString(owner
                    ? R.string.channel_empty_owner : R.string.channel_empty_reader)));
        }
        for (int i = 0; posts != null && i < posts.length(); i++) {
            JSONObject post = posts.optJSONObject(i);
            if (post == null) continue;
            feed.addView(postRow(post, owner));
            channelOldest = post.optLong("seq");
        }
        renderChannelList();
    }

    private View postRow(JSONObject post, boolean owner) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundResource(R.drawable.card_flat);
        row.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        row.setLayoutParams(params);

        TextView body = new TextView(this);
        body.setText(post.optString("body"));
        body.setTextColor(getColor(R.color.obsidian_white));
        body.setTextSize(14);

        TextView when = new TextView(this);
        when.setText(java.text.DateFormat.getDateTimeInstance(
                java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
                .format(new java.util.Date(post.optLong("createdAt"))));
        when.setTextColor(getColor(R.color.obsidian_muted));
        when.setTextSize(10);
        LinearLayout.LayoutParams whenParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        whenParams.topMargin = dp(6);
        when.setLayoutParams(whenParams);

        row.addView(body);
        row.addView(when);
        if (owner) {
            row.setOnLongClickListener(v -> {
                new AlertDialog.Builder(this)
                        .setTitle(R.string.channel_drop_post)
                        .setMessage(R.string.channel_drop_hint)
                        .setPositiveButton(R.string.delete, (dialog, which) ->
                                submit(Commands.channelDeletePost(openChannel, post.optString("id"))))
                        .setNegativeButton(R.string.cancel, null)
                        .show();
                return true;
            });
        }
        return row;
    }

    private void toggleSubscription() {
        JSONObject channel = channels.get(openChannel);
        if (channel == null) return;
        submit(Commands.channelSubscribe(openChannel, !channel.optBoolean("subscribed")));
    }

    private void publishPost() {
        EditText input = findViewById(R.id.channel_text);
        String text = input.getText().toString().trim();
        if (text.isEmpty() || openChannel == null) return;
        input.setText("");
        submit(Commands.channelPublish(openChannel, text));
    }

    /** Ответ по каналам: список, лента, найденный канал — что спросили. */
    private void onChannels(JSONObject event) {
        JSONObject report = event.optJSONObject("report");
        if (report == null) return;

        JSONArray list = report.optJSONArray("channels");
        if (list != null) {
            channels.clear();
            for (int i = 0; i < list.length(); i++) {
                JSONObject channel = list.optJSONObject(i);
                if (channel != null) channels.put(channel.optString("id"), channel);
            }
            renderChannelList();
        }
        if (report.has("found")) {
            JSONObject found = report.optJSONObject("found");
            if (found == null) {
                toast(getString(R.string.channel_not_found));
            } else {
                channels.put(found.optString("id"), found);
                renderChannelList();
                openChannelFeed(found.optString("id"), null);
            }
        }
        JSONObject opened = report.optJSONObject("opened");
        if (opened != null) openChannelFeed(opened.optString("id"), null);
        if (report.optJSONObject("channel") != null && report.optJSONArray("posts") != null) {
            renderChannel(report);
        }
        // Опубликованное и убранное показываем перечитыванием ленты: на экране
        // должно быть то, что лежит на сервере, а не то, что мы надеемся увидеть.
        if (report.optJSONObject("published") != null || report.has("removed")) {
            channelOldest = null;
            openChannelFeed(report.optString("channel", openChannel), null);
        }
    }

    private void onChannelPost(JSONObject event) {
        JSONObject report = event.optJSONObject("report");
        if (report == null) return;
        String channel = report.optString("channel");
        if (channel.equals(openChannel) && screenChannel.getVisibility() == View.VISIBLE) {
            channelOldest = null;
            openChannelFeed(channel, null);
            return;
        }
        toast("@" + report.optString("handle") + ": новый пост");
    }

    private void renderRequests() {
        requestList.removeAllViews();
        int pending = 0;
        for (Map.Entry<String, JSONObject> entry : directory.entrySet()) {
            if (!"pending".equals(entry.getValue().optString("standing"))) continue;
            pending++;
            requestList.addView(requestCard(entry.getKey(), entry.getValue()));
        }
        ((Button) findViewById(R.id.tab_requests)).setText(
                pending == 0 ? getString(R.string.requests_label)
                             : getString(R.string.requests_label) + " · " + pending);
        if (pending == 0) {
            TextView empty = new TextView(this);
            empty.setText(R.string.requests_none);
            empty.setTextColor(getColor(R.color.obsidian_dim));
            empty.setTextSize(11);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, dp(18), 0, dp(18));
            requestList.addView(empty);
        }
        renderPeers();
    }

    private View requestCard(String device, JSONObject entry) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.panel_glass);
        card.setPadding(dp(13), dp(12), dp(13), dp(12));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.bottomMargin = dp(7);
        card.setLayoutParams(cardParams);

        TextView name = new TextView(this);
        name.setText(entry.isNull("display_name") ? displayName(device) : entry.optString("display_name"));
        name.setTextColor(getColor(R.color.obsidian_white));
        name.setTextSize(13);
        card.addView(name);

        TextView who = new TextView(this);
        who.setText(entry.isNull("username") ? shortHex(device) : "@" + entry.optString("username"));
        who.setTextColor(getColor(R.color.obsidian_muted));
        who.setTextSize(10);
        card.addView(who);

        if (!entry.isNull("origin")) {
            TextView origin = new TextView(this);
            origin.setText(entry.optString("origin"));
            origin.setTextColor(getColor(R.color.obsidian_dim));
            origin.setTextSize(10);
            LinearLayout.LayoutParams originParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            originParams.topMargin = dp(6);
            origin.setLayoutParams(originParams);
            card.addView(origin);
        }

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(38));
        actionParams.topMargin = dp(9);
        actions.setLayoutParams(actionParams);

        actions.addView(requestButton(R.string.accept, 0, () -> {
            submit(Commands.directorySet(device, "approved"));
            selectPeer(device);
        }));
        actions.addView(requestButton(R.string.decline, dp(5),
                () -> submit(Commands.directoryForget(device))));
        actions.addView(requestButton(R.string.block, dp(5),
                () -> submit(Commands.directorySet(device, "blocked"))));
        card.addView(actions);
        return card;
    }

    private Button requestButton(int caption, int leftMargin, Runnable action) {
        Button button = new Button(this, null, 0, R.style.Obsidian_Segment);
        button.setText(caption);
        LinearLayout.LayoutParams params =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
        params.leftMargin = leftMargin;
        button.setLayoutParams(params);
        button.setOnClickListener(v -> action.run());
        return button;
    }

    // --- приглашения ----------------------------------------------------------------

    private void showInvites() {
        JSONArray invites = access == null ? null : access.optJSONArray("invites");
        int count = invites == null ? 0 : invites.length();

        CharSequence[] items = new CharSequence[count + 1];
        items[0] = getString(R.string.invite_create);
        for (int i = 0; i < count; i++) {
            JSONObject invite = invites.optJSONObject(i);
            String label = invite.isNull("label") ? "Без заметки" : invite.optString("label");
            items[i + 1] = label + (invite.optBoolean("one_time") ? " · одноразовая" : " · многоразовая");
        }

        new AlertDialog.Builder(this)
                .setTitle(R.string.invites_open)
                .setItems(items, (dialog, which) -> {
                    if (which == 0) {
                        submit(Commands.passInvite("", true, 86400));
                        toast("Ссылка создана — откройте список ещё раз");
                        return;
                    }
                    JSONObject invite = invites.optJSONObject(which - 1);
                    showInvite(invite);
                })
                .setNegativeButton("Закрыть", null)
                .show();
    }

    private void showInvite(JSONObject invite) {
        String link = "obsidian://invite/" + invite.optString("pass");
        new AlertDialog.Builder(this)
                .setTitle(R.string.invites_open)
                .setMessage(link)
                .setPositiveButton(R.string.copy, (dialog, which) -> copyToClipboard(link, "Ссылка скопирована"))
                .setNegativeButton(R.string.invite_revoke,
                        (dialog, which) -> submit(Commands.passRevoke(invite.optString("hash"))))
                .show();
    }
}

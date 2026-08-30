/*
  Адреса onion-входов здесь нет намеренно.

  Их несколько, они меняются вместе с узлами, и сервер называет их сам в HELLO.
  Окно просит режим — «через Tor», — а какой именно вход открыт сегодня, решает
  ядро: см. `routes_for` в client.rs. С зашитым сюда адресом смена узла или его
  потеря требовали бы новой сборки для всех.
*/
const SERVER_URLS = Object.freeze({
  auto: "obsidian://auto",
  basic: "wss://getobsidian.xyz/ws",
  multihop: "wss://getobsidian.xyz/multihop/ws",
  onion: "obsidian://onion",
});

function serverUrl() {
  return SERVER_URLS[preferences.transport] || SERVER_URLS.basic;
}
// Версия не хранится здесь копией: её отдаёт ядро приложения (Cargo.toml).
// Хардкод в окне уже расходился с собранным бинарём, и клиент вечно
// предлагал обновиться на версию, которая на нём и стояла.
let appVersion = "…";
const RELEASES_URL = "https://getobsidian.xyz/v1/releases/latest";
const { invoke } = window.__TAURI__.core;

/**
 * Кнопки окна.
 *
 * Своими командами приложения, а не через глобальный объект окна: набор
 * пространств имён в withGlobalTauri собирается по фичам сборки, и кнопки,
 * понадеявшиеся на него, молча не работали. В браузерном стенде команды просто
 * отвечают ошибкой, и это лучше, чем падение при загрузке.
 */
function windowCommand(name, args) {
  // Ошибку показываем, а не глотаем: кнопка, которая молча не работает, —
  // ровно то, с чего этот код начался.
  invoke(name, args).catch((error) => toast(`Окно: ${error}`));
}
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const CONTENT_PREFIX = "\u2063OBS1:";

const state = {
  device: "",
  identity: "",
  fingerprint: "",
  chatCode: "",
  profilesSupported: false,
  profiles: new Map(),
  pendingChatCode: null,
  conversations: new Map(),
  /** Группы и каналы: идентификатор группы -> описание и состав. */
  groups: new Map(),
  current: null,
  /** Кого зовём в группу, пока ищем его устройство по коду или имени. */
  pendingGroupInvite: null,
  /** Действие, ожидающее долговечной записи нового закреплённого ключа. */
  pendingPinAction: null,
  pendingPeer: null,
  readIds: new Set(),
  sentReadIds: new Set(),
  recoveryCode: "",
  recoveryWords: "",
  username: null,
  recorder: null,
  lastDisconnectReason: "",
  pendingRecoverySetup: null,
  registrationPending: false,
};
/** Локальная адресная книга участвует и в выборе отображаемого имени. */
const directory = new Map();

/** Сколько сообщений показывать при первом открытии чата. */
const PAGE_SIZE = 40;

/**
 * Переписка, уже поднятая из базы, — на время сессии.
 *
 * Ключ — идентификатор беседы, значение — `{ items, oldest, hasMore, loading,
 * scrollTop }`, где каждый `item` несёт готовый `<li>`. Благодаря этому
 * повторное открытие чата не стоит ничего: ни обращения к ядру, ни
 * расшифровки, ни повторного разбора base64 у фото и голосовых — а именно они
 * и делали переключение чатов заметно медленным.
 *
 * Только в памяти и намеренно: расшифрованный текст в localStorage пережил бы
 * закрытие приложения и обошёл бы весь смысл запечатанной базы.
 */
const history = new Map();

function chat(conversation) {
  let entry = history.get(conversation);
  if (!entry) {
    entry = { items: [], oldest: null, hasMore: true, loading: false, loaded: false, scrollTop: null };
    history.set(conversation, entry);
  }
  return entry;
}

/**
 * Открытая беседа обозначается одним ключом: для диалога это адрес устройства,
 * для группы — «g:» и её идентификатор. Так весь остальной код (история,
 * прокрутка, ответы) работает с группами без переделки.
 */
const GROUP_PREFIX = "g:";
const isGroupKey = (key) => typeof key === "string" && key.startsWith(GROUP_PREFIX);
const groupIdOf = (key) => (isGroupKey(key) ? key.slice(GROUP_PREFIX.length) : null);
const groupKey = (id) => GROUP_PREFIX + id;
const currentGroup = () => (isGroupKey(state.current) ? state.groups.get(groupIdOf(state.current)) : null);

function conversationOf(peer) {
  if (isGroupKey(peer)) return groupIdOf(peer);
  return state.conversations.get(peer)?.conversation ?? null;
}

function logicalId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function encodeContent(content) {
  return CONTENT_PREFIX + JSON.stringify({ v: 1, ...content });
}

function parseContent(body) {
  if (!body?.startsWith(CONTENT_PREFIX)) return { type: "text", text: body ?? "" };
  try { return JSON.parse(body.slice(CONTENT_PREFIX.length)); } catch { return { type: "text", text: body }; }
}

function applyRead(ids) {
  for (const id of ids ?? []) {
    state.readIds.add(id);
    document.querySelectorAll(`[data-message-id="${CSS.escape(id)}"]`).forEach((node) => {
      node.classList.add("read");
      const status = node.querySelector(".delivery");
      if (status) status.textContent = "✓✓ прочитано";
    });
  }
}

function sendRead(peer, ids) {
  const unique = [...new Set(ids.filter((id) => id && !state.sentReadIds.has(id)))];
  if (peer && unique.length) {
    unique.forEach((id) => state.sentReadIds.add(id));
    submit({ type: "send", recipient_device: peer, body: encodeContent({ type: "read", ids: unique }) });
  }
}

function showScreen(screen) {
  for (const id of [
    "screen-boot", "screen-locked", "screen-migrate", "screen-language",
    "screen-route", "screen-entry", "screen-recover", "screen-backup", "screen-main",
  ]) {
    $(id).classList.toggle("hidden", id !== screen);
  }
}

function showBoot(text) {
  $("boot-status").textContent = text;
  showScreen("screen-boot");
}

async function submit(command) {
  try {
    await invoke("submit", { json: JSON.stringify(command) });
    return true;
  } catch (error) {
    toast(String(error));
    return false;
  }
}

function toast(text) {
  const node = $("log");
  node.textContent = text;
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("visible"), 5000);
}

function notificationText(content) {
  if (content.type === "text") return content.text || "Новое сообщение";
  if (content.type === "image") return content.caption ? `Фото · ${content.caption}` : "Отправлено фото";
  if (content.type === "voice") return "Голосовое сообщение";
  return "Новое сообщение";
}

function showDesktopNotification({ title, text, device = null, avatarOf = null }) {
  // Аватар — того, кто написал; беседа по щелчку — та, где он написал. В
  // группе это разные вещи.
  const face = avatarOf ?? device;
  const profile = face ? profileFor(face) : null;
  // Звук играет сама карточка, а не это окно: уведомление — это она, и звучать
  // должно ровно то, что показалось. Окно приложения при этом может быть
  // свёрнуто или закрыто на другой рабочий стол.
  invoke("show_desktop_notification", {
    payload: {
      title,
      text,
      initials: face ? initials(face) : "O",
      avatarMime: profile?.avatar_mime ?? null,
      avatarBase64: profile?.avatar_base64 ?? null,
      // Кому принадлежит уведомление: по щелчку карточка откроет эту беседу.
      device,
      color: preferences?.notificationColor ?? "graphite",
      size: preferences?.notificationSize ?? 85,
      position: preferences?.notificationPosition ?? "top",
      sound: preferences?.notificationSound ?? true,
      // Карточка — строка беседы, вынесенная на рабочий стол, поэтому берёт
      // оформление из тех же настроек, что и список бесед.
      theme: preferences?.theme ?? "dark",
      accent: preferences?.accent ?? "#7b2cff",
      radius: preferences?.radius ?? 13,
      squareAvatars: preferences?.squareAvatars ?? false,
    },
  }).catch((error) => toast(`Уведомление: ${error}`));
}

/**
 * Состояние связи.
 *
 * Постоянной строчки «в сети» в интерфейсе больше нет: она занимала место в
 * шапке и почти всегда сообщала то, что и так очевидно — сообщения ходят.
 * Показываем только то, что требует внимания: обрыв и возвращение связи, и
 * только уведомлением, которое само уходит через пять секунд.
 */
let connectionKind = "offline";

function setConnection(kind, text) {
  const was = connectionKind;
  connectionKind = kind;
  if (kind === "offline" && was !== "offline") toast(`Связь потеряна: ${text}`);
  // О возвращении говорим только тем, кто видел обрыв: при первом входе
  // «связь восстановлена» сообщало бы о том, чего не случалось.
  if (kind === "online" && was === "offline") toast("Связь восстановлена");
}

function short(hex) {
  if (!hex || hex.length < 16) return hex || "—";
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

function initials(hex) {
  return (hex || "--").slice(0, 2).toUpperCase();
}

function copyText(text, success) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(
    () => toast(success),
    () => toast("Не удалось скопировать"),
  );
}

// --- автоматический вход ------------------------------------------------------

$("form-migrate").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter ?? event.currentTarget.querySelector("button[type='submit']");
  $("migration-error").textContent = "";
  button.disabled = true;
  try {
    await invoke("unlock_existing", { password: $("migration-password").value });
    $("migration-password").value = "";
    showBoot("Восстанавливаем защищённый сеанс…");
    await submit({ type: "status" });
  } catch (error) {
    $("migration-error").textContent = String(error);
  } finally {
    button.disabled = false;
  }
});

$("reset-legacy").addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Создать новую базу? Старый аккаунт и переписка исчезнут из приложения. "
      + "Исходные файлы останутся в резервной папке.",
  );
  if (!confirmed) return;

  const button = $("reset-legacy");
  $("migration-error").textContent = "";
  button.disabled = true;
  try {
    await invoke("reset_legacy_database");
    $("migration-password").value = "";
    showBoot("Создаём новую защищённую базу…");
    await submit({ type: "status" });
  } catch (error) {
    $("migration-error").textContent = String(error);
  } finally {
    button.disabled = false;
  }
});

const ONBOARDING_LANGUAGE = "obsidian.onboarding.language";
const ONBOARDING_COMPLETE = "obsidian.onboarding.complete";
let onboardingLanguage = localStorage.getItem(ONBOARDING_LANGUAGE)
  || (navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en");
let chosenTransport = "auto";

const onboardingCopy = {
  ru: {
    introTitle: "obsidian",
    introParts: [
      "Obsidian — приватный мессенджер с надёжным сквозным шифрованием.",
      "Сообщения шифруются на вашем устройстве. Главный сервер скрыт за relay-инфраструктурой, а маршрут можно выбрать между Relay, Multihop и Tor.",
      "Приватность заложена в архитектуру. Открытый код. Номер телефона не нужен.",
    ],
    start: "Проведите, чтобы начать", next: "Продолжить", routeText: "Выберите, как приложение будет соединяться с сетью. Настройку всегда можно изменить позже.",
    relay: "Быстрое прямое соединение", multi: "Дополнительный промежуточный узел", tor: "Максимальная сетевая приватность",
    entryTitle: "Начните с Obsidian", entryLead: "Имя увидят собеседники. Пароль нужен для запасного входа с другого устройства.",
    routeTitle: "сервер Obsidian", back: "Назад", relayTitle: "Relay (автоматически)",
    username: "Имя пользователя", usernamePlaceholder: "username", recoveryPassword: "Пароль восстановления", passwordPlaceholder: "Минимум 10 символов",
    register: "Зарегистрироваться", signIn: "← Вернуться ко входу", recoverWords: "Восстановить по 24 словам", skip: "Skip — продолжить без логина и пароля",
    recoveryTitle: "Recovery phrase", recoveryLead: "Введите 24 слова в том же порядке. За один шаг показываются восемь слов.",
    login: "Логин", password: "Пароль", loginAction: "Войти", backToRegister: "Назад к регистрации",
    backupTitle: "Запишите фразу", backupLead: "Двадцать четыре слова — это и есть ваш аккаунт. Перепишите их на бумагу и храните отдельно от компьютера. Не сохраняйте фразу в переписке, скриншотах или облаке.",
    revealWords: "Показать 24 слова", copy: "Скопировать", showCode: "Показать кодом", enterChats: "Перейти в чаты", previous: "Назад", forward: "Далее", restore: "Восстановить",
    confirmPhrase: "Я переписал(а) фразу на бумагу и понимаю, что второй раз её не покажут", security: "Фраза и пароль никогда не передаются с устройства в открытом виде.",
  },
  en: {
    introTitle: "obsidian",
    introParts: [
      "Obsidian is a private messenger with reliable end-to-end encryption.",
      "Messages are encrypted on your device. The main server stays behind relay infrastructure, with Relay, Multihop and Tor routing.",
      "Privacy by design. Open source. No phone number required.",
    ],
    start: "Slide to start", next: "Continue", routeText: "Choose how the app connects to the network. You can change this later.",
    relay: "Fast direct connection", multi: "An additional intermediate relay", tor: "Maximum network privacy",
    entryTitle: "Get started with Obsidian", entryLead: "Your contacts see the username. The password enables recovery on another device.",
    routeTitle: "Obsidian server", back: "Back", relayTitle: "Relay (automatic)",
    username: "Username", usernamePlaceholder: "username", recoveryPassword: "Recovery password", passwordPlaceholder: "At least 10 characters",
    register: "Create account", signIn: "← Return to sign in", recoverWords: "Recover with 24 words", skip: "Skip — continue without login and password",
    recoveryTitle: "Recovery phrase", recoveryLead: "Enter all 24 words in the original order. Eight words are shown per step.",
    login: "Login", password: "Password", loginAction: "Sign in", backToRegister: "Back to registration",
    backupTitle: "Write down the phrase", backupLead: "These twenty-four words are your account. Write them on paper and keep them away from the computer. Do not store them in chats, screenshots or cloud storage.",
    revealWords: "Show 24 words", copy: "Copy", showCode: "Show as code", enterChats: "Open chats", previous: "Back", forward: "Next", restore: "Restore",
    confirmPhrase: "I wrote the phrase down on paper and understand it will not be shown a second time", security: "The phrase and password never leave your device unencrypted.",
  },
};

function applyOnboardingLanguage() {
  const copy = onboardingCopy[onboardingLanguage];
  document.documentElement.lang = onboardingLanguage;
  $("intro-title").innerHTML = copy.introTitle;
  document.querySelectorAll("[data-intro-part]").forEach((part, index) => {
    part.textContent = copy.introParts[index] || "";
  });
  $("intro-next-label").textContent = copy.start;
  $("route-next-label").textContent = copy.next;
  $("route-text").textContent = copy.routeText;
  $("route-relay-text").textContent = copy.relay;
  $("route-multi-text").textContent = copy.multi;
  $("route-tor-text").textContent = copy.tor;
  $("entry-title").textContent = copy.entryTitle;
  $("entry-lead").textContent = copy.entryLead;
  $("route-title").textContent = copy.routeTitle;
  $("route-back-label").textContent = copy.back;
  $("entry-back-label").textContent = copy.back;
  $("route-relay-title").textContent = copy.relayTitle;
  $("handle-label").textContent = copy.username;
  $("handle").placeholder = copy.usernamePlaceholder;
  $("entry-password-label").textContent = copy.recoveryPassword;
  $("entry-password").placeholder = copy.passwordPlaceholder;
  $("entry-submit").textContent = copy.register;
  $("open-password-recover").textContent = copy.signIn;
  $("open-recover").textContent = copy.recoverWords;
  $("skip-registration").textContent = copy.skip;
  $("recover-title").textContent = copy.recoveryTitle;
  $("recover-lead").textContent = copy.recoveryLead;
  document.querySelector('label[for="recover-login"]').textContent = copy.login;
  document.querySelector('label[for="recover-password"]').textContent = copy.password;
  $("form-recover-password").querySelector("button").textContent = copy.loginAction;
  $("recover-back").querySelector("span").textContent = copy.backToRegister;
  $("backup-title").textContent = copy.backupTitle;
  $("backup-lead").textContent = copy.backupLead;
  $("backup-words-reveal").textContent = copy.revealWords;
  $("backup-words-copy").textContent = copy.copy;
  $("backup-words-code").textContent = copy.showCode;
  $("backup-next").textContent = copy.enterChats;
  $("backup-written").nextElementSibling.textContent = copy.confirmPhrase;
  $("screen-backup").querySelector(".security-note span:last-child").textContent = copy.security;
  $("recover-prev").querySelector("span").textContent = copy.previous;
  $("recover-next").querySelector("span").textContent = copy.forward;
  $("recover-submit").textContent = `${copy.restore} →`;
  for (const button of document.querySelectorAll("[data-language]")) {
    button.classList.toggle("active", button.dataset.language === onboardingLanguage);
  }
}

for (const button of document.querySelectorAll("[data-language]")) {
  button.addEventListener("click", () => {
    onboardingLanguage = button.dataset.language;
    localStorage.setItem(ONBOARDING_LANGUAGE, onboardingLanguage);
    applyOnboardingLanguage();
  });
}
const landing = $("onboarding-landing");
let landingMotionFrame = 0;
landing.addEventListener("scroll", () => {
  if (landingMotionFrame) return;
  landingMotionFrame = requestAnimationFrame(() => {
    const progress = Math.max(0, Math.min(1, landing.scrollTop / Math.max(1, landing.clientHeight)));
    document.documentElement.style.setProperty("--welcome-phone-shift", `${(0.5 - progress) * 46}px`);
    document.documentElement.style.setProperty("--welcome-copy-shift", `${(1 - progress) * 18}px`);
    landingMotionFrame = 0;
  });
}, { passive: true });

document.querySelector(".landing-scroll-hint").addEventListener("click", () => {
  $("landing-about").scrollIntoView({ behavior: "smooth", block: "start" });
});
const landingObserver = new IntersectionObserver(([entry]) => {
  $("landing-about").classList.toggle("is-visible", entry.isIntersecting);
}, { root: $("onboarding-landing"), threshold: 0.22 });
landingObserver.observe($("landing-about"));

const startSlider = $("intro-next");
let startSliderDragging = false;
let startSliderProgress = 0;

function paintStartSlider(progress) {
  startSliderProgress = Math.max(0, Math.min(1, progress));
  startSlider.style.setProperty("--slide-progress", startSliderProgress);
  startSlider.style.setProperty("--slide-x", `${Math.max(0, startSlider.clientWidth - 58) * startSliderProgress}px`);
  startSlider.setAttribute("aria-valuenow", String(Math.round(startSliderProgress * 100)));
}

function moveStartSlider(clientX) {
  const bounds = startSlider.getBoundingClientRect();
  const thumb = 50;
  paintStartSlider((clientX - bounds.left - thumb / 2) / Math.max(1, bounds.width - thumb));
}

startSlider.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".onboarding-slider-thumb")) return;
  event.preventDefault();
  startSliderDragging = true;
  startSlider.setPointerCapture(event.pointerId);
  startSlider.classList.add("dragging");
  moveStartSlider(event.clientX);
});
startSlider.addEventListener("pointermove", (event) => {
  if (startSliderDragging) moveStartSlider(event.clientX);
});
startSlider.addEventListener("pointerup", (event) => {
  if (!startSliderDragging) return;
  startSliderDragging = false;
  startSlider.releasePointerCapture(event.pointerId);
  startSlider.classList.remove("dragging");
  if (startSliderProgress >= 0.82) {
    paintStartSlider(1);
    setTimeout(() => { paintStartSlider(0); showScreen("screen-route"); }, 120);
  } else {
    paintStartSlider(0);
  }
});
startSlider.addEventListener("pointercancel", () => {
  startSliderDragging = false;
  startSlider.classList.remove("dragging");
  paintStartSlider(0);
});
startSlider.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    paintStartSlider(1);
    setTimeout(() => { paintStartSlider(0); showScreen("screen-route"); }, 120);
  }
});

$("route-back").addEventListener("click", () => {
  showScreen("screen-language");
  requestAnimationFrame(() => {
    landing.scrollTop = $("landing-about").offsetTop;
  });
});
$("entry-back").addEventListener("click", () => showScreen("screen-route"));
for (const option of document.querySelectorAll(".route-option")) {
  option.addEventListener("click", () => {
    chosenTransport = option.dataset.transport;
    for (const other of document.querySelectorAll(".route-option")) other.classList.toggle("active", other === option);
  });
}

function initOnboardingShader(canvas) {
  const gl = canvas?.getContext("webgl", { alpha: false, antialias: false })
    || canvas?.getContext("experimental-webgl", { alpha: false, antialias: false });
  if (!gl) {
    canvas?.classList.add("shader-unavailable");
    return;
  }

  const vertexSource = `
    attribute vec2 a_position;
    void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
  `;
  const fragmentSource = `
    precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec3 u_accent;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.05; a *= 0.5; }
      return v;
    }
    float ribbon(vec2 p, float yOffset, float freq, float amp, float speed, float widthBase, float phase) {
      float centerY = yOffset + sin(p.x * freq + u_time * speed + phase) * amp
        + fbm(vec2(p.x * 1.3 + u_time * speed * 0.5, phase)) * amp * 0.35;
      float width = widthBase + 0.02 * sin(p.x * 3.0 + u_time * 0.4 + phase);
      float d = abs(p.y - centerY);
      return smoothstep(width, width * 0.15, d) + smoothstep(width * 3.0, 0.0, d) * 0.3;
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / u_resolution.xy;
      vec2 p = uv;
      float aspect = u_resolution.x / u_resolution.y;
      p.x *= aspect;
      float t = u_time * 0.06;
      vec2 flowUv = p * 1.4 + vec2(t * 0.5, -t * 0.3);
      float clouds = fbm(flowUv + fbm(flowUv * 1.6 + t));
      float glow = smoothstep(1.6, 0.0, length((p - vec2(aspect * 1.15, -0.2)) * vec2(1.0, 1.1)));
      float vertical = smoothstep(1.05, -0.35, uv.y);
      float lum = clamp(vertical * 0.5 + glow * 0.45 + clouds * 0.3, 0.0, 1.3);
      vec3 colDark = u_accent * 0.025;
      vec3 colMid = u_accent * 0.48;
      vec3 colHot = mix(u_accent, vec3(1.0), 0.28);
      vec3 color = mix(colDark, colMid, smoothstep(0.0, 0.75, lum));
      color = mix(color, colHot, smoothstep(0.75, 1.2, lum));
      float r1 = ribbon(p, 0.62, 1.4, 0.10, 0.35, 0.030, 0.0);
      float r2 = ribbon(p, 0.45, 1.1, 0.14, -0.28, 0.022, 2.1);
      color += mix(u_accent, vec3(1.0), 0.55) * r1 * 0.9 + u_accent * r2 * 0.9;
      color += (hash(gl_FragCoord.xy) - 0.5) * 0.055;
      float vig = smoothstep(1.2, 0.3, length(uv - 0.5) * 1.3);
      color *= mix(0.82, 1.0, vig);
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const resolution = gl.getUniformLocation(program, "u_resolution");
  const time = gl.getUniformLocation(program, "u_time");
  const accent = gl.getUniformLocation(program, "u_accent");
  const started = performance.now();

  function accentRgb() {
    let value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7b2cff";
    if (/^#[0-9a-f]{3}$/i.test(value)) value = `#${value.slice(1).split("").map((part) => part + part).join("")}`;
    if (!/^#[0-9a-f]{6}$/i.test(value)) value = "#7b2cff";
    return [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255);
  }

  function render(now) {
    if (canvas.closest(".screen")?.classList.contains("hidden")) {
      requestAnimationFrame(render);
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const density = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(bounds.width * density));
    const height = Math.max(1, Math.round(bounds.height * density));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    const color = accentRgb();
    gl.uniform2f(resolution, width, height);
    gl.uniform1f(time, (now - started) / 1000);
    gl.uniform3f(accent, color[0], color[1], color[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

document.querySelectorAll(".onboarding-shader").forEach(initOnboardingShader);
$("route-next").addEventListener("click", () => {
  preferences.transport = chosenTransport;
  savePreferences();
  localStorage.setItem(ONBOARDING_COMPLETE, "1");
  showScreen("screen-entry");
});
applyOnboardingLanguage();

$("form-entry").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("entry-submit");
  const handle = $("handle").value.trim();
  const password = $("entry-password").value;
  $("entry-error").textContent = "";
  if (handle && !/^[a-z0-9_]{3,20}$/i.test(handle)) {
    $("entry-error").textContent = "Имя: 3–20 символов, латиница, цифры и _";
    return;
  }
  if (password && password.length < 10) {
    $("entry-error").textContent = "Пароль должен содержать минимум 10 символов";
    return;
  }
  if (password && !handle) {
    $("entry-error").textContent = "Для запасного входа укажите имя пользователя";
    return;
  }
  state.pendingRecoverySetup = password ? { login: handle, password } : null;
  state.registrationPending = true;
  button.disabled = true;
  button.textContent = "Подключаем…";
  const accepted = await submit({ type: "register", url: serverUrl(), handle: handle || null, invite: null });
  if (!accepted) {
    state.pendingRecoverySetup = null;
    state.registrationPending = false;
    button.disabled = false;
    button.textContent = "Зарегистрироваться";
  }
});

$("skip-registration").addEventListener("click", () => {
  $("handle").value = "";
  $("entry-password").value = "";
  $("form-entry").requestSubmit();
});

// --- восстановление доступа ---------------------------------------------------

const recoveryWords = Array(24).fill("");
let recoveryPage = 0;

function storeRecoveryPage() {
  document.querySelectorAll("[data-recovery-word]").forEach((input, index) => {
    recoveryWords[recoveryPage * 8 + index] = input.value.trim();
  });
}

function renderRecoveryPage() {
  const grid = $("recovery-word-grid");
  grid.replaceChildren();
  for (let index = 0; index < 8; index += 1) {
    const number = recoveryPage * 8 + index + 1;
    const label = document.createElement("label");
    const marker = document.createElement("span");
    marker.textContent = String(number);
    const input = document.createElement("input");
    input.dataset.recoveryWord = String(index);
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = recoveryWords[number - 1];
    label.append(marker, input);
    grid.append(label);
  }
  $("recover-page-label").textContent = `Слова ${recoveryPage * 8 + 1}–${recoveryPage * 8 + 8} из 24`;
  $("recover-progress-bar").style.width = `${(recoveryPage + 1) * 33.333}%`;
  $("recover-prev").disabled = recoveryPage === 0;
  $("recover-next").classList.toggle("hidden", recoveryPage === 2);
  $("recover-submit").classList.toggle("hidden", recoveryPage !== 2);
  grid.querySelector("input")?.focus();
}

function openRecovery(mode = "code") {
  $("recover-error").textContent = "";
  const russian = onboardingLanguage === "ru";
  $("recover-title").textContent = mode === "password"
    ? (russian ? "Войти в Obsidian" : "Sign in to Obsidian")
    : (russian ? "Recovery phrase" : "Recovery phrase");
  $("recover-lead").textContent = mode === "password"
    ? (russian ? "Введите логин и пароль восстановления, созданные на другом устройстве." : "Enter the recovery login and password created on another device.")
    : (russian ? "Введите 24 слова в том же порядке. За один шаг показываются восемь слов." : "Enter all 24 words in the original order. Eight words are shown per step.");
  const button = document.querySelector(`#recover-segment button[data-mode="${mode}"]`);
  button?.click();
  if (mode === "code") renderRecoveryPage();
  showScreen("screen-recover");
}

$("open-recover").addEventListener("click", () => openRecovery("code"));
$("open-password-recover").addEventListener("click", () => openRecovery("password"));
$("recover-back").addEventListener("click", () => showScreen("screen-entry"));

for (const button of document.querySelectorAll("#recover-segment button")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll("#recover-segment button")) {
      other.classList.toggle("active", other === button);
    }
    const byCode = button.dataset.mode === "code";
    $("form-recover-code").classList.toggle("hidden", !byCode);
    $("form-recover-password").classList.toggle("hidden", byCode);
    $("recover-error").textContent = "";
  });
}

/** Обе формы восстановления ведут себя одинаково: блокировка и понятный отказ. */
async function runRecovery(form, command, busyText, idleText) {
  const button = form.querySelector(".primary-button, #recover-submit");
  $("recover-error").textContent = "";
  button.disabled = true;
  button.textContent = busyText;
  const accepted = await submit(command);
  if (!accepted) {
    button.disabled = false;
    button.textContent = idleText;
  }
}

$("form-recover-code").addEventListener("submit", (event) => {
  event.preventDefault();
  storeRecoveryPage();
  if (recoveryWords.some((word) => !word)) {
    $("recover-error").textContent = "Заполните все 24 слова";
    return;
  }
  $("recover-code").value = recoveryWords.join(" ");
  runRecovery(
    $("form-recover-code"),
    { type: "recover", url: serverUrl(), code: $("recover-code").value.trim() },
    "Проверяем код…",
    "Восстановить",
  );
});

$("recover-next").addEventListener("click", () => {
  storeRecoveryPage();
  recoveryPage = Math.min(2, recoveryPage + 1);
  renderRecoveryPage();
});
$("recover-prev").addEventListener("click", () => {
  storeRecoveryPage();
  recoveryPage = Math.max(0, recoveryPage - 1);
  renderRecoveryPage();
});
$("recovery-word-grid").addEventListener("paste", (event) => {
  const pasted = event.clipboardData?.getData("text").trim().split(/\s+/).filter(Boolean) ?? [];
  if (pasted.length < 2) return;
  event.preventDefault();
  const local = Number(event.target.dataset.recoveryWord || 0);
  let start = recoveryPage * 8 + local;
  if (pasted.length >= 24) start = 0;
  pasted.slice(0, 24 - start).forEach((word, index) => { recoveryWords[start + index] = word; });
  recoveryPage = Math.min(2, Math.floor(start / 8));
  renderRecoveryPage();
});

$("form-recover-password").addEventListener("submit", (event) => {
  event.preventDefault();
  runRecovery(
    $("form-recover-password"),
    {
      type: "recover_password",
      url: serverUrl(),
      login: $("recover-login").value.trim(),
      password: $("recover-password").value,
    },
    // Argon2id на 128 МиБ считается заметное время — молчащая кнопка выглядела
    // бы как зависание.
    "Разбираем пароль…",
    "Восстановить",
  );
});

function resetRecoveryButtons() {
  for (const id of ["form-recover-code", "form-recover-password"]) {
    const button = $(id).querySelector(".primary-button, #recover-submit");
    button.disabled = false;
    button.textContent = id === "form-recover-password" ? "Войти" : "Восстановить →";
  }
}

async function boot() {
  showBoot("Защищаем локальное хранилище…");
  try {
    await listen("obsidian:event", ({ payload }) => {
      try {
        const event = JSON.parse(payload);
        const handler = handlers[event.type];
        if (handler) handler(event);
        else console.debug("необработанное событие", event);
      } catch (error) {
        console.error("не разобрать событие ядра", error);
      }
    });

    const state = await invoke("auto_unlock");
    if (state === "locked") {
      // База под паролем запуска: ключ от неё не выдаст даже Windows.
      showScreen("screen-locked");
      $("lock-password").focus();
      return;
    }
    if (state === "legacy") {
      showScreen("screen-migrate");
      return;
    }
    showBoot("Входим в аккаунт…");
    await submit({ type: "status" });
  } catch (error) {
    $("boot-status").textContent = `Не удалось запустить: ${String(error)}`;
    console.error(error);
  }
}

// --- диалоги -----------------------------------------------------------------

/**
 * Ищет каталог, не дожидаясь Enter.
 *
 * Пауза в наборе нужна не для красоты: сервер считает поиски и режет частые —
 * по запросу на букву мы упёрлись бы в предел на первом же имени.
 *
 * Показать людей «по первым буквам» нельзя: сервер хранит не имена, а их хеши,
 * и отвечает только на имя целиком. Это же и мешает постороннему выкачать
 * список всех, кто здесь есть.
 */
let lookupTimer = null;
let lookupQuery = null;

/**
 * Похоже ли введённое на адресата, а не на слово для поиска.
 *
 * От этого зависит, показывать ли кнопку «начать диалог»: поле одно, и по
 * тексту в нём надо понять, чего человек хочет — отфильтровать список или
 * написать новому собеседнику.
 */
/**
 * Ссылка на публичный канал: `getobsidian.xyz/channel/notes`.
 *
 * Отдельного обработчика протокола в системе нет, и заводить его ради этого —
 * значит просить у человека установку и права. Вставленная в поле ссылка
 * открывает канал ничуть не хуже.
 */
const CHANNEL_LINK = /^(?:https?:\/\/)?(?:www\.)?getobsidian\.xyz\/channel\/([a-z][a-z0-9_]{2,29})\/?$/i;

function looksLikeAddress(raw) {
  return CHANNEL_LINK.test(raw)
    || looksLikeUsername(raw)
    || /^OBS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/i.test(raw)
    || /^[0-9a-f]{64}$/i.test(raw);
}

$("omni").addEventListener("input", () => {
  const raw = $("omni").value.trim();
  $("omni-go").classList.toggle("hidden", !looksLikeAddress(raw));
  renderConversations();
  const name = (raw.startsWith("@") ? raw.slice(1) : raw).toLowerCase();
  clearTimeout(lookupTimer);
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(name)) {
    lookupQuery = null;
    hideSearchResult();
    return;
  }
  if (name === lookupQuery) return;
  lookupTimer = setTimeout(() => {
    lookupQuery = name;
    submit({ type: "username_lookup", name });
  }, 450);
});

$("form-omni").addEventListener("submit", (event) => {
  event.preventDefault();
  const raw = $("omni").value.trim();
  // Enter в поле поиска не должен ничего открывать: там просто слово.
  if (!looksLikeAddress(raw)) return;
  const link = CHANNEL_LINK.exec(raw);
  if (link) {
    $("omni").value = "";
    hideSearchResult();
    openTab("channels");
    submit({ type: "channel_find", handle: link[1].toLowerCase() });
    return;
  }
  // Юзернейм ищется по каталогу, код и адрес работают как раньше.
  if (looksLikeUsername(raw)) {
    hideSearchResult();
    submit({ type: "username_lookup", name: raw });
    return;
  }
  const peer = raw.toLowerCase();
  const chatCode = raw.toUpperCase();
  if (/^OBS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(chatCode)) {
    if (!state.profilesSupported) {
      toast("Сервер ещё не обновлён для кодов чата");
      return;
    }
    state.pendingChatCode = chatCode;
    submit({ type: "profile_get", query: chatCode });
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(peer)) {
    toast("Введите код OBS-ABCDE-23456 или полный адрес устройства");
    return;
  }
  if (peer === state.device) {
    toast("Это адрес вашего устройства");
    return;
  }
  $("omni").value = "";
  if (!state.conversations.has(peer)) {
    state.conversations.set(peer, { conversation: null, unread: 0 });
  }
  renderConversations();
  selectConversation(peer);
});


function profileFor(device) {
  return state.profiles.get(device) ?? null;
}

function displayName(device) {
  const profile = profileFor(device);
  const known = directory.get(device);
  const username = profile?.handle || known?.username;
  if (username) return `@${username.replace(/^@/, "")}`;
  if (known?.display_name) return known.display_name;
  return `Пользователь ${initials(device)}`;
}

/**
 * Значки: слово на проводе, глиф на экране.
 *
 * Сервер хранит короткое слово из закрытого списка, а не картинку, — иначе
 * рядом с чужим именем можно было бы показать что угодно. Незнакомое слово не
 * рисуется вовсе: у нового сервера список может оказаться длиннее нашего.
 */
const EMBLEMS = [
  ["none", "—"], ["star", "★"], ["moon", "☾"], ["leaf", "❦"], ["flame", "✦"], ["drop", "❉"],
  ["bolt", "⚡"], ["heart", "♥"], ["anchor", "⚓"], ["crown", "♛"], ["orbit", "◎"], ["shield", "⛨"],
];

const PROFILE_COLORS = [
  ["none", "Без цвета", "var(--muted)"], ["white", "Белый", "#f4f4f4"], ["blue", "Синий", "#70a8ff"],
  ["violet", "Фиолетовый", "#a98cff"], ["green", "Зелёный", "#67d4a3"],
  ["coral", "Коралловый", "#ed8674"], ["amber", "Янтарный", "#e7b75f"],
  ["teal", "Бирюзовый", "#5fd0c7"], ["rose", "Розовый", "#ee8ab4"],
];

function emblemGlyph(key) {
  if (!key || key === "none") return "";
  return EMBLEMS.find(([name]) => name === key)?.[1] ?? "";
}

function profileColor(key) {
  if (!key || key === "none") return "";
  return PROFILE_COLORS.find(([name]) => name === key)?.[2] ?? "";
}

/** Пишет имя и ставит значок справа от него. */
function paintName(node, device) {
  const profile = profileFor(device);
  node.textContent = displayName(device);
  const glyph = emblemGlyph(profile?.emblem);
  if (glyph) {
    const mark = document.createElement("span");
    mark.className = "emblem";
    mark.textContent = glyph;
    node.append(mark);
  }
  // Цвет достаётся подложке аватара, а не буквам: см. paintTint.
  node.style.color = "";
}

/**
 * Красит подложку профиля выбранным цветом.
 *
 * Именно подложку, а не текст: тёмно-синие или фиолетовые буквы на почти
 * чёрном фоне читаются плохо, и половина палитры оказалась бы негодной.
 * Подложка остаётся заметной при любом цвете, а текст — белым.
 */
function paintTint(node, color) {
  if (!node) return;
  const value = profileColor(color);
  node.style.setProperty("--tint", value || "transparent");
  node.classList.toggle("tinted", Boolean(value));
}

/**
 * Подложка аватара — тот же градиент, что в мобильном клиенте.
 *
 * Палитра, порядок цветов и способ выбора повторяют `avatarPlaceholder()` из
 * MainActivity, включая хеш строки по правилу Java. Это не педантизм: один и
 * тот же собеседник обязан получить один и тот же цвет на телефоне и на ПК,
 * иначе два списка бесед выглядят как списки разных людей.
 */
const AVATAR_PALETTE = [
  ["#8b6ff6", "#5e4fdb"], ["#ff7a54", "#ee4a4f"], ["#ffb952", "#ff843d"],
  ["#50ccab", "#2d99bc"], ["#5c8ef7", "#7259de"], ["#e65eb1", "#9a51d2"],
];

/** Хеш строки по правилу Java: тот же индекс палитры, что на телефоне. */
function javaHash(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0;
  }
  return hash;
}

function mixHex(color, onto, amount) {
  const parse = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const [red, green, blue] = parse(color);
  const [red2, green2, blue2] = parse(onto);
  const channel = (one, two) => Math.round(one * amount + two * (1 - amount))
    .toString(16).padStart(2, "0");
  return `#${channel(red, red2)}${channel(green, green2)}${channel(blue, blue2)}`;
}

function avatarGradient(seed, tint) {
  // Выбранный цвет профиля перебивает палитру: человек назначил его сам.
  if (tint) return `linear-gradient(135deg,${mixHex(tint, "#ffffff", 0.78)},${mixHex(tint, "#000000", 0.78)})`;
  const [start, end] = AVATAR_PALETTE[Math.abs(javaHash(seed) % AVATAR_PALETTE.length)];
  return `linear-gradient(135deg,${start},${end})`;
}

function applyAvatar(node, device) {
  const profile = profileFor(device);
  if (profile?.avatar_base64 && profile?.avatar_mime) {
    node.textContent = "";
    node.style.backgroundImage = `url(data:${profile.avatar_mime};base64,${profile.avatar_base64})`;
    node.classList.add("has-avatar");
    node.classList.remove("tinted");
    return;
  }
  const text = initials(device);
  node.textContent = text;
  node.classList.remove("has-avatar", "tinted");
  node.style.backgroundImage = avatarGradient(text, profileColor(profile?.color));
}

/**
 * Когда в беседе последний раз что-то происходило.
 *
 * Пока этого не было, список стоял в порядке, в котором беседы попали в Map, —
 * то есть в случайном для человека. Найти того, кто написал минуту назад,
 * приходилось глазами по всему списку.
 */
function touchConversation(key, at = Date.now()) {
  const entry = state.conversations.get(key);
  if (entry) entry.updatedAt = Math.max(entry.updatedAt ?? 0, at);
  // Ключ группы в списке — с префиксом; в state.groups она лежит по своему id.
  const group = state.groups.get(key.startsWith(GROUP_PREFIX) ? key.slice(GROUP_PREFIX.length) : key);
  if (group) group.updatedAt = Math.max(group.updatedAt ?? 0, at);
}

/** Беседа без единого сообщения не должна прыгать наверх: ей нечем. */
function recency(entry) {
  return entry.updatedAt ?? 0;
}

function previewText(body) {
  const content = parseContent(body);
  if (content.type === "read") return "";
  return notificationText(content).replace(/\s+/g, " ").trim();
}

function setConversationPreview(conversation, body, at = Date.now()) {
  const preview = previewText(body);
  if (!preview) return;
  const group = state.groups.get(conversation);
  if (group) {
    group.preview = preview;
    group.updatedAt = Math.max(group.updatedAt ?? 0, at ?? 0);
    return;
  }
  const peer = peerOf(conversation);
  const entry = peer ? state.conversations.get(peer) : null;
  if (entry) {
    entry.preview = preview;
    entry.updatedAt = Math.max(entry.updatedAt ?? 0, at ?? 0);
  }
}

function renderConversations() {
  const list = $("conversations");
  // Адрес и код в поле — это не запрос к списку: список не фильтруем.
  const raw = $("omni").value.trim();
  const query = looksLikeAddress(raw) ? "" : raw.toLowerCase();
  list.innerHTML = "";
  let visible = 0;

  // Группы и диалоги живут в одном списке, но раскладываются раздельно —
  // сортируем каждый набор по своей свежести.
  const groupsByRecency = [...state.groups].sort((a, b) => recency(b[1]) - recency(a[1]));
  const chatsByRecency = [...state.conversations].sort((a, b) => recency(b[1]) - recency(a[1]));

  for (const [id, group] of groupsByRecency) {
    const searchable = `${group.title} ${group.kind}`.toLowerCase();
    if (query && !searchable.includes(query)) continue;
    visible += 1;
    const key = groupKey(id);

    const item = document.createElement("li");
    item.classList.toggle("active", key === state.current);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-button";
    button.title = group.title;

    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar group";
    avatar.textContent = group.kind === "channel" ? "◈" : "◇";

    const copy = document.createElement("span");
    copy.className = "conversation-copy";
    const name = document.createElement("b");
    name.textContent = group.title || "Без названия";
    const tag = document.createElement("span");
    tag.className = "kind-tag";
    // «Закрытый» — чтобы не спутать с публичным каналом на вкладке рядом:
    // там содержимое лежит у сервера открытым, здесь — зашифровано.
    tag.textContent = group.kind === "channel" ? "закрытый канал" : "группа";
    name.appendChild(tag);
    const preview = document.createElement("span");
    const count = group.members?.length ?? 0;
    preview.textContent = group.preview || (count > 0 ? `участников: ${count}` : "пока только вы");
    copy.append(name, preview);
    button.append(avatar, copy);

    if (group.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(group.unread);
      button.appendChild(badge);
    }
    button.addEventListener("click", () => selectConversation(key));
    item.appendChild(button);
    list.appendChild(item);
  }

  for (const [peer, entry] of chatsByRecency) {
    const profile = profileFor(peer);
    const searchable = `${peer} ${profile?.handle ?? ""} ${profile?.chat_code ?? ""}`.toLowerCase();
    if (query && !searchable.includes(query)) continue;
    visible += 1;
    const item = document.createElement("li");
    item.classList.toggle("active", peer === state.current);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-button";
    button.title = peer;

    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar";
    applyAvatar(avatar, peer);

    const copy = document.createElement("span");
    copy.className = "conversation-copy";
    const name = document.createElement("b");
    paintName(name, peer);
    const preview = document.createElement("span");
    preview.textContent = entry.preview || (entry.conversation ? "Сообщений пока нет" : "Новое устройство");
    copy.append(name, preview);
    button.append(avatar, copy);

    if (entry.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(entry.unread);
      button.appendChild(badge);
    }
    button.addEventListener("click", () => selectConversation(peer));
    item.appendChild(button);
    list.appendChild(item);
  }

  syncUnread();

  if (visible === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = query ? "Ничего не найдено" : "Пока нет диалогов";
    list.appendChild(empty);
  }
}

function selectConversation(peer) {
  // Позицию покидаемого чата запоминаем: вернуться в середину переписки и
  // оказаться внизу — это потерянное место чтения.
  const leaving = conversationOf(state.current);
  if (leaving && history.has(leaving)) {
    history.get(leaving).scrollTop = $("messages").scrollTop;
  }

  state.current = peer;
  const group = isGroupKey(peer) ? state.groups.get(groupIdOf(peer)) : null;
  const entry = state.conversations.get(peer);
  // Сколько было непрочитано — запоминаем до обнуления: черта ставится по
  // этому числу, а счётчик к моменту отрисовки уже будет нулём.
  const wasUnread = (entry?.unread ?? 0) || (isGroupKey(peer) ? (group?.unread ?? 0) : 0);
  if (entry) entry.unread = 0;
  if (group) {
    group.unread = 0;
    $("peer-device").textContent = group.title || "Без названия";
    $("peer-device").style.color = "";
    $("peer-device").title = group.title;
    $("peer-avatar").textContent = group.kind === "channel" ? "◈" : "◇";
    $("peer-avatar").style.backgroundImage = "";
    // Сверять нечего: отпечаток есть у человека, а не у группы.
    $("verify").disabled = true;
  } else {
    paintName($("peer-device"), peer);
    $("peer-device").title = peer;
    applyAvatar($("peer-avatar"), peer);
    $("verify").disabled = false;
  }
  $("invite-to-group").classList.toggle("hidden", !group);
  $("leave-group").classList.toggle("hidden", !group);
  $("verify").classList.toggle("hidden", Boolean(group));
  $("verification").classList.add("hidden");
  // Ответ и надпись «печатает» относились к прошлому чату.
  replyingTo = null;
  renderReplyBar();
  showTyping(peer, typingPeers.has(peer));
  refreshPeerState();
  showChannelPanel(false);
  $("chat-header").classList.remove("hidden");
  $("form-send").classList.remove("hidden");
  $("chat-empty").classList.add("hidden");
  $("messages").classList.remove("hidden");
  // В чужом канале писать нельзя: пишет только владелец. Ограничение честное —
  // отправленное всё равно отвергнут получатели.
  const readOnly = Boolean(group) && group.kind === "channel" && group.owner !== state.device;
  for (const id of ["composer", "send", "attach-image", "record-voice", "emoji-open"]) {
    $(id).disabled = readOnly;
  }
  $("composer").placeholder = readOnly ? "В этот канал пишет только владелец" : "Сообщение…";
  renderConversations();

  // Через conversationOf, а не через entry: у группы записи в state.conversations
  // нет вовсе, и по entry её переписка не рисовалась и не подгружалась.
  const open = conversationOf(peer);
  if (open) {
    const cached = chat(open);
    // Уже открывали — показываем мгновенно и в базу не ходим.
    paintConversation(open, wasUnread);
    if (!cached.loaded) loadOlder(open);
  } else {
    $("messages").replaceChildren();
    $("history-more").classList.add("hidden");
  }

  if (!group && state.profilesSupported && !state.profiles.has(peer)) {
    submit({ type: "profile_get", query: peer });
  }
  if (!readOnly) $("composer").focus();
}

/**
 * Догрузка старого — по приближении к верху, а не по достижении.
 *
 * Запас в один экран нужен, чтобы страница успела прийти до того, как человек
 * упрётся в пустоту: обращение к ядру асинхронное, и «дожать до края и ждать»
 * читается как зависание.
 */
$("messages").addEventListener("scroll", () => {
  updateJumpButton();
  const conversation = conversationOf(state.current);
  if (!conversation) return;
  const list = $("messages");
  if (list.scrollTop < list.clientHeight) loadOlder(conversation);
});

$("history-more").addEventListener("click", () => {
  const conversation = conversationOf(state.current);
  if (conversation) loadOlder(conversation);
});

$("verify").addEventListener("click", () => {
  if (state.current) submit({ type: "verify", peer_device: state.current });
});
$("verification-close").addEventListener("click", () => $("verification").classList.add("hidden"));

$("form-send").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = $("composer").value.trim();
  if (!body || !state.current) return;
  $("composer").value = "";
  resizeComposer();

  // Режим правки: сообщение не отправляется заново, а заменяется на месте.
  // Новый идентификатор здесь был бы ошибкой — по нему собеседник не найдёт,
  // что именно менять.
  if (editing) {
    const { id } = editing;
    const conversation = conversationOf(state.current);
    editing = null;
    renderEditBar();
    const fresh = encodeContent({ type: "text", id, text: body });
    if (await submit({ type: "edit_message", conversation, id, body: fresh, for_both: true })) {
      applyEdit(conversation, id, fresh);
    }
    return;
  }

  state.pendingPeer = state.current;
  const content = { type: "text", id: logicalId(), text: body };
  if (replyingTo) {
    content.reply = { id: replyingTo.id, text: replyingTo.text };
    replyingTo = null;
    renderReplyBar();
  }
  const accepted = isGroupKey(state.current)
    ? await submit({ type: "group_send", group: groupIdOf(state.current), body: encodeContent(content) })
    : await submit({ type: "send", recipient_device: state.current, body: encodeContent(content) });
  if (accepted) {
    appendMessage(
      { outgoing: true, body: encodeContent(content), created_at: Date.now() },
      conversationOf(state.current),
    );
  }
});

function resizeComposer() {
  const composer = $("composer");
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 130)}px`;
}

$("composer").addEventListener("input", resizeComposer);
$("composer").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  // В режиме Ctrl+Enter обычный Enter обязан переносить строку, а не отправлять
  // недописанное: ради этого режим и включают.
  const wantsSend = preferences.sendKey === "ctrl"
    ? event.ctrlKey || event.metaKey
    : !event.shiftKey && !event.ctrlKey && !event.metaKey;
  if (wantsSend) {
    event.preventDefault();
    $("form-send").requestSubmit();
  }
});

/**
 * Собирает пузырь, но никуда его не вставляет.
 *
 * Узел хранится вместе с сообщением в кэше и переиспользуется при возврате в
 * чат: заново разбирать base64 фотографии на каждое переключение незачем.
 */
function buildMessage({ outgoing, body, created_at }, peer) {
  const content = parseContent(body);
  if (content.type === "read") { applyRead(content.ids); return null; }
  const item = document.createElement("li");
  item.className = outgoing ? "out" : "in";
  if (content.id) item.dataset.messageId = content.id;
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  applyAvatar(avatar, outgoing ? state.device : peer);
  item.appendChild(avatar);
  const text = document.createElement("div");
  text.className = "body";

  if (content.reply?.text) {
    const quote = document.createElement("div");
    quote.className = "reply-quote";
    const who = document.createElement("b");
    who.textContent = "В ответ на";
    quote.append(who, document.createTextNode(content.reply.text));
    text.appendChild(quote);
  }

  // Входящее вложение показывается, только если это разрешено правилами.
  // Своё собственное проверять незачем.
  const rule = CONTENT_RULE[content.type];
  if (!outgoing && rule && !permits(rule, peer)) {
    text.appendChild(blockedAttachment(content, () => {
      const shown = buildMessage({ outgoing, body, created_at }, null);
      if (shown) item.replaceWith(shown.node);
    }));
  } else if (content.type === "voice" && content.data && content.mime) {
    text.appendChild(voiceBubble(content));
  } else if (content.type === "image" && content.data && content.mime) {
    const image = document.createElement("img");
    image.className = "message-image";
    image.src = `data:${content.mime};base64,${content.data}`;
    image.alt = content.caption || "Фото";
    text.appendChild(image);
    if (content.caption) text.append(document.createTextNode(content.caption));
  } else {
    // Именно узлами, а не textContent: присваивание стёрло бы цитату, которую
    // мы только что вставили выше.
    text.append(...linkify(content.text ?? body));
  }
  const time = document.createElement("time");
  time.textContent = new Date(created_at).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: preferences.clock === "12",
  });
  item.appendChild(text);
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.appendChild(time);
  if (outgoing && content.id) {
    const delivery = document.createElement("span");
    delivery.className = "delivery";
    delivery.textContent = state.readIds.has(content.id) ? "✓✓ прочитано" : "✓ отправлено";
    meta.appendChild(delivery);
  }
  item.appendChild(meta);
  return { content, node: item };
}

/*
  Ссылки в тексте сообщения.

  Разбираем сами, а не отдаём разметке: текст пришёл от собеседника, и
  собирать из него HTML нельзя ни при каких обстоятельствах. Здесь строятся
  узлы — вставить тег через такую границу невозможно.

  Хвостовая пунктуация в ссылку не входит: «зайди на https://example.com.» — это
  предложение с точкой, а не адрес с точкой на конце. Скобку отрезаем только
  непарную: в адресах вроде ru.wikipedia.org/wiki/Обсидиан_(порода) она своя.

  Голый домен без схемы и без www ссылкой не считается намеренно. Иначе «и т.д.»
  и «версия 1.5.6» превращались бы в ссылки, а подчёркнутый мусор посреди фразы
  выглядит поломкой — в отличие от неподчёркнутого адреса, который человек
  просто скопирует.
*/
const LINK_PATTERN = /(https?:\/\/[^\s<>"']+|(?:^|\s)(?:www\.)[^\s<>"']+)/gi;

function linkify(raw) {
  const text = String(raw ?? "");
  const nodes = [];
  let at = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const lead = match[0].length - match[0].trimStart().length;
    const start = match.index + lead;
    let found = match[0].trimStart();

    // Отрезаем то, что человек дописал после адреса, а не в него.
    let trimmed = "";
    for (;;) {
      const last = found.at(-1);
      if (last && ".,;:!?»\"'".includes(last)) {
        trimmed = last + trimmed;
        found = found.slice(0, -1);
        continue;
      }
      if (last === ")" && !found.includes("(")) {
        trimmed = last + trimmed;
        found = found.slice(0, -1);
        continue;
      }
      break;
    }
    if (found.length < 4) continue;

    if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));
    nodes.push(linkNode(found));
    if (trimmed) nodes.push(document.createTextNode(trimmed));
    at = start + found.length + trimmed.length;
  }

  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  return nodes.length > 0 ? nodes : [document.createTextNode(text)];
}

function linkNode(found) {
  const href = /^https?:\/\//i.test(found) ? found : `https://${found}`;
  const link = document.createElement("a");
  link.className = "message-link";
  link.textContent = found;
  link.title = href;
  // href не ставим вовсе: щелчок middle-кнопкой или «открыть в новой вкладке»
  // увёл бы WebView со страницы приложения, а вернуться ему некуда.
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    invoke("open_link", { url: href }).catch(() => toast("Не удалось открыть ссылку"));
  });
  return link;
}

/**
 * Кнопка «к последним».
 *
 * Показывается, только когда человек действительно ушёл вверх: у самого низа
 * она бы просто закрывала сообщения. На ней счётчик того, что пришло, пока он
 * читал старое, — иначе непонятно, стоит ли возвращаться.
 */
let missedWhileUp = 0;

function updateJumpButton() {
  const list = $("messages");
  const away = !atBottom(list) && list.scrollHeight > list.clientHeight + 200;
  $("jump-down").classList.toggle("hidden", !away);
  if (!away) missedWhileUp = 0;
  const badge = $("jump-badge");
  badge.textContent = String(missedWhileUp);
  badge.classList.toggle("hidden", missedWhileUp === 0);
}

$("jump-down").addEventListener("click", () => {
  const list = $("messages");
  list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  missedWhileUp = 0;
  updateJumpButton();
});

/** Прокручен ли список к самому низу — с запасом на дробные пиксели. */
function atBottom(list) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
}

/**
 * Живое сообщение: в кэш и, если чат открыт, на экран.
 *
 * Вниз прокручиваем только когда человек и так внизу — иначе входящее
 * выдёргивало бы его из середины переписки, которую он читает.
 */
function appendMessage({ outgoing, body, created_at, from }, conversation, { cache = true } = {}) {
  // Отмечаем здесь, а не по месту вызова: точек вызова четыре, и забыть одну —
  // значит получить беседу, которая наверх не поднимается только в одном
  // случае из четырёх. Такое ищется долго.
  const key = state.groups.has(conversation) ? groupKey(conversation) : peerOf(conversation);
  if (key) touchConversation(key, created_at ?? Date.now());

  const group = state.groups.get(conversation);
  const author = from ?? peerOf(conversation) ?? state.current;
  const built = buildMessage({ outgoing, body, created_at }, author);
  if (built && group && !outgoing && from) {
    const who = document.createElement("b");
    who.className = "from";
    who.textContent = displayName(from);
    built.node.querySelector(".body")?.prepend(who);
  }
  if (!built) return null;

  if (conversation) setConversationPreview(conversation, body, created_at ?? Date.now());

  if (conversation && cache) {
    const entry = chat(conversation);
    entry.items.push({ created_at, node: built.node });
    entry.loaded = true;
  }

  // Пустая беседа — это первое сообщение новому собеседнику: идентификатора
  // ещё нет, но написано оно точно в открытый чат.
  if (!conversation || conversation === conversationOf(state.current)) {
    const list = $("messages");
    const follow = atBottom(list);
    // Первое сообщение нового дня приносит подпись с собой: иначе она
    // появилась бы только при следующем открытии беседы.
    const lastDay = [...list.querySelectorAll(".day-divider")].at(-1)?.dataset.day;
    const day = new Date(created_at ?? Date.now()).toDateString();
    if (lastDay !== day) list.appendChild(dayDivider(created_at ?? Date.now()));
    list.appendChild(built.node);
    if (follow) list.scrollTop = list.scrollHeight;
    else if (!outgoing) missedWhileUp += 1;
    updateJumpButton();
  }
  return built.content;
}

/**
 * Подпись дня над первым сообщением этого дня.
 *
 * «Сегодня» и «вчера» словами: дата рядом с сообщением, отправленным час
 * назад, читается как что-то давнее.
 */
function dayLabel(at) {
  const day = new Date(at);
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(day, today)) return "Сегодня";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (same(day, yesterday)) return "Вчера";

  const thisYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

function dayDivider(at) {
  const item = document.createElement("li");
  item.className = "day-divider";
  item.dataset.day = new Date(at).toDateString();
  const label = document.createElement("span");
  label.textContent = dayLabel(at);
  item.appendChild(label);
  return item;
}

/**
 * Раскладывает узлы, вставляя подписи дней между ними.
 *
 * Разделители не хранятся в кэше беседы: «сегодня» перестаёт быть сегодня в
 * полночь, и подпись, сложенная однажды, к утру начнёт врать.
 */
function withDayDividers(items, unreadFrom = null) {
  const out = [];
  let previous = null;
  let marked = false;

  for (const item of items) {
    const day = new Date(item.created_at).toDateString();
    if (day !== previous) {
      out.push(dayDivider(item.created_at));
      previous = day;
    }
    if (unreadFrom !== null && !marked && item === unreadFrom) {
      out.push(unreadDivider());
      marked = true;
    }
    out.push(item.node);
  }
  return out;
}

/** Черта, с которой начинается непрочитанное. */
function unreadDivider() {
  const item = document.createElement("li");
  item.className = "unread-divider";
  const label = document.createElement("span");
  label.textContent = "Непрочитанные";
  item.appendChild(label);
  return item;
}

/** Рисует кэш беседы целиком. Узлы переиспользуются, поэтому это дёшево. */
function paintConversation(conversation, unreadCount = 0) {
  const list = $("messages");
  const entry = chat(conversation);
  // Черту ставим перед N последними: сколько именно не прочитано, знает
  // счётчик беседы, а какие это сообщения — видно по их месту с конца.
  const from = unreadCount > 0 && unreadCount < entry.items.length
    ? entry.items[entry.items.length - unreadCount]
    : null;
  list.replaceChildren(...withDayDividers(entry.items, from));
  missedWhileUp = 0;
  if (entry.scrollTop === null) list.scrollTop = list.scrollHeight;
  else list.scrollTop = entry.scrollTop;
  $("history-more").classList.toggle("hidden", !entry.hasMore || !entry.loaded);
  updateJumpButton();
}

/** Просит следующую страницу — более старую, чем всё, что уже есть. */
function loadOlder(conversation) {
  const entry = chat(conversation);
  if (entry.loading || !entry.hasMore) return;
  entry.loading = true;
  submit({ type: "history", conversation, limit: PAGE_SIZE, before: entry.oldest });
}

/**
 * Проигрыватель голосового.
 *
 * Кнопка своя, а не `<audio controls>`: системный проигрыватель тянет за собой
 * собственную вёрстку, которая не подчиняется ни теме, ни скруглениям, и
 * ломает пузырь по ширине.
 */
function voiceBubble(content) {
  const wrap = document.createElement("div");
  wrap.className = "voice-message";

  const audio = new Audio(`data:${content.mime};base64,${content.data}`);
  const play = document.createElement("button");
  play.type = "button";
  play.className = "voice-play";
  play.textContent = "▶";
  play.setAttribute("aria-label", "Проиграть голосовое");

  const track = document.createElement("div");
  track.className = "voice-track";
  const fill = document.createElement("i");
  track.appendChild(fill);

  const time = document.createElement("span");
  time.className = "voice-time";
  time.textContent = clock(content.duration ?? 0);

  play.addEventListener("click", () => {
    if (audio.paused) audio.play().catch((error) => toast(`Не удалось проиграть: ${error}`));
    else audio.pause();
  });
  audio.addEventListener("play", () => (play.textContent = "❚❚"));
  audio.addEventListener("pause", () => (play.textContent = "▶"));
  audio.addEventListener("ended", () => {
    play.textContent = "▶";
    fill.style.width = "0";
    time.textContent = clock(content.duration ?? 0);
    // Следующее — только если о нём просили и оно есть. Порядок спрашиваем у
    // самой ленты: у проигрывателя есть лишь текущий файл.
    if (!preferences.voiceAutoplay) return;
    const buttons = [...document.querySelectorAll("#messages .voice-play")];
    const next = buttons[buttons.indexOf(play) + 1];
    if (next) setTimeout(() => next.click(), 250);
  });
  audio.addEventListener("timeupdate", () => {
    // Длительность берём из сообщения: у потокового webm её в метаданных нет,
    // и audio.duration до конца воспроизведения возвращает Infinity.
    const total = content.duration || audio.duration || 0;
    if (total > 0) fill.style.width = `${Math.min(100, (audio.currentTime / total) * 100)}%`;
    time.textContent = clock(audio.currentTime);
  });

  wrap.append(play, track, time);
  return wrap;
}

function clock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// --- запись голосового --------------------------------------------------------

/** Дольше не пишем: закодированное сообщение обязано пролезть в один кадр. */
const MAX_VOICE_SEC = 120;

$("record-voice").addEventListener("click", async () => {
  if (state.recorder) return stopRecording(true);
  if (!state.current) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    toast(`Микрофон недоступен: ${error}`);
    return;
  }

  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mime) {
    stream.getTracks().forEach((track) => track.stop());
    toast("Этот WebView не умеет записывать звук");
    return;
  }

  const chunks = [];
  // 24 кбит/с достаточно для речи и даёт примерно 180 КБ на две минуты — это
  // укладывается в один кадр вместе с накладными расходами MLS.
  const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 });
  const startedAt = Date.now();
  const peer = state.current;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("stop", async () => {
    stream.getTracks().forEach((track) => track.stop());
    clearInterval(state.recorder?.ticker);
    const keep = state.recorder?.keep;
    state.recorder = null;
    $("recording-bar").classList.add("hidden");
    document.querySelector(".composer")?.classList.remove("is-recording");
    $("record-voice").classList.remove("recording");

    const duration = (Date.now() - startedAt) / 1000;
    if (!keep || duration < 0.6) return;

    try {
      const data = await blobToBase64(new Blob(chunks, { type: mime }));
      if (data.length > 700000) throw new Error("запись слишком длинная");
      const body = encodeContent({
        type: "voice",
        id: logicalId(),
        mime,
        data,
        duration: Math.round(duration),
      });
      if (await submit({ type: "send", recipient_device: peer, body })) {
        appendMessage({ outgoing: true, body, created_at: Date.now() }, conversationOf(state.current));
      }
    } catch (error) {
      toast(`Не удалось отправить голосовое: ${error}`);
    }
  });

  const ticker = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    $("recording-time").textContent = clock(elapsed);
    if (elapsed >= MAX_VOICE_SEC) stopRecording(true);
  }, 200);

  state.recorder = { recorder, ticker, keep: true };
  $("recording-time").textContent = "0:00";
  $("recording-bar").classList.remove("hidden");
  document.querySelector(".composer")?.classList.add("is-recording");
  $("record-voice").classList.add("recording");
  recorder.start();
});

function stopRecording(keep) {
  if (!state.recorder) return;
  state.recorder.keep = keep;
  state.recorder.recorder.stop();
}

$("recording-stop").addEventListener("click", () => stopRecording(true));
$("recording-cancel").addEventListener("click", () => stopRecording(false));

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

$("attach-image").addEventListener("click", () => $("message-image-file").click());
$("message-image-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file && state.current) openEditor(file, "message");
});

function peerOf(conversation) {
  for (const [peer, entry] of state.conversations) {
    if (entry.conversation === conversation) return peer;
  }
  return null;
}

// --- события ядра -------------------------------------------------------------

const handlers = {
  status(event) {
    if (!event.has_identity) {
      showScreen(localStorage.getItem(ONBOARDING_COMPLETE) === "1" ? "screen-entry" : "screen-language");
      $("entry-submit").disabled = false;
      $("entry-submit").textContent = "Зарегистрироваться";
      return;
    }

    state.device = event.device;
    state.identity = event.identity;
    $("profile-identity").textContent = short(event.identity);
    $("profile-identity").title = event.identity;
    $("my-device").title = event.device;
    $("profile-device").textContent = short(event.device);
    $("profile-device").title = event.device;
    showBoot("Подключаем защищённый сеанс…");
    submit({ type: "fingerprint", identity: event.identity });
    submit({ type: "conversations" });
    submit({ type: "groups" });
    submit({ type: "privacy_get" });
    submit({ type: "directory_list" });
    submit({ type: "access_get" });
    setConnection("connecting", "подключаемся…");
    submit({ type: "connect", url: serverUrl() });
  },

  connected(event) {
    state.decorSupported = Boolean(event.decor);
    renderDecor();
    state.profilesSupported = Boolean(event.profiles);
    setConnection("connecting", "проверяем ключи…");
  },

  admin(event) {
    renderAdmin(event.report ?? {});
  },

  storage(event) {
    renderStorage(event);
  },

  account_exported(event) {
    $("export-password").value = "";
    // Напрямую invoke, а не windowCommand: путь к файлу нужен нам самим, а
    // windowCommand ошибку проглатывает и возвращает undefined.
    invoke("save_account_export", { contents: event.data })
      .then((path) => {
        $("export-status").textContent = `Файл на ${event.messages} сообщений: ${path}`;
        toast("Файл переноса сохранён");
      })
      .catch((error) => {
        $("export-status").textContent = `Не удалось сохранить: ${error}`;
      });
  },

  account_imported(event) {
    $("export-status").textContent = `Перенесено сообщений: ${event.messages}`;
    toast(`Аккаунт перенесён · сообщений: ${event.messages}`);
    // База сменилась целиком — перечитываем то, что показано на экране.
    submit({ type: "status" });
    submit({ type: "conversations" });
  },

  channels(event) {
    const report = event.report ?? {};
    if (Array.isArray(report.channels)) {
      channels.clear();
      for (const channel of report.channels) channels.set(channel.id, channel);
      renderChannelList();
    }
    if (report.found !== undefined) {
      if (report.found) {
        channels.set(report.found.id, report.found);
        renderChannelList();
        openChannelFeed(report.found.id);
      } else {
        toast(`Канала @${report.query} нет`);
      }
    }
    if (report.closed) {
      channels.delete(report.closed);
      renderChannelList();
      if (openChannel === report.closed) {
        openChannel = null;
        showChannelPanel(false);
        $("chat-empty").classList.remove("hidden");
        $("chat-header").classList.remove("hidden");
        toast(report.handle ? `Канал @${report.handle} закрыт` : "Канал закрыт");
      }
    }
    if (report.updated) {
      channels.set(report.updated.id, report.updated);
      renderChannelList();
      // Открытая панель настроек показывает состав редакции: он только что
      // мог измениться этим же ответом.
      channelSettingsModal?.__paintAdmins?.();
      if (openChannel === report.updated.id) {
        channelOldest = null;
        openChannelFeed(report.updated.id);
      }
    }
    if (report.opened) openChannelFeed(report.opened.id);
    if (report.channel && report.posts) renderChannel(report);
    // Опубликованное и убранное показываем перечитыванием ленты: так на экране
    // ровно то, что лежит на сервере, а не то, что мы надеемся там увидеть.
    if (report.published || report.removed !== undefined) {
      channelOldest = null;
      openChannelFeed(report.channel ?? openChannel);
    }
  },

  channel_post(event) {
    const report = event.report ?? {};
    if (report.channel === openChannel) {
      channelOldest = null;
      openChannelFeed(openChannel);
      return;
    }
    toast(`@${report.handle}: новый пост`);
  },

  group(event) {
    const known = state.groups.get(event.group);
    state.groups.set(event.group, {
      kind: event.kind,
      title: event.title,
      owner: event.owner,
      members: event.members ?? known?.members ?? [],
      unread: known?.unread ?? 0,
    });
    if (state.pendingInviteAfterCreate && event.owner === state.device) {
      const query = state.pendingInviteAfterCreate;
      state.pendingInviteAfterCreate = null;
      inviteToGroup(event.group, query);
    }
    renderConversations();
    // Название могло приехать позже самой группы — обновляем открытую шапку.
    if (state.current === groupKey(event.group)) selectConversation(state.current);
  },

  group_forgotten(event) {
    state.groups.delete(event.group);
    if (state.current === groupKey(event.group)) {
      state.current = null;
      $("messages").replaceChildren();
      $("chat-empty").classList.remove("hidden");
    }
    renderConversations();
  },

  authenticated(event) {
    // Панель открывает сервер, а не клиент: сам себе прав он выдать не может.
    state.admin = Boolean(event.admin);
    // Вкладка «Сервер» появляется только у владельца, и решает это сервер.
    $("nav-server").hidden = !state.admin;
    if (state.admin) submit({ type: "admin_get", offset: 0 });
    setConnection("online", event.queued > 0 ? `в сети · в очереди ${event.queued}` : "в сети");
    // Экран с фразой не смахиваем: AUTH_OK приходит сразу за регистрацией, и
    // без этой проверки человек увидел бы свои 24 слова на долю секунды.
    if (!backupWizardOpen()) showScreen("screen-main");
    if (state.pendingRecoverySetup) {
      const recovery = state.pendingRecoverySetup;
      state.pendingRecoverySetup = null;
      submit({ type: "recovery_setup", login: recovery.login, password: recovery.password });
    }
    submit({ type: "conversations" });
  },

  registered(event) {
    // Ядро присылает registered после любого AUTH_OK — в том числе при каждом
    // обычном запуске. Новым считаем аккаунт лишь после register из этой формы.
    const justRegistered = state.registrationPending;
    state.registrationPending = false;
    if (justRegistered) {
      state.freshAccount = true;
      submit({ type: "recovery_code" });
    }

    state.device = event.device;
    state.identity = event.identity;
    $("profile-identity").textContent = short(event.identity);
    $("profile-identity").title = event.identity;
    $("my-device").title = event.device;
    $("profile-device").textContent = short(event.device);
    $("profile-device").title = event.device;
    submit({ type: "fingerprint", identity: event.identity });
  },

  fingerprint(event) {
    state.fingerprint = event.fingerprint;
    $("my-fingerprint").textContent = event.fingerprint;
    $("my-fingerprint").title = event.fingerprint;
  },

  conversations(event) {
    for (const item of event.items) {
      const existing = state.conversations.get(item.peer_device);
      state.conversations.set(item.peer_device, {
        conversation: item.conversation,
        unread: existing?.unread ?? 0,
        preview: previewText(item.last_body) || existing?.preview || "",
        updatedAt: item.last_at ?? existing?.updatedAt ?? 0,
      });
      if (state.profilesSupported && !state.profiles.has(item.peer_device)) {
        submit({ type: "profile_get", query: item.peer_device });
      }
    }
    renderConversations();
  },

  conversation_started(event) {
    const existing = state.conversations.get(event.peer_device);
    state.conversations.set(event.peer_device, {
      conversation: event.conversation,
      unread: existing?.unread ?? 0,
      preview: existing?.preview || "",
      updatedAt: existing?.updatedAt ?? 0,
    });
    if (state.pendingPeer === event.peer_device) state.pendingPeer = null;
    renderConversations();
  },

  message(event) {
    const group = state.groups.get(event.conversation);
    const peer = group ? groupKey(event.conversation) : (peerOf(event.conversation) ?? event.sender_device);
    if (!group && !state.conversations.has(peer)) {
      state.conversations.set(peer, { conversation: event.conversation, unread: 0 });
    }
    const content = parseContent(event.body);
    if (content.type === "read") {
      applyRead(content.ids);
      renderConversations();
      return;
    }

    showDesktopNotification({
      title: displayName(event.sender_device || peer),
      text: notificationText(content),
      // В группе щелчок ведёт в группу, а не в личную переписку с тем, кто
      // написал: человек нажимает на уведомление о разговоре, который видел.
      device: group ? peer : (event.sender_device || peer),
      avatarOf: event.sender_device || peer,
    });

    // В кэш беседы кладём в любом случае — но только если он уже поднят. Иначе
    // одно сообщение притворилось бы всей перепиской, и открытие чата показало
    // бы его одно вместо истории.
    const known = history.get(event.conversation);
    appendMessage(
      { outgoing: false, body: event.body, created_at: event.server_ts, from: event.sender_device },
      event.conversation,
      { cache: Boolean(known?.loaded) },
    );

    if (peer === state.current) {
      // В группе отчёт о прочтении отправлять некому одному: адресата у него
      // нет, и слать его каждому участнику значило бы рассказывать всем, кто
      // что открыл. В диалоге всё как было.
      if (content.id && !group) sendRead(peer, [content.id]);
    } else if (group) {
      group.unread += 1;
    } else {
      state.conversations.get(peer).unread += 1;
    }
    renderConversations();
  },

  verification(event) {
    // Ответ асинхронный: не показываем код устройства A уже после перехода в
    // диалог B, иначе правильный код получает неправильную подпись.
    if (event.peer_device !== state.current) return;
    $("safety-number").textContent = event.safety_number;
    $("epoch-code").textContent = `${event.epoch_code} · эпоха ${event.epoch}`;
    $("verification").classList.remove("hidden");
  },

  anomaly(event) {
    const banner = $("anomaly");
    banner.textContent = `Возможное вмешательство · ${event.kind}: ${event.detail}`;
    banner.classList.remove("hidden");
  },

  history(event) {
    const entry = chat(event.conversation);
    entry.loading = false;
    entry.loaded = true;
    entry.hasMore = event.has_more;
    if (event.messages.length) entry.oldest = event.messages[event.messages.length - 1].cursor;

    // Ядро отдаёт новейшие первыми — на экране порядок обратный.
    const ordered = [...event.messages].reverse();
    const latestVisible = event.messages.find((item) => previewText(item.body));
    if (latestVisible) {
      setConversationPreview(event.conversation, latestVisible.body, latestVisible.created_at);
      renderConversations();
    }

    // Отметки о прочтении разбираем до сборки пузырей: иначе галочки на уже
    // построенных сообщениях останутся одинарными до следующего события.
    for (const item of ordered) {
      const content = parseContent(item.body);
      if (content.type === "read") {
        applyRead(content.ids);
        if (item.outgoing) (content.ids ?? []).forEach((id) => state.sentReadIds.add(id));
      }
    }

    const page = [];
    const visibleIncoming = [];
    const peer = peerOf(event.conversation);
    for (const item of ordered) {
      const built = buildMessage(item, peer);
      if (!built) continue;
      page.push({ created_at: item.created_at, node: built.node });
      if (built.content?.id && !item.outgoing) visibleIncoming.push(built.content.id);
    }
    // Страница всегда старше того, что уже лежит в кэше.
    entry.items.unshift(...page);

    // Ответ мог опоздать: пока он шёл, человек успел уйти в другой чат.
    if (event.conversation !== conversationOf(state.current)) return;

    const list = $("messages");
    if (page.length && entry.items.length > page.length) {
      // Догрузка вверх: держим содержимое на месте, а не прыгаем.
      const anchor = list.scrollHeight - list.scrollTop;
      list.prepend(...page.map((item) => item.node));
      list.scrollTop = list.scrollHeight - anchor;
      $("history-more").classList.toggle("hidden", !entry.hasMore);
    } else {
      entry.scrollTop = null;
      paintConversation(event.conversation);
    }

    sendRead(state.current, visibleIncoming);
  },

  profile(event) {
    state.profiles.set(event.device, event);
    if (event.device === state.device) {
      state.chatCode = event.chat_code;
      $("my-chat-code").textContent = event.chat_code;
      $("profile-chat-code").textContent = event.chat_code;
      applyAvatar(document.querySelector("#my-device .profile-avatar"), state.device);
      $("avatar-upload").style.backgroundImage = event.avatar_base64
        ? `url(data:${event.avatar_mime};base64,${event.avatar_base64})`
        : "";
      $("avatar-upload").classList.toggle("has-avatar", Boolean(event.avatar_base64));
      $("profile-avatar-text").textContent = event.avatar_base64 ? "" : initials(state.device);
      paintTint($("avatar-upload"), event.color);
      state.emblem = event.emblem ?? "none";
      state.color = event.color ?? "none";
      renderDecor();
    }
    const invite = state.pendingGroupInvite;
    if (invite && invite.query.toUpperCase() === event.chat_code) {
      state.pendingGroupInvite = null;
      submit({ type: "group_invite", group: invite.group, members: [event.device] });
      toast("Приглашение отправлено");
      return;
    }
    if (state.pendingChatCode === event.chat_code) {
      state.pendingChatCode = null;
      $("omni").value = "";
      if (event.device === state.device) {
        toast("Это ваш собственный код");
      } else {
        if (!state.conversations.has(event.device)) {
          state.conversations.set(event.device, { conversation: null, unread: 0 });
        }
        selectConversation(event.device);
      }
    }
    if (state.current === event.device) {
      paintName($("peer-device"), event.device);
      applyAvatar($("peer-avatar"), event.device);
    }
    renderConversations();
  },

  username(event) {
    state.username = event.name ?? null;
    renderUsername();
    usernameStatus(state.username ? "Занят." : "Не занят.");
  },

  username_found(event) {
    const invite = state.pendingGroupInvite;
    if (invite) {
      state.pendingGroupInvite = null;
      if (!event.device) return toast(`@${event.query} — никого не нашли`);
      if (event.pin === "changed") {
        event.after_pin = { kind: "group_invite", group: invite.group };
        return renderSearchHit(event);
      }
      submit({ type: "group_invite", group: invite.group, members: [event.device] });
      return toast(`@${event.query} приглашён`);
    }
    if (!event.device) return renderSearchMiss(event.query);
    state.profiles.set(event.device, {
      device: event.device,
      chat_code: event.chat_code,
      handle: event.query,
      avatar_mime: event.avatar_mime,
      avatar_base64: event.avatar_base64,
    });
    renderSearchHit(event);
  },

  pin_accepted(event) {
    const pending = state.pendingPinAction;
    if (!pending || pending.query !== event.name || pending.device !== event.device) return;
    state.pendingPinAction = null;
    completePinnedAction(pending);
  },

  directory(event) {
    directory.clear();
    for (const item of event.entries) directory.set(item.device, item);
    renderDirectory();
    renderConversations();
  },

  peer_typing(event) {
    showTyping(event.peer_device, event.active);
  },

  peer_online(event) {
    seenOnline.set(event.peer_device, Date.now());
    if (event.peer_device === state.current) refreshPeerState();
    renderConversations();
  },

  edited(event) {
    applyEdit(event.conversation, event.id, event.body);
  },

  deleted(event) {
    const entry = history.get(event.conversation);
    for (const id of event.ids) {
      document.querySelectorAll(`[data-message-id="${CSS.escape(id)}"]`).forEach((n) => n.remove());
      if (entry) {
        entry.items = entry.items.filter((item) => item.node.dataset.messageId !== id);
      }
    }
  },

  conversation_cleared(event) {
    history.delete(event.conversation);
    if (event.forgotten) {
      const peer = peerOf(event.conversation);
      if (peer) state.conversations.delete(peer);
      if (peer === state.current) {
        state.current = null;
        $("messages").classList.add("hidden");
        $("chat-empty").classList.remove("hidden");
      }
      renderConversations();
    } else if (event.conversation === conversationOf(state.current)) {
      $("messages").replaceChildren();
    }
    toast(event.forgotten ? "Чат удалён" : "Переписка очищена");
  },

  access(event) {
    access = event;
    renderInvites();
  },

  privacy(event) {
    privacy = event.privacy;
    if (ownEcho) {
      // Подтверждение собственной записи: на экране всё уже так и есть,
      // обновить надо только счётчики исключений.
      ownEcho = false;
      updatePrivacyCounts();
      return;
    }
    renderPrivacy();
    if (exceptionsFor) renderExceptions();
  },

  queue_done() {
    setConnection("online", "в сети");
  },

  disconnected(event) {
    state.lastDisconnectReason = event.reason || "соединение прервано";
    setConnection("offline", "переподключаемся…");
    if (state.device && $("screen-entry").classList.contains("hidden") && !backupWizardOpen()) {
      showScreen("screen-main");
    }
    if (!$("screen-entry").classList.contains("hidden")) {
      $("entry-error").textContent = `Не удалось подключиться: ${event.reason}`;
      $("entry-submit").disabled = false;
      $("entry-submit").textContent = "Повторить";
    }
  },

  recovery_code(event) {
    state.recoveryCode = event.code;
    state.recoveryWords = event.words;

    if (state.freshAccount) {
      // Первый показ — на своём экране, а не строкой в настройках.
      state.freshAccount = false;
      openBackupWizard();
      return;
    }

    $("recovery-code-box").classList.remove("hidden");
    $("copy-recovery-code").classList.remove("hidden");
    $("recovery-code-text").textContent = event.words;
    $("show-recovery-code").textContent = "Скрыть";
  },

  recovery_saved(event) {
    const note = event.totp
      ? `Запасной вход включён для «${event.login}», код из приложения обязателен`
      : `Восстановление включено для логина «${event.login}»`;
    setRecoveryStatus(note, "ok");
    $("recovery-password").value = "";
    $("save-recovery-password").disabled = false;
    $("save-recovery-password").textContent = "Включить";

    // Если это был шаг регистрации — он на этом и заканчивается.
    if (!$("screen-backup").classList.contains("hidden")) finishBackupWizard();
  },

  totp_secret(event) {
    state.totpSecret = event.secret;
    $("backup-totp-secret").textContent = event.readable;
  },

  recovery_forgotten() {
    setRecoveryStatus("Запечатанная копия убрана с сервера. Остался только код.", "ok");
  },

  failed(event) {
    if (event.code === "pin_not_pending" || (event.code === "storage" && state.pendingPinAction)) {
      state.pendingPinAction = null;
      toast("Новый ключ не подтверждён: действие остановлено");
      return;
    }
    const username = FRIENDLY_ERRORS[event.code];
    if (username) {
      // Отказ показываем там, где человек действовал: занятие имени — в
      // настройках профиля, всё остальное случается по ходу переписки.
      if (event.code === "username_taken" || event.code === "bad_username") usernameStatus(username);
      else toast(username);
      return;
    }
    const recovery = recoveryError(event);
    if (recovery && !$("screen-recover").classList.contains("hidden")) {
      $("recover-error").textContent = recovery;
      resetRecoveryButtons();
      return;
    }
    if (recovery && !settingsPage.classList.contains("hidden")) {
      setRecoveryStatus(recovery, "bad");
      $("save-recovery-password").disabled = false;
      $("save-recovery-password").textContent = "Включить";
      return;
    }
    if (event.code === "login_taken") {
      setRecoveryStatus("Этот логин уже занят другим аккаунтом — возьмите другой", "bad");
      $("save-recovery-password").disabled = false;
      $("save-recovery-password").textContent = "Включить";
      return;
    }
    const message = entryError(event);
    if (message) {
      state.registrationPending = false;
      state.pendingRecoverySetup = null;
      showScreen("screen-entry");
      $("entry-error").textContent = message;
      $("entry-submit").disabled = false;
      $("entry-submit").textContent = "Зарегистрироваться";
    } else {
      toast(`${event.code}: ${event.message}`);
    }
  },
};

/** Отказы восстановления показываются на своём экране, а не в общем тосте. */
function recoveryError(event) {
  const known = {
    bad_recovery_code: "Код набран с ошибкой — проверьте символы",
    bad_password: "Логин или пароль не подошли",
    recovery_not_found: "Логин или пароль не подошли",
    recovery_rate_limited: "Слишком много попыток. Попробуйте через час",
    identity_exists: "На этом устройстве уже есть аккаунт",
    recover: "Не удалось восстановить доступ",
  };
  return known[event.code];
}

/** Понятные причины отказа вместо машинных кодов. */
const FRIENDLY_ERRORS = {
  dm_not_allowed: "Этот человек не принимает сообщения от незнакомых. Нужна его ссылка-приглашение.",
  passes_full: "Слишком много выпущенных приглашений. Отзовите ненужные.",
  username_taken: "Это имя уже занято.",
  bad_username: "Имя не подходит: латиница, цифры и подчёркивание, от 3 до 20 символов, не с цифры.",
  search_rate_limited: "Слишком много поисков подряд. Подождите минуту.",
};

function entryError(event) {
  const known = {
    entry_required: "Для этого устройства нужен новый инвайт-код",
    invite_invalid: "Инвайт не найден, уже использован или просрочен",
    handle_taken: "Это имя уже занято",
    bad_handle: "Имя: 3–20 символов из a-z, 0-9 и _",
    device_conflict: "Ключ устройства уже связан с другой личностью",
  };
  return known[event.code];
}

// --- локальные действия -------------------------------------------------------

$("anomaly").addEventListener("click", () => $("anomaly").classList.add("hidden"));
$("my-device").addEventListener("click", () => {
  settingsPage.classList.remove("hidden");
  syncWindowTitle();
});
$("copy-fingerprint").addEventListener("click", () => copyText(state.fingerprint, "Отпечаток скопирован"));
$("profile-device").addEventListener("click", () => copyText(state.device, "Адрес устройства скопирован"));
$("profile-chat-code").addEventListener("click", () => copyText(state.chatCode, "Код для чата скопирован"));

$("logout-account").addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Выйти из профиля на этом компьютере?\n\n"
      + "Локальные ключи и переписка исчезнут из приложения, но останутся на этом компьютере. "
      + "Сам аккаунт на сервере не удалится. Для повторного входа понадобятся 24 слова или логин и пароль.",
  );
  if (!confirmed) return;

  const button = $("logout-account");
  button.disabled = true;
  button.textContent = "Выходим…";
  try {
    await invoke("logout_local_account");
    localStorage.removeItem("obsidian.preferences");
    window.location.reload();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Выйти";
    toast(`Не удалось выйти: ${String(error)}`);
  }
});

function setRecoveryStatus(text, kind) {
  const node = $("recovery-status");
  node.textContent = text;
  node.className = `recovery-status ${kind ?? ""}`.trim();
}

// --- экран «что делать, если устройство пропадёт» ------------------------------

/**
 * Показывается один раз, сразу после регистрации.
 *
 * Порядок шагов не случаен: сначала то, что работает без сервера и без нас
 * (фраза), и только потом запасной вход, который зависит и от сервера, и от
 * стойкости пароля. Если человек уйдёт после первого шага — он уйдёт с самым
 * надёжным способом в кармане.
 */
function openBackupWizard() {
  showScreen("screen-backup");
  backupStep(1);

  // Фраза не появляется ни на экране, ни в разметке без явного действия.
  $("backup-words").replaceChildren();
  $("backup-secret").classList.add("hidden");
  $("backup-words-reveal").classList.remove("hidden");

  $("backup-written").checked = false;
  $("backup-next").disabled = true;
  $("backup-totp").checked = false;
  $("backup-totp-box").classList.add("hidden");
  $("backup-totp-code").value = "";
  $("backup-login").value = "";
  $("backup-password").value = "";
  $("backup-status").textContent = "";
  $("backup-status").className = "recovery-status";
}

/** Открыт ли мастер: пока он на экране, его нельзя перебивать. */
/**
 * Пришло ли событие из поля ввода.
 *
 * Через `event.target` напрямую нельзя: когда фокуса нет ни на чём, целью
 * оказывается сам документ, у которого нет `closest`, и обработчик падает
 * молча — вместе со всем, что стояло после него.
 */
function inTextField(target) {
  return target instanceof Element && Boolean(target.closest("input, textarea"));
}

function backupWizardOpen() {
  return !$("screen-backup").classList.contains("hidden");
}

function backupStep(step) {
  if ($("backup-step-now")) $("backup-step-now").textContent = String(step);
  $("backup-step-words").classList.toggle("hidden", step !== 1);
  $("backup-step-second").classList.toggle("hidden", step !== 2);
}

function finishBackupWizard() {
  // Фраза со экрана уходит вместе с ним: держать её в разметке незачем.
  $("backup-words").replaceChildren();
  $("backup-secret").classList.add("hidden");
  state.recoveryWords = "";
  state.recoveryCode = "";
  showScreen("screen-main");
}

$("backup-words-reveal").addEventListener("click", () => {
  const list = $("backup-words");
  list.replaceChildren();
  for (const word of (state.recoveryWords || "").split(/\s+/).filter(Boolean)) {
    const item = document.createElement("li");
    item.textContent = word;
    list.appendChild(item);
  }
  $("backup-words-reveal").classList.add("hidden");
  $("backup-secret").classList.remove("hidden");
});

$("backup-written").addEventListener("change", () => {
  $("backup-next").disabled = !$("backup-written").checked;
});

$("backup-words-copy").addEventListener("click", () =>
  copyText(state.recoveryWords, "Фраза скопирована — вставьте в надёжное место и очистите буфер"));

$("backup-words-code").addEventListener("click", () => {
  // Тот же ключ, другая запись: кому-то привычнее строка, а не слова.
  const button = $("backup-words-code");
  const list = $("backup-words");
  const showingCode = list.classList.toggle("as-code");
  button.textContent = showingCode ? "Показать словами" : "Показать кодом";
  list.replaceChildren();
  if (showingCode) {
    const item = document.createElement("li");
    item.className = "wide";
    item.textContent = state.recoveryCode;
    list.appendChild(item);
    return;
  }
  for (const word of state.recoveryWords.split(/\s+/)) {
    const item = document.createElement("li");
    item.textContent = word;
    list.appendChild(item);
  }
});

$("backup-next").addEventListener("click", () => finishBackupWizard());

$("backup-totp").addEventListener("change", () => {
  const on = $("backup-totp").checked;
  $("backup-totp-box").classList.toggle("hidden", !on);
  // Секрет заводится на устройстве и до подтверждения кодом никуда не уходит.
  if (on && !state.totpSecret) submit({ type: "totp_secret", login: $("backup-login").value.trim() || "obsidian" });
});

$("backup-skip").addEventListener("click", () => {
  confirmAction(
    "Пропустить запасной вход?",
    "Тогда единственный способ вернуть аккаунт — фраза из 24 слов. Потеряете бумагу — "
    + "вернуть будет нечем: ключей нет ни у нас, ни у того, кто держит сервер.",
    () => finishBackupWizard(),
  );
});

$("backup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const login = $("backup-login").value.trim();
  const password = $("backup-password").value;
  const useTotp = $("backup-totp").checked;
  const code = $("backup-totp-code").value.trim();

  const bad = (text) => {
    $("backup-status").textContent = text;
    $("backup-status").className = "recovery-status bad";
  };
  if (login.length < 3) return bad("Логин от 3 символов");
  if (password.length < 10) return bad("Пароль минимум 10 символов");
  if (useTotp && !/^\d{6}$/.test(code)) return bad("Введите шесть цифр из приложения");

  const button = $("backup-save");
  button.disabled = true;
  button.textContent = "Считаем…";
  $("backup-status").textContent = "Выводим ключ из пароля, это занимает пару секунд…";
  $("backup-status").className = "recovery-status";

  const ok = await submit({
    type: "recovery_setup",
    login,
    password,
    totp: useTotp ? state.totpSecret : null,
    code: useTotp ? code : null,
  });
  if (!ok) {
    button.disabled = false;
    button.textContent = "Включить запасной вход";
    bad("Не вышло — проверьте логин и код");
  }
});

$("show-recovery-code").addEventListener("click", () => {
  const box = $("recovery-code-box");
  if (!box.classList.contains("hidden")) {
    // Код не должен оставаться на экране: его слишком легко снять камерой.
    box.classList.add("hidden");
    $("copy-recovery-code").classList.add("hidden");
    $("recovery-code-text").textContent = "—";
    state.recoveryCode = "";
    $("show-recovery-code").textContent = "Показать фразу";
    return;
  }
  submit({ type: "recovery_code" });
});

$("copy-recovery-code").addEventListener("click", () =>
  copyText(state.recoveryWords, "Фраза скопирована — вставьте в надёжное место и очистите буфер"),
);

$("save-recovery-password").addEventListener("click", async () => {
  const login = $("recovery-login").value.trim();
  const password = $("recovery-password").value;
  if (login.length < 3) return setRecoveryStatus("Логин от 3 символов", "bad");
  if (password.length < 10) return setRecoveryStatus("Пароль минимум 10 символов", "bad");

  const button = $("save-recovery-password");
  button.disabled = true;
  button.textContent = "Считаем…";
  setRecoveryStatus("Выводим ключ из пароля, это занимает пару секунд…");
  if (!(await submit({ type: "recovery_setup", login, password }))) {
    button.disabled = false;
    button.textContent = "Включить";
  }
});

$("forget-recovery-password").addEventListener("click", () => {
  submit({ type: "recovery_forget" });
});

$("avatar-upload").addEventListener("click", () => $("avatar-file").click());
$("avatar-file").addEventListener("change", () => {
  const file = $("avatar-file").files?.[0];
  $("avatar-file").value = "";
  // Тот же редактор, что и для фото, но кадр заперт квадратом: аватар всё
  // равно показывается в круге, и обрезать его вслепую — значит промахиваться.
  if (file) openEditor(file, "avatar");
});

const settingsPage = $("settings-page");
const preferenceDefaults = {
  transport: "auto",
  theme: "dark",
  accent: "#7b2cff",
  accentText: "#ffffff",
  fontSize: 15,
  scale: 100,
  autoScale: true,
  radius: 13,
  bubbleRadius: 13,
  messageWidth: 72,
  blur: 24,
  panelOpacity: 82,
  compact: false,
  squareAvatars: false,
  dividers: "full",
  wallpaper: "none",
  wallpaperIntensity: 45,
  uiFont: "inter",
  sidebarWidth: 310,
  tails: false,
  motion: "full",
  clock: "24",
  sendKey: "enter",
  confirmDelete: true,
  voiceAutoplay: false,
  // 85 — не «поменьше на всякий случай», а рабочий размер: на 100 карточка
  // перекрывает угол экрана и читается как диалоговое окно, а не как
  // уведомление.
  notificationSize: 85,
  notificationColor: "graphite",
  notificationPosition: "top",
  notificationSound: true,
};

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("obsidian.preferences") || "{}");
    // До этой версии белый был не выбором пользователя, а значением по
    // умолчанию. Однократно переводим такие установки на новый фиолетовый
    // акцент; после этого любой цвет, включая белый, сохраняется буквально.
    if (!saved.accentVersion && (!saved.accent || saved.accent.toLowerCase() === "#f4f4f4")) {
      saved.accent = preferenceDefaults.accent;
      saved.accentText = preferenceDefaults.accentText;
    }
    saved.accentVersion = 2;
    return { ...preferenceDefaults, ...saved };
  } catch {
    return { ...preferenceDefaults };
  }
}

let preferences = loadPreferences();

function savePreferences() {
  localStorage.setItem("obsidian.preferences", JSON.stringify(preferences));
}

function accentTextFor(color) {
  const value = color.slice(1);
  const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return (red * 299 + green * 587 + blue * 114) / 1000 > 160 ? "#080808" : "#ffffff";
}

function applyPreferences() {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.style.setProperty("--accent", preferences.accent);
  root.style.setProperty("--accent-text", preferences.accentText);
  root.style.setProperty("--message-font-size", `${preferences.fontSize}px`);
  root.style.setProperty("--radius", `${preferences.radius}px`);
  root.style.setProperty("--bubble-radius", `${preferences.bubbleRadius}px`);
  root.style.setProperty("--message-width", `${preferences.messageWidth}%`);
  root.style.setProperty("--blur", `${preferences.blur}px`);
  root.style.setProperty("--panel-opacity", `${preferences.panelOpacity}%`);
  const shell = $("screen-main");
  // Макет уже рассчитан на обычный широкий desktop (1920 CSS px). Раньше
  // автоскейл включался с 1700 px и раздувал весь интерфейс на 18% именно на
  // самом распространённом Full HD: карточки становились выше макета, а пять
  // элементов композера переставали помещаться в строку. Масштаб нужен только
  // на действительно больших CSS-вьюпортах.
  const detectedScale = window.innerWidth >= 2400 ? 1.18
    : window.innerWidth <= 1050 ? 0.92 : 1;
  const scale = (preferences.scale / 100) * (preferences.autoScale ? detectedScale : 1);
  if (scale === 1) {
    shell.style.removeProperty("zoom");
    shell.style.removeProperty("width");
    shell.style.removeProperty("height");
  } else {
    // Экран начинается под title bar. Прежние 100% считались от всего
    // viewport и добавляли эти 40 px снизу ещё раз.
    const inverse = 1 / scale;
    shell.style.zoom = String(scale);
    shell.style.width = `${100 * inverse}vw`;
    shell.style.height = `calc(${100 * inverse}vh - ${40 * inverse}px)`;
  }
  const settingsBody = document.querySelector(".settings-body");
  if (scale === 1) {
    settingsBody.style.removeProperty("zoom");
    settingsBody.style.removeProperty("width");
  } else {
    settingsBody.style.zoom = String(scale);
    settingsBody.style.width = `${100 / scale}%`;
  }
  root.style.setProperty("--sidebar-width", `${preferences.sidebarWidth}px`);
  root.style.setProperty("--wallpaper-intensity", String(preferences.wallpaperIntensity));
  document.body.dataset.dividers = preferences.dividers;
  document.body.dataset.wallpaper = preferences.wallpaper;
  document.body.dataset.font = preferences.uiFont;
  document.body.dataset.motion = preferences.motion;
  document.body.classList.toggle("compact", preferences.compact);
  document.body.classList.toggle("square-avatars", preferences.squareAvatars);
  document.body.classList.toggle("tails", preferences.tails);

  for (const button of document.querySelectorAll("#theme-segment [data-theme]")) {
    button.classList.toggle("active", button.dataset.theme === preferences.theme);
  }
  for (const button of document.querySelectorAll(".settings-colors [data-color]")) {
    button.classList.toggle("active", button.dataset.color.toLowerCase() === preferences.accent.toLowerCase());
  }
  for (const [selector, attribute, current] of [
    ["#transport-segment [data-transport]", "transport", preferences.transport],
    ["#divider-segment [data-dividers]", "dividers", preferences.dividers],
    ["#wallpaper-grid [data-wallpaper]", "wallpaper", preferences.wallpaper],
    ["#font-segment [data-font]", "font", preferences.uiFont],
    ["#motion-segment [data-motion]", "motion", preferences.motion],
    ["#clock-segment [data-clock]", "clock", preferences.clock],
    ["#sendkey-segment [data-sendkey]", "sendkey", preferences.sendKey],
  ]) {
    for (const button of document.querySelectorAll(selector)) {
      button.classList.toggle("active", button.dataset[attribute] === current);
      if (attribute === "transport") {
        button.setAttribute("aria-checked", String(button.dataset.transport === current));
      }
    }
  }
  $("custom-accent").value = preferences.accent;
  const controls = [
    ["font", preferences.fontSize, " px"],
    ["scale", preferences.scale, "%"],
    ["radius", preferences.radius, " px"],
    ["bubble", preferences.bubbleRadius, " px"],
    ["width", preferences.messageWidth, "%"],
    ["blur", preferences.blur, " px"],
    ["opacity", preferences.panelOpacity, "%"],
    ["wallpaper", preferences.wallpaperIntensity, "%"],
    ["sidebar", preferences.sidebarWidth, " px"],
  ];
  for (const [name, value, suffix] of controls) {
    $(`${name}-range`).value = String(value);
    $(`${name}-value`).textContent = `${value}${suffix}`;
  }
  $("toggle-confirm-delete").classList.toggle("on", preferences.confirmDelete);
  $("toggle-voice-autoplay").classList.toggle("on", preferences.voiceAutoplay);
  $("auto-scale-toggle").classList.toggle("on", preferences.autoScale);
  $("notification-sound-toggle").classList.toggle("on", preferences.notificationSound);
  $("notification-size-range").value = String(preferences.notificationSize);
  $("notification-size-value").textContent = `${preferences.notificationSize}%`;
  for (const button of document.querySelectorAll("#notification-colors [data-notification-color]")) {
    button.classList.toggle("active", button.dataset.notificationColor === preferences.notificationColor);
  }
  for (const button of document.querySelectorAll("#notification-position [data-notification-position]")) {
    button.classList.toggle("active", button.dataset.notificationPosition === preferences.notificationPosition);
  }
  $("compact-toggle").classList.toggle("on", preferences.compact);
  $("square-toggle").classList.toggle("on", preferences.squareAvatars);
  $("tails-toggle").classList.toggle("on", preferences.tails);
}

/**
 * Сколько непрочитанного всего — в заголовок, на панель задач и в трей.
 *
 * Считаем по всем беседам сразу: человеку важно «есть ли что-то», а не в каком
 * именно чате. Зовётся из renderConversations — то есть отовсюду, где счётчики
 * меняются, и добавлять вызов к каждому событию не придётся.
 */
function syncUnread() {
  let total = 0;
  for (const entry of state.conversations.values()) total += entry.unread ?? 0;
  for (const group of state.groups.values()) total += group.unread ?? 0;
  if (total === syncUnread.last) return;
  syncUnread.last = total;
  invoke("set_unread", { count: total }).catch(() => {});
}

function syncWindowTitle() {
  $("window-title").textContent = settingsPage.classList.contains("hidden") ? "Obsidian" : "Obsidian — Настройки";
}

$("appearance-open").addEventListener("click", () => {
  settingsPage.classList.remove("hidden");
  syncWindowTitle();
});
$("appearance-close").addEventListener("click", () => {
  settingsPage.classList.add("hidden");
  syncWindowTitle();
});

for (const button of document.querySelectorAll("#theme-segment [data-theme]")) {
  button.addEventListener("click", () => {
    preferences.theme = button.dataset.theme;
    applyPreferences();
    savePreferences();
  });
}

for (const button of document.querySelectorAll(".settings-colors [data-color]")) {
  button.addEventListener("click", () => {
    preferences.accent = button.dataset.color;
    preferences.accentText = button.dataset.text;
    applyPreferences();
    savePreferences();
  });
}

for (const button of document.querySelectorAll("#divider-segment [data-dividers]")) {
  button.addEventListener("click", () => {
    preferences.dividers = button.dataset.dividers;
    applyPreferences();
    savePreferences();
  });
}

$("custom-accent").addEventListener("input", (event) => {
  preferences.accent = event.target.value;
  preferences.accentText = accentTextFor(preferences.accent);
  applyPreferences();
  savePreferences();
});

/**
 * Переключатели «одна кнопка — одно значение». Все устроены одинаково, поэтому
 * и заводятся одинаково: отдельный обработчик на каждый набор означал бы шесть
 * копий одного и того же кода.
 */
for (const [selector, attribute, property] of [
  ["#wallpaper-grid [data-wallpaper]", "wallpaper", "wallpaper"],
  ["#font-segment [data-font]", "font", "uiFont"],
  ["#motion-segment [data-motion]", "motion", "motion"],
  ["#clock-segment [data-clock]", "clock", "clock"],
  ["#sendkey-segment [data-sendkey]", "sendkey", "sendKey"],
]) {
  for (const button of document.querySelectorAll(selector)) {
    button.addEventListener("click", () => {
      preferences[property] = button.dataset[attribute];
      applyPreferences();
      savePreferences();
      // Время подписано в уже собранных пузырях: чтобы формат сменился и в
      // открытой переписке, кэш приходится собрать заново.
      if (property === "clock") rebuildHistory();
    });
  }
}

$("tails-toggle").addEventListener("click", () => {
  preferences.tails = !preferences.tails;
  applyPreferences();
  savePreferences();
});

$("auto-scale-toggle").addEventListener("click", () => {
  preferences.autoScale = !preferences.autoScale;
  applyPreferences();
  savePreferences();
});

$("notification-size-range").addEventListener("input", (event) => {
  preferences.notificationSize = Number(event.target.value);
  applyPreferences();
  savePreferences();
});

for (const button of document.querySelectorAll("#notification-colors [data-notification-color]")) {
  button.addEventListener("click", () => {
    preferences.notificationColor = button.dataset.notificationColor;
    applyPreferences();
    savePreferences();
  });
}

for (const button of document.querySelectorAll("#notification-position [data-notification-position]")) {
  button.addEventListener("click", () => {
    preferences.notificationPosition = button.dataset.notificationPosition;
    applyPreferences();
renderAutostart();
    savePreferences();
  });
}

/*
  Автозапуск.

  Состояние спрашиваем у системы, а не храним в своих настройках: ключ реестра
  человек может убрать чем угодно — чистильщиком, руками, другой сборкой, — и
  наша галочка тогда показывала бы то, чего нет.
*/
async function renderAutostart() {
  const on = await invoke("autostart_enabled").catch(() => false);
  $("autostart-toggle").classList.toggle("on", Boolean(on));
}

$("autostart-toggle").addEventListener("click", async () => {
  const button = $("autostart-toggle");
  const next = !button.classList.contains("on");
  button.disabled = true;
  try {
    await invoke("set_autostart", { enabled: next });
  } catch (error) {
    toast(`Автозапуск: ${error}`);
  } finally {
    button.disabled = false;
    // Перечитываем, а не верим себе: если реестр отказал, галочка обязана
    // вернуться туда, где была.
    renderAutostart();
  }
});

$("notification-sound-toggle").addEventListener("click", () => {
  preferences.notificationSound = !preferences.notificationSound;
  applyPreferences();
  savePreferences();
});

$("notification-test").addEventListener("click", () => {
  showDesktopNotification({ title: "Obsidian", text: "Так будет выглядеть новое сообщение" });
});

/** Сбрасывает собранные пузыри, оставляя список бесед на месте. */
function rebuildHistory() {
  const open = conversationOf(state.current);
  history.clear();
  if (open) {
    $("messages").replaceChildren();
    loadOlder(open);
  }
}

for (const [name, property] of [
  ["font", "fontSize"], ["scale", "scale"], ["radius", "radius"], ["bubble", "bubbleRadius"],
  ["width", "messageWidth"], ["blur", "blur"], ["opacity", "panelOpacity"],
  ["wallpaper", "wallpaperIntensity"], ["sidebar", "sidebarWidth"],
]) {
  $(`${name}-range`).addEventListener("input", (event) => {
    preferences[property] = Number(event.target.value);
    applyPreferences();
    savePreferences();
  });
}

for (const [id, key] of [["toggle-confirm-delete", "confirmDelete"],
                         ["toggle-voice-autoplay", "voiceAutoplay"]]) {
  $(id).addEventListener("click", () => {
    preferences[key] = !preferences[key];
    applyPreferences();
    savePreferences();
  });
}

$("compact-toggle").addEventListener("click", () => {
  preferences.compact = !preferences.compact;
  applyPreferences();
  savePreferences();
});
$("square-toggle").addEventListener("click", () => {
  preferences.squareAvatars = !preferences.squareAvatars;
  applyPreferences();
  savePreferences();
});
$("settings-reset").addEventListener("click", () => {
  preferences = { ...preferenceDefaults };
  applyPreferences();
  savePreferences();
  toast("Оформление сброшено");
});
applyPreferences();

/*
  Вставка картинки из буфера.

  Слушаем на документе, а не на поле ввода: снимок экрана делают и вставляют не
  целясь курсором, и требовать сперва щёлкнуть по полю — лишний шаг там, где
  его никто не ждёт. Если в буфере текст, обработчик молча уходит и вставка
  идёт как обычно.
*/
/*
  Щелчок по уведомлению открывает беседу.

  Окно к этому моменту уже поднято командой в Rust: событие только выбирает
  беседу. Если её ещё нет в списке — заводим, иначе уведомление о первом
  сообщении от нового собеседника вело бы в пустоту.
*/
listen("obsidian:open-chat", ({ payload }) => {
  const peer = typeof payload === "string" ? payload : payload?.device;
  if (!peer) return;
  if (!state.conversations.has(peer) && !isGroupKey(peer)) {
    state.conversations.set(peer, { conversation: null, unread: 0 });
    renderConversations();
  }
  selectConversation(peer);
});

document.addEventListener("paste", (event) => {
  // В настройках и модальных окнах вставлять картинку в переписку не нужно.
  if (!settingsPage.classList.contains("hidden")) return;
  if (document.querySelector(".modal:not(.hidden)")) return;
  if (!state.current) return;

  const file = [...(event.clipboardData?.items ?? [])]
    .find((item) => item.kind === "file" && item.type.startsWith("image/"))
    ?.getAsFile();
  if (!file) return;

  event.preventDefault();
  // Тот же редактор, что и у кнопки: вставка не должна быть вторым путём
  // отправки со своими правилами сжатия и своим качеством.
  openEditor(file, "message");
});

document.addEventListener("keydown", (event) => {
  // Ctrl+Z возвращает последнее удалённое. В поле ввода не перехватываем:
  // там та же комбинация отменяет набор текста, и это ожидаемее.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    if (inTextField(event.target)) return;
    if (undoLast()) event.preventDefault();
    return;
  }

  if (event.key !== "Escape") return;
  // Закрываем по одному слою за нажатие: Escape в открытом окне исключений не
  // должен заодно захлопывать и настройки под ним.
  if (emojiPanel) return closeEmoji();
  if (!$("chat-search").classList.contains("hidden")) {
    $("chat-search").classList.add("hidden");
    return closeSearch();
  }
  if (editing) return cancelEdit();
  if (!$("exceptions-modal").classList.contains("hidden")) return closeExceptions();
  if (!$("photo-editor").classList.contains("hidden")) return closeEditor();
  settingsPage.classList.add("hidden");
  syncWindowTitle();
  $("verification").classList.add("hidden");
});

boot();

// --- редактор фото -----------------------------------------------------------

/**
 * Правка снимка перед отправкой: кадр, поворот, отражение, тон.
 *
 * Всё считается на месте, в canvas. Исходник никуда не уходит и нигде не
 * остаётся: наружу выходит только пережатый JPEG, который и попадает в
 * шифрованное сообщение. Метаданные снимка — EXIF с геопозицией, моделью
 * камеры и временем — при этом теряются. Это не побочный эффект, а одна из
 * причин гнать фотографию через canvas, а не отправлять файл как есть.
 */
const editor = {
  /** Исходник, уже повёрнутый и отражённый, в рабочем разрешении. */
  work: null,
  /** Кадр в координатах `work`. */
  crop: null,
  rotation: 0,
  flipped: false,
  ratio: 0,
  source: null,
  /** Куда уедет результат: в переписку или в аватар. */
  target: "message",
  /** Размер холста на экране — для перевода координат рамки. */
  view: { width: 0, height: 0 },
};

/** Длинная сторона рабочего изображения. Больше в переписке не нужно. */
const WORK_MAX_SIDE = 1600;
/** Потолок base64 у фотографии в сообщении. */
const PHOTO_MAX_BASE64 = 700000;
/** У аватара свой потолок: сервер принимает не больше 256 КиБ после декода. */
const AVATAR_MAX_BASE64 = 340000;
/** Минимальная сторона кадра: меньше уже не кадрирование, а промах. */
const MIN_CROP = 48;

function debounce(fn, ms) {
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function filterString() {
  const value = (id) => Number($(id).value);
  return `brightness(${value("editor-brightness")}%) contrast(${value("editor-contrast")}%) `
    + `saturate(${value("editor-saturation")}%)`;
}

/** Пересобирает `work` из исходника с учётом поворота и отражения. */
function rebuildWork() {
  const bitmap = editor.source;
  const swapped = editor.rotation % 180 !== 0;
  const sourceWidth = swapped ? bitmap.height : bitmap.width;
  const sourceHeight = swapped ? bitmap.width : bitmap.height;

  const scale = Math.min(1, WORK_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  ctx.translate(width / 2, height / 2);
  ctx.rotate((editor.rotation * Math.PI) / 180);
  if (editor.flipped) ctx.scale(-1, 1);
  const drawWidth = swapped ? height : width;
  const drawHeight = swapped ? width : height;
  ctx.drawImage(bitmap, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

  editor.work = canvas;
}

/** Кадр по умолчанию: всё изображение, подрезанное под выбранное соотношение. */
function resetCrop() {
  const { width, height } = editor.work;
  if (!editor.ratio) {
    editor.crop = { x: 0, y: 0, width, height };
    return;
  }
  let cropWidth = width;
  let cropHeight = width / editor.ratio;
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = height * editor.ratio;
  }
  editor.crop = {
    x: (width - cropWidth) / 2,
    y: (height - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight,
  };
}

function drawEditor() {
  const canvas = $("editor-canvas");
  const stage = $("editor-stage");
  const work = editor.work;

  // Холст показываем вписанным в сцену явным масштабом, а не «как ляжет по
  // CSS»: рамка кадра живёт в этих же координатах, и без известного масштаба
  // её нечем переводить в пиксели изображения.
  const maxWidth = Math.max(120, stage.clientWidth - 2);
  const maxHeight = Math.max(160, Math.round(window.innerHeight * 0.46));
  const scale = Math.min(maxWidth / work.width, maxHeight / work.height, 1);
  const width = Math.max(1, Math.round(work.width * scale));
  const height = Math.max(1, Math.round(work.height * scale));

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.filter = filterString();
  ctx.drawImage(work, 0, 0, width, height);
  editor.view = { width, height };

  positionCrop();
  updateEstimate();
}

function positionCrop() {
  const box = $("editor-crop");
  const canvas = $("editor-canvas");
  const scale = editor.view.width / editor.work.width;

  box.style.left = `${canvas.offsetLeft + editor.crop.x * scale}px`;
  box.style.top = `${canvas.offsetTop + editor.crop.y * scale}px`;
  box.style.width = `${editor.crop.width * scale}px`;
  box.style.height = `${editor.crop.height * scale}px`;
}

/** Итоговый JPEG. Качество снижается, пока результат не влезет в лимит. */
function renderPhoto(maxBase64, startQuality) {
  const crop = editor.crop;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width));
  canvas.height = Math.max(1, Math.round(crop.height));

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.filter = filterString();
  ctx.drawImage(editor.work, crop.x, crop.y, crop.width, crop.height,
    0, 0, canvas.width, canvas.height);

  let quality = startQuality;
  let data = "";
  do {
    data = canvas.toDataURL("image/jpeg", quality).split(",")[1];
    quality -= 0.1;
  } while (data.length > maxBase64 && quality >= 0.4);

  return { data, width: canvas.width, height: canvas.height, tooBig: data.length > maxBase64 };
}

function editorLimit() {
  return editor.target === "avatar" || editor.target === "channel-icon"
    ? AVATAR_MAX_BASE64 : PHOTO_MAX_BASE64;
}

/** Показывает вес результата: иначе «слишком большое» прилетает уже при отправке. */
function updateEstimate() {
  const { data, width, height, tooBig } = renderPhoto(editorLimit(), Number($("editor-quality").value) / 100);
  const kb = Math.round((data.length * 0.75) / 1024);
  $("editor-size").textContent = tooBig
    ? "не помещается — уменьшите кадр"
    : `${width}×${height} · ${kb} КБ`;
  $("editor-send").disabled = tooBig;
}

const scheduleEstimate = debounce(updateEstimate, 160);

function syncEditorOutputs() {
  $("editor-brightness-value").textContent = `${$("editor-brightness").value}%`;
  $("editor-contrast-value").textContent = `${$("editor-contrast").value}%`;
  $("editor-saturation-value").textContent = `${$("editor-saturation").value}%`;
  $("editor-quality-value").textContent = $("editor-quality").value;
}

async function openEditor(file, target) {
  try {
    editor.source = await createImageBitmap(file);
  } catch {
    toast("Не удалось прочитать изображение");
    return;
  }
  editor.target = target;
  editor.rotation = 0;
  editor.flipped = false;
  const square = target === "avatar" || target === "channel-icon";
  editor.ratio = square ? 1 : 0;

  for (const input of ["editor-brightness", "editor-contrast", "editor-saturation"]) {
    $(input).value = "100";
  }
  $("editor-quality").value = square ? "86" : "82";
  syncEditorOutputs();
  $("editor-caption").value = "";
  $("editor-caption").classList.toggle("hidden", square);
  $("editor-title").textContent = target === "avatar" ? "Аватар"
    : target === "channel-icon" ? "Значок канала" : "Фото";
  // У аватара кадр всегда квадратный — выбор соотношения только запутывал бы.
  $("editor-ratios").classList.toggle("hidden", square);
  for (const button of $("editor-ratios").querySelectorAll("button")) {
    button.classList.toggle("active", Number(button.dataset.ratio) === editor.ratio);
  }

  rebuildWork();
  resetCrop();
  $("photo-editor").classList.remove("hidden");
  drawEditor();
}

function closeEditor() {
  $("photo-editor").classList.add("hidden");
  editor.source?.close?.();
  editor.source = null;
  editor.work = null;
}

// --- перетаскивание рамки -----------------------------------------------------

/**
 * Тянем углы и саму рамку указателем.
 *
 * Pointer events, а не mouse: они одинаково работают с мышью, пером и
 * тачпадом, а слушатели на window не теряют жест, если курсор ушёл за край
 * рамки, — без этого она залипала бы в последнем положении.
 */
$("editor-crop").addEventListener("pointerdown", (event) => {
  const handle = event.target.dataset ? event.target.dataset.handle : null;
  const scale = editor.view.width / editor.work.width;
  // Точка начала жеста и исходный кадр — раздельно. В одном объекте поля `x` и
  // `y` у них называются одинаково, и кадр затирал бы позицию указателя: жест
  // считался бы от угла картинки, а рамка дёргалась бы к краю вместо того,
  // чтобы следовать за курсором.
  const origin = { x: event.clientX, y: event.clientY };
  const start = { ...editor.crop };
  event.preventDefault();

  const onMove = (move) => {
    const dx = (move.clientX - origin.x) / scale;
    const dy = (move.clientY - origin.y) / scale;
    editor.crop = handle ? resizeCrop(start, handle, dx, dy) : moveCrop(start, dx, dy);
    positionCrop();
    scheduleEstimate();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
});

function moveCrop(start, dx, dy) {
  const { width, height } = editor.work;
  return {
    x: clamp(start.x + dx, 0, width - start.width),
    y: clamp(start.y + dy, 0, height - start.height),
    width: start.width,
    height: start.height,
  };
}

function resizeCrop(start, handle, dx, dy) {
  const { width: maxWidth, height: maxHeight } = editor.work;
  let { x, y, width, height } = start;

  if (handle.includes("w")) {
    const nx = clamp(start.x + dx, 0, start.x + start.width - MIN_CROP);
    width = start.x + start.width - nx;
    x = nx;
  } else {
    width = clamp(start.width + dx, MIN_CROP, maxWidth - start.x);
  }

  if (handle.includes("n")) {
    const ny = clamp(start.y + dy, 0, start.y + start.height - MIN_CROP);
    height = start.y + start.height - ny;
    y = ny;
  } else {
    height = clamp(start.height + dy, MIN_CROP, maxHeight - start.y);
  }

  if (editor.ratio) {
    // Соотношение ведёт ширина; высота подстраивается и, если упёрлась в край,
    // тянет ширину обратно — иначе рамка вылезала бы за изображение.
    height = width / editor.ratio;
    if (y + height > maxHeight) {
      height = maxHeight - y;
      width = height * editor.ratio;
    }
    if (handle.includes("n")) y = start.y + start.height - height;
    if (handle.includes("w")) x = start.x + start.width - width;
  }

  return {
    x: clamp(x, 0, maxWidth - width),
    y: clamp(y, 0, maxHeight - height),
    width,
    height,
  };
}

// --- органы управления --------------------------------------------------------

$("editor-close").addEventListener("click", closeEditor);
$("photo-editor").addEventListener("click", (event) => {
  if (event.target === $("photo-editor")) closeEditor();
});

$("editor-rotate").addEventListener("click", () => {
  editor.rotation = (editor.rotation + 90) % 360;
  rebuildWork();
  resetCrop();
  drawEditor();
});

$("editor-flip").addEventListener("click", () => {
  editor.flipped = !editor.flipped;
  rebuildWork();
  drawEditor();
});

$("editor-reset").addEventListener("click", () => {
  editor.rotation = 0;
  editor.flipped = false;
  for (const input of ["editor-brightness", "editor-contrast", "editor-saturation"]) {
    $(input).value = "100";
  }
  syncEditorOutputs();
  rebuildWork();
  resetCrop();
  drawEditor();
});

for (const button of $("editor-ratios").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    editor.ratio = Number(button.dataset.ratio);
    for (const other of $("editor-ratios").querySelectorAll("button")) {
      other.classList.toggle("active", other === button);
    }
    resetCrop();
    positionCrop();
    updateEstimate();
  });
}

for (const id of ["editor-brightness", "editor-contrast", "editor-saturation", "editor-quality"]) {
  $(id).addEventListener("input", () => {
    syncEditorOutputs();
    if (id === "editor-quality") scheduleEstimate();
    else drawEditor();
  });
}

$("editor-send").addEventListener("click", async () => {
  const quality = Number($("editor-quality").value) / 100;

  if (editor.target === "channel-icon") {
    const { data, tooBig } = renderPhoto(AVATAR_MAX_BASE64, quality);
    if (tooBig) {
      toast("Значок не помещается — уменьшите кадр");
      return;
    }
    closeEditor();
    await submit({
      type: "channel_update",
      channel: openChannel,
      icon: { mime: "image/jpeg", base64: data },
    });
    toast("Значок канала загружается…");
    return;
  }

  if (editor.target === "avatar") {
    const { data, tooBig } = renderPhoto(AVATAR_MAX_BASE64, quality);
    if (tooBig) {
      toast("Аватар не помещается — уменьшите кадр");
      return;
    }
    closeEditor();
    await submit({ type: "profile_set", avatar_mime: "image/jpeg", avatar_base64: data });
    toast("Аватар загружается…");
    return;
  }

  const peer = state.current;
  if (!peer) {
    closeEditor();
    return;
  }
  const { data, width, height, tooBig } = renderPhoto(PHOTO_MAX_BASE64, quality);
  if (tooBig) {
    toast("Фото не помещается — уменьшите кадр");
    return;
  }

  const caption = $("editor-caption").value.trim();
  closeEditor();

  const content = { type: "image", id: logicalId(), mime: "image/jpeg", data, width, height };
  if (caption) content.caption = caption;
  const body = encodeContent(content);
  if (await submit({ type: "send", recipient_device: peer, body })) {
    appendMessage({ outgoing: true, body, created_at: Date.now() }, conversationOf(peer));
  }
});

// --- настройки: категории ------------------------------------------------------

for (const button of document.querySelectorAll("#settings-nav button[data-section]")) {
  button.addEventListener("click", () => openSettingsSection(button.dataset.section));
}

for (const button of document.querySelectorAll("#transport-segment [data-transport]")) {
  button.addEventListener("click", () => {
    const mode = button.dataset.transport;
    if (!SERVER_URLS[mode] || mode === preferences.transport) return;
    preferences.transport = mode;
    savePreferences();
    applyPreferences();
    submit({ type: "disconnect" });
    window.setTimeout(() => submit({ type: "connect", url: serverUrl() }), 250);
    toast(mode === "onion" ? "Подключаемся через Tor…"
      : mode === "auto" ? "Выбираем доступный маршрут…" : "Меняем маршрут…");
  });
}

function openSettingsSection(name) {
  for (const button of document.querySelectorAll("#settings-nav button[data-section]")) {
    button.classList.toggle("active", button.dataset.section === name);
  }
  for (const section of document.querySelectorAll(".settings-section")) {
    section.classList.toggle("hidden", section.dataset.section !== name);
  }
  $("settings-content").scrollTop = 0;
  // Числа спрашиваем при открытии раздела: держать их свежими всё время —
  // значит опрашивать базу впустую.
  if (name === "data") submit({ type: "storage" });
}

// --- приватность ---------------------------------------------------------------

/**
 * Описание правил, а не пятнадцать отдельных обработчиков.
 *
 * Экран собирается из этого списка, поэтому новое правило добавляется здесь и в
 * `privacy.rs` — и больше нигде. `scopes` перечисляет круги, которые вообще
 * имеют смысл для этого правила: у превью ссылок «одобренные» лишние, а у
 * последней активности лишние и они, и «одобренные».
 */
const PRIVACY_GROUPS = [
  {
    title: "Кто может обращаться",
    rules: [
      {
        key: "direct_messages",
        label: "Личные сообщения",
        hint: "Кто может вам написать. Проверяет сервер: постороннему конверт не "
          + "поставят в очередь вовсе. Тем, кому вы разрешили, пропуска выдаются "
          + "сами при следующем подключении — включение настройки никого не отрезает.",
        scopes: ["everyone", "approved", "contacts", "nobody"],
      },
    ],
  },
  {
    title: "Что мне можно присылать",
    rules: [
      { key: "media", label: "Фото и видео", hint: "Вложения от незнакомых людей не будут показаны и сохранены." },
      { key: "voice", label: "Голосовые сообщения", hint: "" },
      { key: "files", label: "Файлы", hint: "" },
      { key: "calls", label: "Звонки", hint: "Звонков пока нет; правило начнёт действовать вместе с ними." },
      {
        key: "link_previews",
        label: "Превью ссылок",
        hint: "Чтобы показать превью, нужно сходить на чужой сайт — и он увидит, что ссылку открыли именно вы. Поэтому по умолчанию выключено.",
        scopes: ["everyone", "contacts", "nobody"],
      },
    ],
  },
  {
    title: "Что видно обо мне",
    rules: [
      { key: "presence", label: "Сейчас в сети", hint: "", scopes: ["everyone", "contacts", "nobody"] },
      {
        key: "last_seen",
        label: "Последняя активность",
        hint: "По времени появления восстанавливают распорядок дня. По умолчанию — никому.",
        scopes: ["everyone", "contacts", "nobody"],
      },
      {
        key: "read_receipts",
        label: "Отчёты о прочтении",
        hint: "Если выключить, собеседник по-прежнему видит «отправлено», но не «прочитано».",
        scopes: ["everyone", "contacts", "nobody"],
      },
      { key: "typing", label: "Индикатор набора текста", hint: "", scopes: ["everyone", "contacts", "nobody"] },
      { key: "voice_recording_hint", label: "Показывать запись голосового", hint: "", scopes: ["everyone", "contacts", "nobody"] },
    ],
  },
  {
    title: "Профиль и поиск",
    rules: [
      {
        key: "discoverable",
        label: "Поиск по юзернейму",
        hint: "«Никто» — сервер не отдаёт вас в поиске совсем: для ищущего вы неотличимы "
          + "от несуществующего имени. Промежуточного варианта здесь нет: поиск идёт на "
          + "стороне ищущего, и отличить вашего контакта от постороннего в этот момент нечем.",
        scopes: ["everyone", "nobody"],
      },
      { key: "profile_avatar", label: "Аватар", hint: "", scopes: ["everyone", "contacts", "nobody"] },
      { key: "profile_name", label: "Имя профиля", hint: "", scopes: ["everyone", "contacts", "nobody"] },
      { key: "profile_username", label: "Юзернейм", hint: "", scopes: ["everyone", "contacts", "nobody"] },
    ],
  },
];

const SCOPE_LABELS = {
  everyone: "Все",
  approved: "Одобренные",
  contacts: "Контакты",
  nobody: "Никто",
};

const DEFAULT_SCOPES = ["everyone", "approved", "contacts", "nobody"];

/**
 * Правила, которые сервер пока не проверяет.
 *
 * Список повторяет `Privacy::server_enforced` в ядре. Дублируется намеренно:
 * интерфейс обязан подписать такое правило честно даже до того, как ядро
 * ответит, — а обещать защиту, которой нет, нельзя.
 */
const CLIENT_ONLY_RULES = new Set();

const CLIENT_ONLY_NOTE = "Проверяется на этом устройстве. Сервер о правиле пока не знает: "
  + "сообщение всё равно доедет, но показано не будет.";

/** Текущий документ правил. Приходит из ядра, туда же и уезжает. */
let privacy = null;

/** Какая группа правил открыта. Пятнадцать правил одним списком не читаются. */
let privacyTab = 0;

function renderPrivacyTabs() {
  const host = $("privacy-tabs");
  host.replaceChildren();
  PRIVACY_GROUPS.forEach((group, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.textContent = group.title;
    button.classList.toggle("active", index === privacyTab);
    button.setAttribute("aria-selected", String(index === privacyTab));
    button.addEventListener("click", () => {
      privacyTab = index;
      renderPrivacyTabs();
      renderPrivacy();
    });
    host.appendChild(button);
  });
}

function renderPrivacy() {
  const host = $("privacy-groups");
  host.replaceChildren();
  if (!privacy) return;
  if ($("privacy-tabs").childElementCount === 0) renderPrivacyTabs();

  for (const [index, group] of PRIVACY_GROUPS.entries()) {
    if (index !== privacyTab) continue;
    const block = document.createElement("div");
    block.className = "privacy-group";

    const card = document.createElement("div");
    card.className = "settings-card";
    for (const rule of group.rules) card.appendChild(privacyRow(rule));
    block.appendChild(card);
    host.appendChild(block);
  }
}

function privacyRow(spec) {
  const current = privacy[spec.key];
  const row = document.createElement("div");
  row.className = "privacy-rule";

  const label = document.createElement("b");
  label.textContent = spec.label;
  row.appendChild(label);

  if (spec.hint) {
    const hint = document.createElement("small");
    hint.textContent = spec.hint;
    row.appendChild(hint);
  }

  const scopes = document.createElement("div");
  scopes.className = "privacy-scopes";
  scopes.setAttribute("role", "group");
  scopes.setAttribute("aria-label", spec.label);
  for (const scope of spec.scopes ?? DEFAULT_SCOPES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = SCOPE_LABELS[scope];
    button.classList.toggle("active", current.scope === scope);
    button.setAttribute("aria-pressed", String(current.scope === scope));
    button.addEventListener("click", () => {
      privacy[spec.key].scope = scope;
      savePrivacy();
      // Видимость в поиске хранится и на сервере — иначе настройка осталась бы
      // записью в локальной базе и ничего не меняла.
      if (spec.key === "discoverable" && state.username) {
        submit({ type: "username_set", name: state.username, discoverable: scope !== "nobody" });
      }
      // «Все» — дверь открыта; любой другой круг сервер проверяет пропусками.
      if (spec.key === "direct_messages") {
        submit({ type: "access_set", policy: scope === "everyone" ? "everyone" : "passes" });
      }
      // Обновляем только этот переключатель. Полная перерисовка списка
      // сбрасывала бы фокус в его начало, и пройти настройки с клавиатуры было
      // бы нельзя: каждый выбор возвращал бы к первому правилу.
      for (const sibling of scopes.querySelectorAll("button")) {
        const chosen = sibling === button;
        sibling.classList.toggle("active", chosen);
        sibling.setAttribute("aria-pressed", String(chosen));
      }
      button.focus();
    });
    scopes.appendChild(button);
  }
  row.appendChild(scopes);

  if (CLIENT_ONLY_RULES.has(spec.key)) {
    const note = document.createElement("p");
    note.className = "privacy-note";
    note.textContent = CLIENT_ONLY_NOTE;
    row.appendChild(note);
  }

  const foot = document.createElement("div");
  foot.className = "privacy-foot";

  const counts = document.createElement("span");
  counts.className = "privacy-counts";
  counts.textContent = exceptionSummary(current);
  foot.appendChild(counts);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "ghost-button";
  open.textContent = "Исключения";
  open.addEventListener("click", () => openExceptions(spec));
  foot.appendChild(open);

  row.appendChild(foot);
  return row;
}

/** Освежает только подписи об исключениях — разметку не трогает. */
function updatePrivacyCounts() {
  if (!privacy) return;
  const specs = PRIVACY_GROUPS[privacyTab]?.rules ?? [];
  const rows = document.querySelectorAll("#privacy-groups .privacy-rule");
  rows.forEach((row, index) => {
    const spec = specs[index];
    if (!spec) return;
    const counts = row.querySelector(".privacy-counts");
    if (counts) counts.textContent = exceptionSummary(privacy[spec.key]);
  });
}

function exceptionSummary(rule) {
  const parts = [];
  if (rule.allow.length) parts.push(`всегда разрешено: ${rule.allow.length}`);
  if (rule.deny.length) parts.push(`никогда: ${rule.deny.length}`);
  return parts.length ? parts.join(" · ") : "исключений нет";
}

// --- окно исключений -----------------------------------------------------------

let exceptionsFor = null;

/**
 * Собеседники выбираются из списка, а не вводятся строкой.
 *
 * Ключ устройства — 64 символа шестнадцатеричного текста; правило, набранное
 * руками с опечаткой, молча не сработало бы и выглядело бы как работающее.
 */
function openExceptions(spec) {
  exceptionsFor = spec;
  $("exceptions-title").textContent = spec.label;
  $("exceptions-hint").textContent =
    "Запрет сильнее разрешения, а разрешение сильнее выбранного круга.";
  renderExceptions();
  $("exceptions-modal").classList.remove("hidden");
  $("exceptions-close").focus();
}

function renderExceptions() {
  const host = $("exceptions-list");
  host.replaceChildren();
  const rule = privacy[exceptionsFor.key];

  // Показываем всех, о ком вообще знаем, плюс тех, кто уже упомянут в правиле,
  // — иначе снять исключение с удалённого диалога было бы нечем.
  const peers = new Set([...state.conversations.keys(), ...rule.allow, ...rule.deny]);
  if (peers.size === 0) {
    const empty = document.createElement("p");
    empty.className = "exceptions-empty";
    empty.textContent = "Пока некого добавить: список появится вместе с диалогами.";
    host.appendChild(empty);
    return;
  }

  for (const peer of peers) {
    const row = document.createElement("div");
    row.className = "exception-row";

    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar";
    applyAvatar(avatar, peer);
    row.appendChild(avatar);

    const copy = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = displayName(peer);
    const address = document.createElement("small");
    address.textContent = short(peer);
    copy.append(name, address);
    row.appendChild(copy);

    const choice = document.createElement("div");
    choice.className = "exception-choice";
    const currently = rule.deny.includes(peer) ? "deny" : rule.allow.includes(peer) ? "allow" : "none";
    for (const [value, caption] of [["allow", "Всегда"], ["none", "По кругу"], ["deny", "Никогда"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.choice = value;
      button.textContent = caption;
      button.classList.toggle("active", currently === value);
      button.setAttribute("aria-pressed", String(currently === value));
      button.addEventListener("click", () => {
        setException(rule, peer, value);
        savePrivacy();
        // Обновляем только эту строку. Полная перерисовка сбрасывала бы фокус
        // на первый элемент списка, и пройти исключения с клавиатуры было бы
        // нельзя: каждый выбор возвращал бы в начало.
        for (const sibling of choice.querySelectorAll("button")) {
          const chosen = sibling.dataset.choice === value;
          sibling.classList.toggle("active", chosen);
          sibling.setAttribute("aria-pressed", String(chosen));
        }
        button.focus();
        updatePrivacyCounts();
      });
      choice.appendChild(button);
    }
    row.appendChild(choice);
    host.appendChild(row);
  }
}

function setException(rule, peer, choice) {
  rule.allow = rule.allow.filter((entry) => entry !== peer);
  rule.deny = rule.deny.filter((entry) => entry !== peer);
  if (choice === "allow") rule.allow.push(peer);
  if (choice === "deny") rule.deny.push(peer);
}

$("exceptions-close").addEventListener("click", closeExceptions);
$("exceptions-modal").addEventListener("click", (event) => {
  if (event.target === $("exceptions-modal")) closeExceptions();
});

function closeExceptions() {
  $("exceptions-modal").classList.add("hidden");
  exceptionsFor = null;
}

/**
 * Правила уезжают целиком: экран всё равно держит весь набор.
 *
 * Ядро отвечает на запись тем же документом. Флаг помечает этот ответ как свой,
 * чтобы не перерисовывать по нему открытый экран: перерисовка тут же убивала бы
 * фокус на кнопке, которую человек только что нажал.
 */
let ownEcho = false;

function savePrivacy() {
  ownEcho = true;
  submit({ type: "privacy_set", privacy });
}

// --- прочее по разделам --------------------------------------------------------

function renderStorage(event) {
  const size = (bytes) => bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  $("storage-report").textContent = `База: ${size(event.database_bytes ?? 0)}\n`
    + `Переписок: ${event.conversations ?? 0}\n`
    + `Сообщений: ${event.messages ?? 0}`;
}

$("storage-refresh").addEventListener("click", () => submit({ type: "storage" }));

$("wipe-conversations").addEventListener("click", () => {
  confirmAction(
    "Стереть все переписки?",
    "История всех бесед исчезнет с этого устройства. У собеседников их копии останутся: они нам не принадлежат. Отменить это нечем.",
    () => {
      for (const [, entry] of state.conversations) {
        if (entry.conversation) {
          submit({ type: "delete_conversation", conversation: entry.conversation });
        }
      }
      submit({ type: "storage" });
    },
  );
});

$("data-path").addEventListener("click", () => {
  toast("База лежит в каталоге данных приложения и открывается только паролем этого устройства");
});

// --- юзернейм ------------------------------------------------------------------

/**
 * Юзернейм — слой поиска, а не личность.
 *
 * Его можно занять, сменить и освободить; на проверку ключей он не влияет
 * никак. На сервер уезжает только хеш имени: поиск точный, поэтому большего
 * серверу и не нужно.
 */
$("username-save").addEventListener("click", () => {
  const name = $("username-input").value.trim().replace(/^@/, "");
  if (!name) return usernameStatus("Введите имя: латиница, цифры и подчёркивание, от 3 до 20 символов.");
  usernameStatus("Занимаем…");
  submit({ type: "username_set", name, discoverable: privacy?.discoverable?.scope !== "nobody" });
});

$("username-clear").addEventListener("click", () => {
  if (!state.username) return usernameStatus("Юзернейм не занят.");
  usernameStatus("Освобождаем…");
  submit({ type: "username_clear" });
});

$("username-copy").addEventListener("click", () => {
  if (!state.username) return usernameStatus("Сначала займите имя.");
  copyText(`@${state.username}`, "Юзернейм скопирован");
});

function renderDecor() {
  const emblems = $("emblem-grid");
  emblems.replaceChildren();
  for (const [key, glyph] of EMBLEMS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = key === "none" ? "∅" : glyph;
    button.title = key;
    button.classList.toggle("active", (state.emblem ?? "none") === key);
    button.disabled = state.decorSupported === false;
    button.addEventListener("click", () => {
      state.emblem = key;
      submit({ type: "profile_decor", emblem: key });
      renderDecor();
    });
    emblems.appendChild(button);
  }

  const colors = $("color-grid");
  colors.replaceChildren();
  for (const [key, label, value] of PROFILE_COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.classList.toggle("active", (state.color ?? "none") === key);
    const dot = document.createElement("i");
    dot.style.setProperty("--swatch", value);
    button.appendChild(dot);
    button.disabled = state.decorSupported === false;
    button.addEventListener("click", () => {
      state.color = key;
      submit({ type: "profile_decor", color: key });
      renderDecor();
    });
    colors.appendChild(button);
  }

  const preview = $("profile-decor-preview");
  const previewColor = profileColor(state.color) || "var(--muted)";
  preview.style.setProperty("--decor-color", previewColor);
  preview.querySelector("span").textContent = state.username ? state.username.slice(0, 2).toUpperCase() : "ME";
  preview.querySelector("i").textContent = emblemGlyph(state.emblem);
}

// --- панель владельца сервера ---------------------------------------------------

const ADMIN_LABELS = {
  users: "Аккаунтов",
  devices: "Устройств",
  profiles: "Профилей",
  usernames: "Юзернеймов занято",
  recoveries: "Настроено восстановлений",
  blocked: "Заблокировано",
  queued: "В очереди доставки",
  seenDay: "Заходило за сутки",
};

/** С какого места списка показан текущий разворот. */
let adminOffset = 0;

function renderAdminUsers(report) {
  const host = $("admin-users");
  host.replaceChildren();
  const users = report.users ?? [];
  if (users.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty";
    empty.textContent = "Пока никого.";
    host.appendChild(empty);
  }

  for (const user of users) {
    const row = document.createElement("div");
    row.className = user.blocked ? "admin-user blocked" : "admin-user";

    const copy = document.createElement("div");
    const title = document.createElement("b");
    // Код чата — то, чем владелец узнаёт человека. Ключ личности показываем
    // сокращённо: полностью он нужен разве что для .env, и там его берут из
    // своего профиля.
    title.textContent = user.chatCode ?? "без кода";
    const details = document.createElement("small");
    const seen = user.lastSeen ? new Date(user.lastSeen).toLocaleString() : "не заходил";
    details.textContent = `устройств: ${user.devices} · заходил: ${seen}`
      + (user.hasUsername ? " · юзернейм занят" : "");
    const key = document.createElement("code");
    key.textContent = short(user.identity);
    key.title = user.identity;
    copy.append(title, details, key);

    const action = document.createElement("button");
    action.type = "button";
    action.className = user.blocked ? "ghost-button" : "ghost-button danger";
    action.textContent = user.blocked ? "Открыть вход" : "Закрыть вход";
    action.addEventListener("click", () => {
      const verb = user.blocked ? "unblock" : "block";
      const detail = user.blocked
        ? "Человек снова сможет входить на сервер."
        : "Человек перестанет входить на сервер. Переписки это не касается: она у собеседников на устройствах, и прочитать её нельзя.";
      confirmAction(user.blocked ? "Открыть вход?" : "Закрыть вход?", detail,
        () => submit({ type: "admin_action", action: verb, reference: user.identity }));
    });

    row.append(copy, action);
    host.appendChild(row);
  }

  adminOffset = report.offset ?? 0;
  $("admin-users-prev").disabled = adminOffset === 0;
  $("admin-users-next").disabled = !report.more;
}

function renderAdmin(report) {
  const host = $("admin-counts");
  host.replaceChildren();
  for (const [key, value] of Object.entries(report.counts ?? {})) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = ADMIN_LABELS[key] ?? key;
    const count = document.createElement("b");
    count.textContent = String(value);
    row.append(label, count);
    host.appendChild(row);
  }
  const online = document.createElement("div");
  const onlineLabel = document.createElement("span");
  onlineLabel.textContent = "Устройств на связи";
  const onlineValue = document.createElement("b");
  onlineValue.textContent = String(report.online ?? 0);
  online.append(onlineLabel, onlineValue);
  host.appendChild(online);

  renderAdminUsers(report);

  if (report.done) {
    $("admin-status").textContent = report.done === "block"
      ? "Вход закрыт." : "Вход открыт.";
    $("admin-reference").value = "";
  }
}

$("admin-users-prev").addEventListener("click", () => {
  submit({ type: "admin_get", offset: Math.max(0, adminOffset - 40) });
});
$("admin-users-next").addEventListener("click", () => {
  submit({ type: "admin_get", offset: adminOffset + 40 });
});

// Выбор значка и цвета рисуется сразу: ждать ответа сервера, чтобы показать
// список из двенадцати картинок, незачем.
renderDecor();
syncWindowTitle();

let scaleResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(scaleResizeTimer);
  scaleResizeTimer = setTimeout(() => {
    if (preferences.autoScale) applyPreferences();
  }, 120);
});

for (const [id, command] of [["window-minimize", "window_minimize"],
                            ["window-maximize", "window_toggle_maximize"],
                            ["window-close", "window_close"]]) {
  $(id).addEventListener("click", () => windowCommand(command));
}

// Явный drag нужен WebView2: после интерактивных элементов одного
// data-tauri-drag-region недостаточно для стабильного удержания.
document.querySelector(".titlebar").addEventListener("mousedown", (event) => {
  if (event.button === 0 && !event.target.closest(".titlebar-actions")) {
    windowCommand("window_drag");
  }
});

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

/*
  Проверка обновлений.

  Обновление предлагается только по подписанному манифесту. Сервер может
  назвать любую версию и любую ссылку — но подписать их нечем: ключ живёт
  офлайн и на сервере его нет. Не сошлась подпись — говорим прямо и ничего не
  предлагаем: молча вести человека за неподтверждённой сборкой хуже, чем не
  обновиться, потому что подменённый клиент обесценивает и шифрование, и
  замок, и всё остальное разом.
*/
async function checkForUpdates(showFailure = false) {
  const status = $("update-status");
  const download = $("update-download");
  appVersion = await invoke("app_version").catch(() => appVersion);
  if (status) status.textContent = `Версия ${appVersion} · проверяем обновления…`;

  try {
    const response = await fetch(RELEASES_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (typeof payload.manifest !== "string" || typeof payload.signature !== "string") {
      throw new Error("ответ без подписи");
    }
    const trusted = await invoke("verify_release", {
      manifest: payload.manifest,
      signature: payload.signature,
    });
    if (!trusted) throw new Error("подпись не сходится");

    const release = JSON.parse(payload.manifest).windows;
    const available = Boolean(release) && compareVersions(release.version, appVersion) > 0;
    if (status) {
      status.textContent = available
        ? `Доступна версия ${release.version}`
        : `Версия ${appVersion} · установлена последняя`;
    }
    if (download) {
      download.classList.toggle("hidden", !available);
      if (release?.url) download.dataset.url = release.url;
      if (release?.sha256) download.dataset.sha256 = release.sha256;
    }
    $("update-verify").classList.toggle("hidden", !available);
    $("update-hash").textContent = available ? `Ожидаемый SHA-256: ${release.sha256}` : "";
    if (available) toast(`Доступно обновление Obsidian ${release.version}`);
  } catch (error) {
    const reason = String(error?.message ?? error);
    if (status) status.textContent = `Версия ${appVersion} · не подтвердить: ${reason}`;
    if (showFailure) toast(`Обновления: ${reason}`);
    $("update-verify").classList.add("hidden");
    $("update-hash").textContent = "";
    download?.classList.add("hidden");
  }
}

/*
  Сверка скачанного файла.

  Скачивание идёт браузером, и подсунуть туда проверку мы не можем. Зато можем
  проверить то, что уже лежит на диске: человек указывает файл, окно считает
  SHA-256 и сравнивает с подписанным. Это и есть то место, где подпись
  превращается в защиту, а не в надпись.
*/
$("update-verify").addEventListener("click", () => $("update-file").click());

$("update-file").addEventListener("change", async () => {
  const file = $("update-file").files?.[0];
  $("update-file").value = "";
  if (!file) return;

  const expected = $("update-download").dataset.sha256;
  if (!expected) {
    toast("Сначала проверьте обновления");
    return;
  }
  $("update-hash").textContent = "Считаем хеш…";
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const actual = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const same = actual === expected;
    $("update-hash").textContent = same
      ? `Файл совпадает с подписанным: ${actual}`
      : `НЕ совпадает. Ожидали ${expected}, получили ${actual}`;
    toast(same ? "Файл подтверждён" : "Файл не тот — запускать нельзя");
  } catch (error) {
    $("update-hash").textContent = `Не удалось посчитать хеш: ${String(error)}`;
  }
});

$("update-check").addEventListener("click", () => checkForUpdates(true));
$("update-download").addEventListener("click", () =>
  windowCommand("open_update", { url: $("update-download").dataset.url }));
setTimeout(() => checkForUpdates(false), 1800);

// Края тянутся системной рамкой: она у окна осталась, даже когда перестала
// рисоваться. Свои полоски поверх неё только перехватывали бы нажатия.

// Перетаскивание за полосу: своей рамки у окна нет, а системная его больше не
// двигает. Кнопки исключены — по ним нажимают, а не тянут.
document.querySelector(".titlebar")?.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest(".window-button")) return;
  windowCommand("window_drag");
});

$("profile-identity").addEventListener("click", () => {
  if (state.identity) copyText(state.identity, "Ключ личности скопирован");
});

/**
 * Создание группы или канала.
 *
 * Разница между ними одна: в канале пишет только владелец. Криптографически это
 * одна и та же группа MLS — сервер о ней не знает ничего, включая сам факт её
 * существования.
 */
$("new-group").addEventListener("click", () => {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h2>Новая группа</h2></div>`
    + `<div class="group-form">`
    + `<input data-title type="text" placeholder="Название" maxlength="60" />`
    + `<div class="kinds">`
    + `<button type="button" data-kind="chat" class="active"><b>Группа</b><small>пишут все участники</small></button>`
    + `<button type="button" data-kind="channel"><b>Канал</b><small>пишет только владелец</small></button>`
    + `</div>`
    + `<input data-members type="text" placeholder="Кого позвать: @имя, OBS-код или адрес" />`
    + `</div>`
    + `<p class="modal-copy">Состав знает только ваше устройство и устройства участников. Серверу группа не видна: он по-прежнему возит конверты между устройствами.</p>`
    + `<div class="setting-actions peer-actions">`
    + `<button class="ghost-button" data-no>Отмена</button>`
    + `<button class="ghost-button" data-yes>Создать</button></div></div>`;

  let kind = "chat";
  for (const button of modal.querySelectorAll("[data-kind]")) {
    button.addEventListener("click", () => {
      kind = button.dataset.kind;
      for (const other of modal.querySelectorAll("[data-kind]")) {
        other.classList.toggle("active", other === button);
      }
    });
  }

  const close = () => modal.remove();
  modal.querySelector("[data-no]").addEventListener("click", close);
  modal.querySelector("[data-yes]").addEventListener("click", () => {
    const title = modal.querySelector("[data-title]").value.trim();
    if (!title) return modal.querySelector("[data-title]").focus();
    const invite = modal.querySelector("[data-members]").value.trim();
    close();
    submit({ type: "group_create", title, kind, members: [] });
    // Приглашение уходит вторым шагом: сначала надо узнать адрес устройства.
    if (invite) state.pendingInviteAfterCreate = invite;
  });
  document.body.appendChild(modal);
  modal.querySelector("[data-title]").focus();
});

/** Зовёт человека в группу по @имени, коду чата или адресу устройства. */
function inviteToGroup(group, query) {
  const raw = query.trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    submit({ type: "group_invite", group, members: [raw.toLowerCase()] });
    return;
  }
  state.pendingGroupInvite = { group, query: raw };
  if (raw.startsWith("@")) {
    submit({ type: "username_lookup", name: raw.slice(1).toLowerCase() });
  } else {
    submit({ type: "profile_get", query: raw.toUpperCase() });
  }
}

$("invite-to-group").addEventListener("click", () => {
  const group = currentGroup();
  if (!group) return;
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h2>Позвать в «${group.title}»</h2></div>`
    + `<div class="group-form"><input data-query type="text" placeholder="@имя, OBS-код или адрес устройства" /></div>`
    + `<p class="modal-copy">Приглашённый получит ключи группы и сможет читать то, что будет написано дальше. Прежние сообщения ему не откроются.</p>`
    + `<div class="setting-actions peer-actions"><button class="ghost-button" data-no>Отмена</button>`
    + `<button class="ghost-button" data-yes>Позвать</button></div></div>`;
  const close = () => modal.remove();
  modal.querySelector("[data-no]").addEventListener("click", close);
  modal.querySelector("[data-yes]").addEventListener("click", () => {
    const query = modal.querySelector("[data-query]").value.trim();
    if (!query) return;
    close();
    inviteToGroup(groupIdOf(state.current), query);
  });
  document.body.appendChild(modal);
  modal.querySelector("[data-query]").focus();
});

$("leave-group").addEventListener("click", () => {
  const group = currentGroup();
  if (!group) return;
  confirmAction(
    "Забыть группу?",
    "Группа и её переписка исчезнут с этого устройства. Остальные участники ничего не заметят: сказать им об уходе нечем.",
    () => submit({ type: "group_forget", group: groupIdOf(state.current) }),
  );
});

$("admin-refresh").addEventListener("click", () => submit({ type: "admin_get", offset: adminOffset }));
for (const [id, action] of [["admin-block", "block"], ["admin-unblock", "unblock"]]) {
  $(id).addEventListener("click", () => {
    const reference = $("admin-reference").value.trim();
    if (!reference) {
      $("admin-status").textContent = "Укажите код чата, адрес устройства или ключ личности.";
      return;
    }
    submit({ type: "admin_action", action, reference });
  });
}

function usernameStatus(text) {
  $("username-status").textContent = text;
}

/** Личная ссылка. Тот же вид, что у канала: домен, раздел, имя. */
function usernameLink(name) {
  return `https://getobsidian.xyz/u/${name}`;
}

function renderUsername() {
  $("username-input").value = state.username ?? "";
  $("username-clear").disabled = !state.username;
  $("username-copy").disabled = !state.username;
  $("username-save").textContent = state.username ? "Сменить" : "Занять";

  // Ссылка появляется только когда имя занято: показывать адрес, который ещё
  // никому не принадлежит, значит обещать несуществующее.
  const link = $("username-link");
  link.classList.toggle("hidden", !state.username);
  if (state.username) {
    $("username-link-text").textContent = usernameLink(state.username).replace(/^https:\/\//, "");
  }
}

$("username-link").addEventListener("click", () => {
  if (state.username) copyText(usernameLink(state.username), "Ссылка скопирована");
});

// --- поиск по юзернейму ---------------------------------------------------------

/** `@имя` уходит в поиск, всё остальное — прежним путём, по коду или адресу. */
function looksLikeUsername(raw) {
  return raw.startsWith("@") || /^[a-z][a-z0-9_]{2,19}$/i.test(raw);
}

function showSearchResult(node) {
  const host = $("search-result");
  host.replaceChildren(node);
  host.classList.remove("hidden");
}

function hideSearchResult() {
  $("search-result").classList.add("hidden");
  $("search-result").replaceChildren();
}

function renderSearchMiss(query) {
  const message = document.createElement("p");
  message.className = "miss";
  // Скрытый и несуществующий отвечают одинаково — так задумано на сервере,
  // и интерфейс не должен додумывать за него.
  message.textContent = `@${query} — никого не нашли. Либо такого юзернейма нет, `
    + "либо человек скрыл себя из поиска.";
  showSearchResult(message);
}

function completePinnedAction(action) {
  if (action.kind === "group_invite") {
    submit({ type: "group_invite", group: action.group, members: [action.device] });
    hideSearchResult();
    toast(`@${action.query} приглашён`);
    return;
  }
  if (!state.conversations.has(action.device)) {
    state.conversations.set(action.device, { conversation: null, unread: 0 });
  }
  submit({ type: "directory_set", device: action.device, standing: "approved" });
  hideSearchResult();
  $("omni").value = "";
  selectConversation(action.device);
}

function renderSearchHit(event) {
  const card = document.createElement("div");

  const found = document.createElement("div");
  found.className = "found";
  const avatar = document.createElement("span");
  avatar.className = "conversation-avatar";
  if (event.avatar_base64 && event.avatar_mime) {
    avatar.style.backgroundImage = `url(data:${event.avatar_mime};base64,${event.avatar_base64})`;
    avatar.style.backgroundSize = "cover";
    avatar.textContent = "";
  } else {
    avatar.textContent = initials(event.device);
  }
  const copy = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = displayName(event.device);
  const handle = document.createElement("small");
  handle.textContent = `@${event.query}`;
  copy.append(name, handle);
  found.append(avatar, copy);
  card.appendChild(found);

  /*
    Ключ под этим именем сменился.

    Показывается до кнопки и вместо неё: пока человек не решил, переписка не
    начинается. Смена бывает законной — переставил систему, сменил телефон, —
    поэтому это вопрос, а не отказ. Но и не мелкая пометка сбоку: подмена ключа
    сервером выглядит ровно так же, и отличить одно от другого может только тот,
    кто знает этого человека.
  */
  const changed = event.pin === "changed";
  if (changed) {
    const alarm = document.createElement("p");
    alarm.className = "warning-strip";
    alarm.textContent = "У этого имени другой ключ устройства, чем прежде."
      + " Так бывает, когда человек переставил систему или сменил телефон —"
      + " и так же выглядит подмена. Спросите его любым другим способом,"
      + " прежде чем продолжать.";
    card.appendChild(alarm);
  }

  const actions = document.createElement("div");
  actions.className = "setting-actions";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "ghost-button";
  start.textContent = changed ? "Это правда он — продолжить" : "Отправить запрос";
  start.addEventListener("click", () => {
    const action = {
      kind: event.after_pin?.kind ?? "chat",
      group: event.after_pin?.group,
      query: event.query,
      device: event.device,
    };
    if (changed) {
      if (state.pendingPinAction) return;
      state.pendingPinAction = action;
      start.disabled = true;
      start.textContent = "Сохраняем новый ключ…";
      submit({ type: "pin_accept", name: event.query, device: event.device });
      return;
    }
    completePinnedAction(action);
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost-button";
  dismiss.textContent = "Скрыть";
  dismiss.addEventListener("click", hideSearchResult);
  actions.append(start, dismiss);
  card.appendChild(actions);

  showSearchResult(card);
}

// --- книга отношений ------------------------------------------------------------

/** Кто нам кто. Приходит из ядра, лежит в запечатанной базе. */

function standingOf(device) {
  return directory.get(device)?.standing ?? null;
}

function renderDirectory() {
  const list = $("requests");
  list.replaceChildren();
  const pending = [...directory.entries()].filter(([, entry]) => entry.standing === "pending");

  const badge = $("requests-count");
  badge.textContent = String(pending.length);
  badge.classList.toggle("zero", pending.length === 0);

  if (pending.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "Запросов нет";
    list.appendChild(empty);
    return;
  }

  for (const [device, entry] of pending) {
    list.appendChild(requestCard(device, entry));
  }
}

function requestCard(device, entry) {
  const card = document.createElement("li");
  card.className = "request-card";

  const found = document.createElement("div");
  found.className = "found";
  const avatar = document.createElement("span");
  avatar.className = "conversation-avatar";
  applyAvatar(avatar, device);
  const copy = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = entry.display_name || displayName(device);
  const handle = document.createElement("small");
  handle.textContent = entry.username ? `@${entry.username}` : short(device);
  copy.append(name, handle);
  found.append(avatar, copy);
  card.appendChild(found);

  if (entry.origin) {
    const origin = document.createElement("p");
    origin.className = "origin";
    origin.textContent = entry.origin;
    card.appendChild(origin);
  }

  const actions = document.createElement("div");
  actions.className = "setting-actions";
  for (const [caption, standing, danger] of [
    ["Принять", "approved", false],
    ["Отклонить", null, false],
    ["Заблокировать", "blocked", true],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = danger ? "ghost-button danger" : "ghost-button";
    button.textContent = caption;
    button.addEventListener("click", () => {
      if (standing === null) submit({ type: "directory_forget", device });
      else submit({ type: "directory_set", device, standing });
      if (standing === "approved") selectConversation(device);
    });
    actions.appendChild(button);
  }
  card.appendChild(actions);
  return card;
}

/** Переключает раздел списка. Отдельной функцией: ссылка на канал открывает
 *  вкладку «Публичные» сама, не дожидаясь нажатия. */
function openTab(list) {
  const order = ["chats", "requests", "channels"];
  const active = document.querySelector("#section-tabs button.active")?.dataset.list ?? "chats";
  const sidebar = document.querySelector("#screen-main .sidebar");
  if (sidebar && active !== list) {
    sidebar.dataset.paneDirection = order.indexOf(list) > order.indexOf(active) ? "next" : "prev";
  }
  for (const other of document.querySelectorAll("#section-tabs button[data-list]")) {
    const chosen = other.dataset.list === list;
    other.classList.toggle("active", chosen);
    other.setAttribute("aria-selected", String(chosen));
  }
  $("conversations").classList.toggle("hidden", list !== "chats");
  $("requests").classList.toggle("hidden", list !== "requests");
  $("channels-pane").classList.toggle("hidden", list !== "channels");
  if (list === "channels") submit({ type: "channel_list" });
}

for (const tab of document.querySelectorAll("#section-tabs button[data-list]")) {
  tab.addEventListener("click", () => openTab(tab.dataset.list));
}

// --- каналы ---------------------------------------------------------------------

/**
 * Открытая лента, которую ведёт один человек.
 *
 * Единственное место в приложении, где содержимое уходит на сервер незашифрованным,
 * — и потому единственное, где интерфейс обязан об этом сказать. Канал открыт по
 * своей природе: подписаться может кто угодно, а значит ключ достался бы любому
 * желающему. Молчать об этом было бы обманом, поэтому предупреждение висит над
 * лентой, а не спрятано в настройках.
 */
const channels = new Map();
let openChannel = null;
let channelOldest = null;
let channelSettingsModal = null;

function renderChannelList() {
  const list = $("channels");
  list.replaceChildren();
  if (channels.size === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "Публичных каналов пока нет. Заведите свой или найдите чужой по имени.";
    list.appendChild(empty);
    return;
  }
  for (const channel of channels.values()) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-button";
    if (openChannel === channel.id) item.classList.add("active");

    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar";
    paintChannelIcon(avatar, channel);

    const copy = document.createElement("span");
    copy.className = "conversation-copy";
    const name = document.createElement("b");
    name.textContent = channel.title;
    const handle = document.createElement("span");
    handle.textContent = `@${channel.handle}${channel.owner ? " · ваш" : ""}`;
    copy.append(name, handle);

    button.append(avatar, copy);
    button.addEventListener("click", () => openChannelFeed(channel.id));
    item.appendChild(button);
    list.appendChild(item);
  }
}

function openChannelFeed(id, before = null) {
  openChannel = id;
  if (before === null) channelOldest = null;
  submit({ type: "channel_feed", channel: id, before });
}

function showChannelPanel(show) {
  $("channel-panel").classList.toggle("hidden", !show);
  if (!show) return;
  // Панель канала и переписка занимают одно место — показывать оба нельзя.
  $("chat-empty").classList.add("hidden");
  $("messages").classList.add("hidden");
  $("form-send").classList.add("hidden");
  $("chat-header").classList.add("hidden");
}

function renderChannel(report) {
  const channel = report.channel;
  if (!channel) return;
  channels.set(channel.id, channel);
  openChannel = channel.id;
  showChannelPanel(true);

  $("channel-title").textContent = channel.title;
  $("channel-handle").textContent = `@${channel.handle}`;
  const role = channelRole(channel);
  if (role !== "reader") {
    const tag = document.createElement("span");
    tag.className = "channel-role";
    tag.textContent = role === "owner" ? "ваш канал" : "вы пишете";
    $("channel-handle").append(" ", tag);
  }
  $("channel-about").textContent = channel.about ?? "";
  paintChannelIcon($("channel-icon"), channel);
  // Поле ввода — у тех, кто пишет: у владельца и у позванных им в редакцию.
  $("channel-composer").classList.toggle("hidden", role === "reader");

  const subscribe = $("channel-subscribe");
  subscribe.classList.toggle("hidden", Boolean(channel.owner));
  subscribe.textContent = channel.subscribed ? "Отписаться" : "Подписаться";
  $("channel-settings").classList.toggle("hidden", !channel.owner);
  $("channel-delete").classList.toggle("hidden", !channel.owner);

  const feed = $("channel-feed");
  if (report.posts.length === 0 && channelOldest === null) {
    feed.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "channel-empty";
    empty.textContent = channel.owner
      ? "Здесь пока пусто. Напишите первый пост."
      : "Автор ещё ничего не публиковал.";
    feed.appendChild(empty);
  } else {
    if (channelOldest === null) feed.replaceChildren();
    for (const post of report.posts) feed.appendChild(postNode(post, channel));
  }
  channelOldest = report.posts.length > 0
    ? report.posts[report.posts.length - 1].seq : channelOldest;
  $("channel-more").classList.toggle("hidden", !report.more);
  renderChannelList();
}

/**
 * Роль в канале.
 *
 * Сервер присылает её полем `role`; `owner` остаётся для старых сборок, где
 * поля ещё нет, — иначе после обновления клиента к неподнятому серверу у
 * владельца пропало бы поле ввода.
 */
function channelRole(channel) {
  return channel.role ?? (channel.owner ? "owner" : "reader");
}

/** Публичная ссылка на канал — то, чем делятся вместо адреса устройства. */
function channelLink(channel) {
  return `https://getobsidian.xyz/channel/${channel.handle}`;
}

function paintChannelIcon(node, channel) {
  if (channel.iconBase64 && channel.iconMime) {
    node.textContent = "";
    node.style.backgroundImage = `url(data:${channel.iconMime};base64,${channel.iconBase64})`;
    node.classList.add("has-avatar");
    return;
  }
  const text = (channel.title || channel.handle).slice(0, 2).toUpperCase();
  node.textContent = text;
  node.classList.remove("has-avatar");
  node.style.backgroundImage = avatarGradient(text, "");
}

function postNode(post, channel) {
  const item = document.createElement("li");
  item.dataset.post = post.id;

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = post.body;

  const time = document.createElement("time");
  time.textContent = new Date(post.createdAt).toLocaleString();

  item.append(body, time);

  /*
    Пометка о неподтверждённом авторстве.

    Канал открыт, и его содержимое видит сервер — это принято. Но кто написал
    пост, решает подпись, а не сервер: ядро сверяет её с ключом владельца,
    который мы запомнили при первой встрече с каналом. Не сошлось — говорим
    прямо, потому что именно так выглядел бы пост, написанный за владельца.

    Ставим пометку, а не прячем пост: у старых клиентов подписи нет вовсе, и
    прятать их записи значило бы соврать про то, что канал пуст.
  */
  if (post.verified === false) {
    const mark = document.createElement("small");
    mark.className = "post-unverified";
    mark.textContent = "авторство не подтверждено";
    mark.title = "Пост не подписан ключом владельца канала: так выглядит и"
      + " запись старого клиента, и запись, сделанная за владельца.";
    item.appendChild(mark);
  }
  if (channel.owner) {
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "drop";
    drop.textContent = "Убрать";
    drop.addEventListener("click", () => {
      confirmAction("Убрать пост?",
        "Он исчезнет у всех читателей канала. Отменить это нечем.",
        () => submit({ type: "channel_delete_post", channel: channel.id, post: post.id }));
    });
    item.appendChild(drop);
  }
  return item;
}

// --- перенос аккаунта -----------------------------------------------------------

/*
  Файл переноса — это ключи и вся история под отдельным паролем. Ядро отдаёт
  его строкой, окно только сохраняет: путь выбирает человек, а не библиотека.
*/
$("export-account").addEventListener("click", () => {
  const password = $("export-password").value;
  const unlock = $("export-unlock").value;
  if (password.length < 8) {
    toast("Пароль файла — от восьми знаков");
    return;
  }
  /*
    Пароль устройства спрашивается здесь, а не в ядре «на всякий случай».

    База уже открыта — значит, для экспорта всего аккаунта достаточно чужих
    рук на разблокированной машине, а окно настроек в трёх кликах от рабочего
    стола. Подтверждение паролем — единственное, что между этим стоит; проверяет
    его ядро, здесь только поле.
  */
  if (unlock.length === 0) {
    toast("Введите пароль этого устройства");
    return;
  }
  confirmAction(
    "Сохранить файл со всем аккаунтом?",
    "В файл попадут ключи личности и устройства и вся переписка. Кто получит файл"
    + " и пароль к нему, сможет читать вашу переписку и писать от вашего имени.",
    async () => {
      $("export-status").textContent = "Собираем файл…";
      await submit({ type: "account_export", password, unlock });
      $("export-unlock").value = "";
    },
  );
});

$("import-account").addEventListener("click", () => {
  if ($("import-password").value.length < 8) {
    toast("Введите пароль файла переноса");
    return;
  }
  $("import-file").click();
});

$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files?.[0];
  $("import-file").value = "";
  if (!file) return;
  const password = $("import-password").value;
  $("import-password").value = "";
  let contents;
  try {
    contents = (await file.text()).trim();
  } catch {
    toast("Не удалось прочитать файл");
    return;
  }
  confirmAction("Перенести аккаунт сюда?",
    "Ключи и история из файла лягут в эту базу. Со старого устройства после этого писать нельзя: состояние шифрования у копий разойдётся.",
    () => submit({ type: "account_import", password, data: contents }));
});

/**
 * Карточка канала.
 *
 * То же, что показывает Telegram по нажатию на шапку: чем канал является,
 * по какой ссылке он открывается и сколько его читают. Отдельным окном, а не
 * строкой в шапке: сведений набирается на экран, и в шапке им тесно.
 */
function openChannelInfo() {
  const channel = channels.get(openChannel);
  if (!channel) return;

  const role = channelRole(channel);
  const modal = document.createElement("div");
  modal.className = "modal";

  const rows = [
    ["Подписчики", plural(channel.subscribers ?? 0, "человек", "человека", "человек")],
    ["Постов", String(channel.posts ?? 0)],
  ];
  // Состав редакции знает только владелец — сервер её остальным и не отдаёт.
  if (role === "owner" && Array.isArray(channel.admins)) {
    rows.push(["Редакция", channel.admins.length === 0
      ? "только вы"
      : plural(channel.admins.length, "человек", "человека", "человек")]);
  }
  rows.push(["Заведён", new Date(channel.createdAt).toLocaleDateString("ru-RU")]);

  modal.innerHTML = `<div class="modal-card channel-info">`
    + `<div class="channel-info-head">`
    + `<span class="channel-icon" data-icon></span>`
    + `<div><b data-title></b><small data-subs></small></div>`
    + `</div>`
    + `<button class="link-preview" data-link type="button" title="Скопировать ссылку">`
    + `<span class="link-preview-copy"><small>Ссылка на канал</small><b data-link-text></b></span>`
    + `<span class="ui-icon icon-discussion"></span></button>`
    + `<p class="channel-info-about" data-about></p>`
    + `<dl class="channel-info-rows">`
    + rows.map(([name, value]) =>
      `<div><dt>${name}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")
    + `</dl>`
    + `<div class="setting-actions peer-actions">`
    + `<button class="ghost-button" data-close>Закрыть</button>`
    + (role === "reader" && channel.subscribed
      ? `<button class="ghost-button danger" data-leave>Отписаться</button>` : "")
    + (role === "owner"
      ? `<button class="ghost-button" data-settings>Настроить</button>` : "")
    + `</div></div>`;

  modal.querySelector("[data-title]").textContent = channel.title;
  modal.querySelector("[data-subs]").textContent =
    plural(channel.subscribers ?? 0, "подписчик", "подписчика", "подписчиков");
  modal.querySelector("[data-link-text]").textContent = channelLink(channel).replace(/^https:\/\//, "");
  const about = modal.querySelector("[data-about]");
  about.textContent = channel.about ?? "";
  about.classList.toggle("hidden", !channel.about);
  paintChannelIcon(modal.querySelector("[data-icon]"), channel);

  const close = () => modal.remove();
  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector("[data-link]").addEventListener("click", () =>
    copyText(channelLink(channel), "Ссылка на канал скопирована"));
  modal.querySelector("[data-leave]")?.addEventListener("click", () => {
    submit({ type: "channel_subscribe", channel: channel.id, subscribe: false });
    close();
  });
  modal.querySelector("[data-settings]")?.addEventListener("click", () => {
    close();
    $("channel-settings").click();
  });

  document.body.appendChild(modal);
}

/** Число со словом в нужном падеже: «1 подписчик», «2 подписчика», «5 подписчиков». */
function plural(count, one, few, many) {
  const tail = count % 100;
  const last = count % 10;
  if (tail > 10 && tail < 20) return `${count} ${many}`;
  if (last === 1) return `${count} ${one}`;
  if (last >= 2 && last <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

function escapeHtml(raw) {
  return String(raw).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

$("channel-open-info").addEventListener("click", openChannelInfo);
$("channel-open-info-copy").addEventListener("click", openChannelInfo);
$("channel-open-info-copy").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openChannelInfo();
  }
});

$("channel-link").addEventListener("click", () => {
  const channel = channels.get(openChannel);
  if (channel) copyText(channelLink(channel), "Ссылка на канал скопирована");
});

/**
 * Настройки канала: название, описание, значок и редакция.
 *
 * Имя канала (`@handle`) здесь не меняется намеренно: на нём держится ссылка,
 * которой уже могли поделиться. Нужно другое имя — это другой канал.
 */
$("channel-settings").addEventListener("click", () => {
  const channel = channels.get(openChannel);
  if (!channel || !channel.owner) return;

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h2>Настройки канала</h2></div>`
    + `<div class="group-form">`
    + `<input data-title type="text" maxlength="64" placeholder="Название" />`
    + `<input data-about type="text" maxlength="280" placeholder="Описание" />`
    + `<div class="setting-actions">`
    + `<button class="ghost-button" data-icon type="button">Сменить значок</button>`
    + `<button class="ghost-button" data-icon-clear type="button">Убрать значок</button>`
    + `<button class="ghost-button" data-link type="button">Скопировать ссылку</button>`
    + `</div>`
    + `<small class="decor-label">Кто пишет, кроме вас</small>`
    + `<ul class="channel-admins" data-admins></ul>`
    + `<input data-invite type="text" placeholder="Позвать писать: @имя, OBS-код или адрес" />`
    + `</div>`
    + `<p class="modal-copy">Позванный пишет посты, но не может ни переименовать канал, ни закрыть его, ни позвать других.</p>`
    + `<div class="setting-actions peer-actions">`
    + `<button class="ghost-button" data-no>Закрыть</button>`
    + `<button class="ghost-button" data-yes>Сохранить</button></div></div>`;

  modal.querySelector("[data-title]").value = channel.title;
  modal.querySelector("[data-about]").value = channel.about ?? "";

  const admins = modal.querySelector("[data-admins]");
  const paintAdmins = () => {
    const current = channels.get(openChannel);
    admins.replaceChildren();
    const list = current?.admins ?? [];
    if (list.length === 0) {
      const empty = document.createElement("li");
      empty.className = "channel-empty-admins";
      empty.textContent = "Пока никого — пишете только вы.";
      admins.appendChild(empty);
      return;
    }
    for (const code of list) {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = code;
      const drop = document.createElement("button");
      drop.type = "button";
      drop.textContent = "Убрать";
      drop.addEventListener("click", () =>
        submit({ type: "channel_admin", channel: current.id, who: code, admin: false }));
      row.append(name, drop);
      admins.appendChild(row);
    }
  };
  paintAdmins();
  // Список обновляется ответом сервера, а не на месте: право писать выдаёт он.
  modal.__paintAdmins = paintAdmins;
  channelSettingsModal = modal;

  modal.querySelector("[data-link]").addEventListener("click", () =>
    copyText(channelLink(channel), "Ссылка на канал скопирована"));
  modal.querySelector("[data-icon]").addEventListener("click", () => $("channel-icon-file").click());
  modal.querySelector("[data-icon-clear]").addEventListener("click", () =>
    submit({ type: "channel_update", channel: channel.id, icon: null }));

  modal.querySelector("[data-invite]").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const who = event.target.value.trim();
    if (!who) return;
    event.target.value = "";
    submit({ type: "channel_admin", channel: channel.id, who });
  });

  const close = () => {
    channelSettingsModal = null;
    modal.remove();
  };
  modal.querySelector("[data-no]").addEventListener("click", close);
  modal.querySelector("[data-yes]").addEventListener("click", () => {
    const title = modal.querySelector("[data-title]").value.trim();
    const about = modal.querySelector("[data-about]").value.trim();
    if (!title) {
      toast("Название не может быть пустым");
      return;
    }
    submit({ type: "channel_update", channel: channel.id, title, about });
    close();
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.body.appendChild(modal);
});

$("channel-icon-file").addEventListener("change", () => {
  const file = $("channel-icon-file").files?.[0];
  $("channel-icon-file").value = "";
  // Тот же редактор, что у аватара: значок канала тоже квадратный.
  if (file) openEditor(file, "channel-icon");
});

/** Тот же формат, что проверяет сервер. Держим рядом, чтобы не расходились. */
const CHANNEL_HANDLE = /^[a-z][a-z0-9_]{2,29}$/;

/**
 * Заведение канала.
 *
 * Раньше это были два `prompt()` подряд — окна браузера, в которых нельзя ни
 * показать ссылку, ни объяснить, что канал открытый. Здесь человек видит
 * будущий адрес прямо во время набора имени: адрес — это то, чем он будет
 * делиться, и узнавать его постфактум неправильно.
 */
$("channel-create").addEventListener("click", () => {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h2>Новый канал</h2></div>`
    + `<div class="group-form">`
    + `<div class="handle-field"><i>@</i><input data-handle type="text" placeholder="notes" `
    + `maxlength="30" autocomplete="off" spellcheck="false" /></div>`
    + `<div class="link-preview static"><span class="link-preview-copy">`
    + `<small>Ссылка на канал</small><b data-link>getobsidian.xyz/channel/…</b></span></div>`
    + `<input data-title type="text" placeholder="Название" maxlength="64" />`
    + `<input data-about type="text" placeholder="Описание, необязательно" maxlength="280" />`
    + `</div>`
    + `<p class="modal-copy">Канал — открытая лента. Посты лежат на сервере <b>без шифрования</b>`
    + ` и видны всем, кто знает ссылку. Личная переписка работает иначе.</p>`
    + `<div class="setting-actions peer-actions">`
    + `<button class="ghost-button" data-no>Отмена</button>`
    + `<button class="ghost-button" data-yes disabled>Завести</button></div></div>`;

  const handleInput = modal.querySelector("[data-handle]");
  const link = modal.querySelector("[data-link]");
  const create = modal.querySelector("[data-yes]");

  const refresh = () => {
    const handle = handleInput.value.trim().replace(/^@/, "").toLowerCase();
    const valid = CHANNEL_HANDLE.test(handle);
    link.textContent = handle === ""
      ? "getobsidian.xyz/channel/…"
      : `getobsidian.xyz/channel/${handle}`;
    link.classList.toggle("bad", handle !== "" && !valid);
    create.disabled = !valid || modal.querySelector("[data-title]").value.trim() === "";
  };
  handleInput.addEventListener("input", refresh);
  modal.querySelector("[data-title]").addEventListener("input", refresh);

  const close = () => modal.remove();
  modal.querySelector("[data-no]").addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  create.addEventListener("click", () => {
    const about = modal.querySelector("[data-about]").value.trim();
    submit({
      type: "channel_create",
      handle: handleInput.value.trim().replace(/^@/, "").toLowerCase(),
      title: modal.querySelector("[data-title]").value.trim(),
      about: about === "" ? null : about,
    });
    close();
  });

  document.body.appendChild(modal);
  handleInput.focus();
});

$("channel-find").addEventListener("click", () => {
  const handle = prompt("Имя канала или ссылка на него:");
  if (!handle) return;
  // Человеку прислали ссылку целиком — незачем заставлять его вырезать имя.
  const name = handle.trim().replace(/^.*\/channel\//, "").replace(/^@/, "");
  submit({ type: "channel_find", handle: name });
});

$("channel-subscribe").addEventListener("click", () => {
  const channel = channels.get(openChannel);
  if (!channel) return;
  submit({ type: "channel_subscribe", channel: channel.id, subscribe: !channel.subscribed });
});

$("channel-delete").addEventListener("click", () => {
  const channel = channels.get(openChannel);
  if (!channel) return;
  confirmAction("Закрыть канал?",
    `@${channel.handle} исчезнет вместе со всеми постами и подписками. Отменить это нечем.`,
    () => submit({ type: "channel_delete", channel: channel.id }));
});

$("channel-more").addEventListener("click", () => {
  if (openChannel) openChannelFeed(openChannel, channelOldest);
});

$("channel-composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("channel-text").value.trim();
  if (!text || !openChannel) return;
  $("channel-text").value = "";
  submit({ type: "channel_publish", channel: openChannel, body: text });
});

// --- проверка правил на входящем ------------------------------------------------

/**
 * Решает по тому же порядку, что и ядро: запрет, разрешение, круг.
 *
 * Логика повторяет `Rule::permits` из `privacy.rs`. Дублирование осознанное:
 * ядро не разбирает формат содержимого — для него тело сообщения непрозрачно, —
 * а тип вложения виден только здесь. Порядок проверок обязан совпадать, поэтому
 * он вынесен в одну функцию, а не размазан по местам применения.
 */
function permits(ruleName, peer) {
  const rule = privacy?.[ruleName];
  // Правила ещё не пришли из ядра — не мешаем показывать переписку.
  if (!rule || !peer) return true;
  if (rule.deny.includes(peer)) return false;
  if (rule.allow.includes(peer)) return true;

  const standing = standingOf(peer);
  switch (rule.scope) {
    case "everyone": return true;
    case "approved": return standing === "contact" || standing === "approved";
    case "contacts": return standing === "contact";
    default: return false;
  }
}

/** Какое правило отвечает за этот тип содержимого. */
const CONTENT_RULE = { image: "media", voice: "voice", file: "files" };

const CONTENT_LABEL = { image: "Фото", voice: "Голосовое сообщение", file: "Файл" };

/**
 * Заглушка вместо скрытого вложения.
 *
 * Именно заглушка, а не тишина: молча выброшенное вложение выглядело бы как
 * потерянное сообщение, и человек не понял бы, что сработала его же настройка.
 * Показать можно — решение остаётся за получателем.
 */
function blockedAttachment(content, rebuild) {
  const wrap = document.createElement("div");
  wrap.className = "blocked-attachment";

  const title = document.createElement("b");
  title.textContent = `${CONTENT_LABEL[content.type] ?? "Вложение"} скрыто`;

  const why = document.createElement("small");
  why.textContent = "По вашим правилам приватности от этого собеседника такие вложения не показываются.";

  const show = document.createElement("button");
  show.type = "button";
  show.className = "ghost-button";
  show.textContent = "Показать";
  show.addEventListener("click", rebuild);

  wrap.append(title, why, show);
  return wrap;
}

// --- приглашения -----------------------------------------------------------------

/** Политика и выпущенные ссылки. Приходят из ядра. */
let access = null;

$("invite-create").addEventListener("click", () => {
  const label = $("invite-label").value.trim();
  submit({
    type: "pass_invite",
    label: label || null,
    one_time: $("invite-once").checked,
    ttl_sec: Number($("invite-ttl").value),
  });
  $("invite-label").value = "";
});

function renderInvites() {
  const host = $("invite-list");
  host.replaceChildren();
  const invites = access?.invites ?? [];

  if (invites.length === 0) {
    const empty = document.createElement("p");
    empty.className = "invite-empty";
    empty.textContent = "Пока ни одной.";
    host.appendChild(empty);
    return;
  }

  for (const invite of invites) {
    const row = document.createElement("div");
    row.className = "invite-row";

    const copy = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = invite.label || "Без заметки";
    const terms = document.createElement("small");
    terms.textContent = [
      invite.one_time ? "одноразовая" : "многоразовая",
      invite.ttl_sec === 0 ? "бессрочно" : `на ${humanTtl(invite.ttl_sec)}`,
    ].join(" · ");
    const link = document.createElement("code");
    link.textContent = `obsidian://invite/${invite.pass}`;
    copy.append(title, terms, link);
    row.appendChild(copy);

    const actions = document.createElement("div");
    actions.className = "invite-actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "ghost-button";
    copyButton.textContent = "Скопировать";
    copyButton.addEventListener("click", () =>
      copyText(`obsidian://invite/${invite.pass}`, "Ссылка скопирована"));

    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "ghost-button danger";
    revoke.textContent = "Отозвать";
    revoke.addEventListener("click", () => submit({ type: "pass_revoke", hash: invite.hash }));

    actions.append(copyButton, revoke);
    row.appendChild(actions);
    host.appendChild(row);
  }
}

function humanTtl(seconds) {
  if (seconds >= 604800) return `${Math.round(seconds / 604800)} нед.`;
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} дн.`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} ч.`;
  return `${Math.round(seconds / 60)} мин.`;
}

// --- профиль собеседника ---------------------------------------------------------

let peerCard = null;

$("peer-open").addEventListener("click", () => {
  if (state.current) openPeerCard(state.current);
});

function openPeerCard(device) {
  peerCard = device;
  const profile = state.profiles.get(device);
  const entry = directory.get(device);

  paintName($("peer-modal-name"), device);
  applyAvatar($("peer-modal-avatar"), device);
  $("peer-modal-username").textContent = profile?.handle ? `@${profile.handle}` : "юзернейм не указан";
  $("peer-modal-standing").textContent = STANDING_LABELS[entry?.standing] ?? "не в контактах";
  $("peer-modal-code").textContent = profile?.chat_code ?? "—";
  $("peer-modal-device").textContent = short(device);
  $("peer-contact").textContent = entry?.standing === "contact" ? "Убрать из контактов" : "В контакты";
  $("peer-modal").classList.remove("hidden");
  $("peer-modal-close").focus();
}

const STANDING_LABELS = {
  contact: "В контактах",
  approved: "Запрос принят",
  pending: "Ждёт вашего решения",
  blocked: "Заблокирован",
};

$("peer-modal-close").addEventListener("click", closePeerCard);
$("peer-modal").addEventListener("click", (event) => {
  if (event.target === $("peer-modal")) closePeerCard();
});

function closePeerCard() {
  $("peer-modal").classList.add("hidden");
  peerCard = null;
}

$("peer-modal-code").addEventListener("click", () =>
  copyText($("peer-modal-code").textContent, "Код скопирован"));
$("peer-modal-device").addEventListener("click", () =>
  peerCard && copyText(peerCard, "Адрес устройства скопирован"));

$("peer-contact").addEventListener("click", () => {
  if (!peerCard) return;
  const current = directory.get(peerCard)?.standing;
  submit({ type: "directory_set", device: peerCard, standing: current === "contact" ? "approved" : "contact" });
  closePeerCard();
});

$("peer-verify").addEventListener("click", () => {
  if (peerCard) submit({ type: "verify", peer_device: peerCard });
  closePeerCard();
});

$("peer-block").addEventListener("click", () => {
  if (!peerCard) return;
  const device = peerCard;
  closePeerCard();
  confirmAction("Заблокировать?", "Его сообщения перестанут приходить и не будут сохраняться.",
    () => submit({ type: "directory_set", device, standing: "blocked" }));
});

$("peer-clear").addEventListener("click", () => {
  const conversation = conversationOf(peerCard);
  closePeerCard();
  if (!conversation) return;
  confirmAction("Очистить переписку?", "Сообщения исчезнут с этого устройства. У собеседника они останутся.",
    () => submit({ type: "clear_conversation", conversation }));
});

$("peer-delete").addEventListener("click", () => {
  const device = peerCard;
  const conversation = conversationOf(device);
  closePeerCard();
  if (!conversation) return;
  confirmAction("Удалить чат?", "Переписка и сама беседа исчезнут с этого устройства. Чтобы написать снова, диалог придётся завести заново.",
    () => submit({ type: "delete_conversation", conversation }));
});

/**
 * Подтверждение своим окном, а не системным.
 *
 * `confirm()` в WebView2 выглядит чужеродно и не подчиняется ни теме, ни
 * настройкам оформления — а спрашивают им как раз о необратимом.
 */
function confirmAction(title, detail, onYes) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h2></h2></div>`
    + `<p class="modal-copy"></p><div class="setting-actions peer-actions">`
    + `<button class="ghost-button" data-no>Отмена</button>`
    + `<button class="ghost-button danger" data-yes>Да</button></div></div>`;
  modal.querySelector("h2").textContent = title;
  modal.querySelector(".modal-copy").textContent = detail;
  modal.querySelector("[data-no]").addEventListener("click", () => modal.remove());
  modal.querySelector("[data-yes]").addEventListener("click", () => {
    modal.remove();
    onYes();
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
  modal.querySelector("[data-no]").focus();
}


// --- эмодзи ------------------------------------------------------------------

/*
  Набор свой и небольшой.

  Полный Unicode тянуть незачем: он весит мегабайты, требует таблиц имён для
  поиска и всё равно рисуется системным шрифтом. Здесь то, чем пользуются
  каждый день, разложенное по смыслу, — а редкий знак человек вставит через
  системную панель по Win+точка, которая никуда не делась.
*/
const EMOJI_CATEGORIES = [
  ["😀", "Лица", "😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 🙂‍↕️ 😏 😒 🙂‍↔️ 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😮‍💨 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🫡 🤫 🫠 🤥 😶 🫥 😐 🫤 😑 🫨 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 😵‍💫 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃"],
  ["👋", "Люди и жесты", "👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 🫷 🫸 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 🫦 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 👷 💂 🕵️ 👩‍⚕️ 👩‍🌾 👩‍🍳 👩‍🎓 👩‍🎤 👩‍🏫 👩‍🏭 👩‍💻 👩‍💼 👩‍🔧 👩‍🔬 👩‍🎨 👩‍🚒 👩‍✈️ 👩‍🚀 👩‍⚖️ 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 🧌 💆 💇 🚶 🧍 🧎 🏃 💃 🕺 🕴️ 👯 🧖 🧗 🤺 🏇 ⛷️ 🏂 🏌️ 🏄 🚣 🏊 ⛹️ 🏋️ 🚴 🚵 🤸 🤼 🤽 🤾 🤹 🧘 🛀 🛌"],
  ["🐻", "Животные и природа", "🐵 🐒 🦍 🦧 🐶 🐕 🦮 🐕‍🦺 🐩 🐺 🦊 🦝 🐱 🐈 🐈‍⬛ 🦁 🐯 🐅 🐆 🐴 🫎 🫏 🐎 🦄 🦓 🦌 🦬 🐮 🐂 🐃 🐄 🐷 🐖 🐗 🐽 🐏 🐑 🐐 🐪 🐫 🦙 🦒 🐘 🦣 🦏 🦛 🐭 🐁 🐀 🐹 🐰 🐇 🐿️ 🦫 🦔 🦇 🐻 🐻‍❄️ 🐨 🐼 🦥 🦦 🦨 🦘 🦡 🐾 🦃 🐔 🐓 🐣 🐤 🐥 🐦 🐧 🕊️ 🦅 🦆 🦢 🦉 🦤 🪶 🦩 🦚 🦜 🪽 🐦‍⬛ 🪿 🐦‍🔥 🐸 🐊 🐢 🦎 🐍 🐲 🐉 🦕 🦖 🐳 🐋 🐬 🦭 🐟 🐠 🐡 🦈 🐙 🐚 🪸 🪼 🐌 🦋 🐛 🐜 🐝 🪲 🐞 🦗 🪳 🕷️ 🦂 🦟 🪰 🪱 🦠 💐 🌸 💮 🪷 🌹 🥀 🌺 🌻 🌼 🌷 🪻 🌱 🪴 🌲 🌳 🌴 🌵 🌾 🌿 ☘️ 🍀 🍁 🍂 🍃 🍄 🪨 🌍 🌎 🌏 🌕 🌙 ⭐ 🌟 ✨ ⚡ ☄️ 🔥 🌪️ 🌈 ☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 💧 🌊"],
  ["🍕", "Еда и напитки", "🍏 🍎 🍐 🍊 🍋 🍋‍🟩 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🫛 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🫚 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🫕 🥫 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍴 🍽️"],
  ["⚽", "Спорт и занятия", "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🎪 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🪘 🎷 🎺 🪗 🎸 🪕 🎻 🪈 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🧩 🧸 🪅 🪩 🪆 🃏 🀄 🎴"],
  ["🚀", "Путешествия", "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🏍️ 🛵 🚲 🛴 🛹 🛼 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🛟 ⛽ 🚧 🚦 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏕️ 🏠 🏢 🏥 🏦 🏨 🏫 🏭 ⛪ 🕌 🛕 🕍 ⛩️ 🕋 🌅 🌄 🌠 🎇 🎆 🌆 🌃 🌌 🌉"],
  ["💡", "Предметы", "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🖲️ 🕹️ 🗜️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 🎞️ 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ 🧭 ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🪫 🔌 💡 🔦 🕯️ 🧯 🛢️ 💸 💵 💶 💷 💳 🪙 💎 ⚖️ 🪜 🧰 🪛 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪚 🔩 ⚙️ 🪤 🧱 ⛓️ ⛓️‍💥 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 ⚱️ 🔮 📿 🧿 🪬 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 🩻 🚪 🛗 🪞 🪟 🛏️ 🛋️ 🪑 🚽 🪠 🚿 🛁 🪥 🧴 🧷 🧹 🧺 🧻 🪣 🧼 🫧 🪥 🧽 🧯 🛒 🎁 🎈 🎀 🪄 🪅 ✉️ 📩 📨 📧 💌 📦 🏷️ 🪧 📪 📫 📬 📭 📮 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓"],
  ["❤️", "Символы", "❤️ 🩷 🧡 💛 💚 💙 🩵 💜 🤎 🖤 🩶 🤍 💔 ❤️‍🔥 ❤️‍🩹 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🛗 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧️ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 #️⃣ *️⃣ ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ 🔀 🔁 🔂 ◀️ 🔼 🔽 ⏫ ⏬ ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ 🔄 ↪️ ↩️ ➿ ♾️ ✔️ ➕ ➖ ➗ ✖️ ™️ ©️ ®️"],
  ["🏳️", "Флаги", "🏁 🚩 🎌 🏴 🏳️ 🏳️‍🌈 🏳️‍⚧️ 🏴‍☠️ 🇺🇳 🇷🇺 🇺🇦 🇧🇾 🇰🇿 🇦🇲 🇦🇿 🇬🇪 🇺🇿 🇹🇯 🇰🇬 🇲🇩 🇺🇸 🇨🇦 🇲🇽 🇧🇷 🇦🇷 🇨🇱 🇨🇴 🇵🇪 🇬🇧 🇮🇪 🇫🇷 🇩🇪 🇪🇸 🇵🇹 🇮🇹 🇳🇱 🇧🇪 🇨🇭 🇦🇹 🇵🇱 🇨🇿 🇸🇰 🇭🇺 🇷🇴 🇧🇬 🇬🇷 🇹🇷 🇸🇪 🇳🇴 🇫🇮 🇩🇰 🇮🇸 🇪🇪 🇱🇻 🇱🇹 🇷🇸 🇭🇷 🇸🇮 🇧🇦 🇲🇪 🇲🇰 🇦🇱 🇨🇾 🇲🇹 🇯🇵 🇨🇳 🇰🇷 🇮🇳 🇮🇩 🇹🇭 🇻🇳 🇸🇬 🇲🇾 🇵🇭 🇵🇰 🇧🇩 🇮🇱 🇸🇦 🇦🇪 🇮🇷 🇮🇶 🇪🇬 🇿🇦 🇳🇬 🇰🇪 🇲🇦 🇩🇿 🇹🇳 🇦🇺 🇳🇿"],
];

const EMOJI_TONES = ["🏻", "🏼", "🏽", "🏾", "🏿"];
const TONE_BASES = "👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 🫷 🫸 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🙏 ✍️ 💅 🤳 💪 🦵 🦶 👂 👃 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵".split(" ");
EMOJI_CATEGORIES.splice(2, 0, ["🎨", "Оттенки кожи", null]);

let emojiPanel = null;

function closeEmoji() {
  emojiPanel?._emojiObserver?.disconnect();
  emojiPanel?.remove();
  emojiPanel = null;
}

$("emoji-open").addEventListener("click", (event) => {
  event.stopPropagation();
  if (emojiPanel) return closeEmoji();

  const panel = document.createElement("div");
  panel.className = "emoji-panel";
  const tabs = document.createElement("div");
  tabs.className = "emoji-tabs";
  tabs.setAttribute("role", "tablist");
  const scroll = document.createElement("div");
  scroll.className = "emoji-scroll";
  panel.append(tabs, scroll);

  function openEmojiCategory(index) {
    panel._emojiObserver?.disconnect();
    tabs.querySelectorAll("button").forEach((button, at) => button.classList.toggle("active", at === index));
    const [, title, row] = EMOJI_CATEGORIES[index];
    const values = row === null
      ? TONE_BASES.flatMap((base) => EMOJI_TONES.map((tone) => `${base.replace("️", "")}${tone}`))
      : row.split(" ");
    const heading = document.createElement("p");
    heading.className = "emoji-title";
    heading.textContent = title;
    const grid = document.createElement("div");
    grid.className = "emoji-grid";
    const sentinel = document.createElement("div");
    sentinel.className = "emoji-sentinel";
    scroll.replaceChildren(heading, grid, sentinel);
    scroll.scrollTop = 0;
    let rendered = 0;
    const renderChunk = () => {
      const fragment = document.createDocumentFragment();
      for (const symbol of values.slice(rendered, rendered + 72)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = symbol;
        button.title = symbol;
        button.addEventListener("click", () => insertEmoji(symbol));
        fragment.appendChild(button);
      }
      rendered = Math.min(values.length, rendered + 72);
      grid.appendChild(fragment);
      if (rendered >= values.length) panel._emojiObserver?.disconnect();
    };
    renderChunk();
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderChunk();
    }, { root: scroll, rootMargin: "100px" });
    panel._emojiObserver = observer;
    if (rendered < values.length) observer.observe(sentinel);
  }

  EMOJI_CATEGORIES.forEach(([icon, title], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = icon;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", () => openEmojiCategory(index));
    tabs.appendChild(button);
  });
  openEmojiCategory(0);
  // Внутри панели щелчок не должен её закрывать: выбирают часто по нескольку.
  panel.addEventListener("click", (inner) => inner.stopPropagation());
  document.querySelector(".composer").appendChild(panel);
  emojiPanel = panel;
});

document.addEventListener("click", closeEmoji);

/** Вставляет знак туда, где стоит курсор, а не в конец строки. */
function insertEmoji(symbol) {
  const field = $("composer");
  const at = field.selectionStart ?? field.value.length;
  const to = field.selectionEnd ?? at;
  field.value = field.value.slice(0, at) + symbol + field.value.slice(to);
  const after = at + symbol.length;
  field.setSelectionRange(after, after);
  field.focus();
  field.dispatchEvent(new Event("input"));
}

// --- правка отправленного ------------------------------------------------------

/**
 * Что сейчас правится. Пусто — композер работает как обычно.
 *
 * Правка живёт рядом с ответом и цитатой: то же поле, та же кнопка отправки.
 * Отдельного окна нет намеренно — текст правят, глядя на переписку вокруг.
 */
let editing = null;

function startEdit(id, text) {
  editing = { id, was: text };
  replyingTo = null;
  const field = $("composer");
  field.value = text;
  field.focus();
  field.setSelectionRange(text.length, text.length);
  renderEditBar();
}

function cancelEdit() {
  editing = null;
  $("composer").value = "";
  renderEditBar();
}

function renderEditBar() {
  document.querySelector(".composer-edit")?.remove();
  if (!editing) return;
  const bar = document.createElement("div");
  bar.className = "composer-edit";
  const label = document.createElement("b");
  label.textContent = "Изменение сообщения";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "icon-button";
  cancel.title = "Отменить правку";
  cancel.append(Object.assign(document.createElement("span"), { className: "ui-icon icon-cross" }));
  cancel.addEventListener("click", cancelEdit);
  bar.append(label, cancel);
  document.querySelector(".composer-wrap").prepend(bar);
}

/** Меняет тело в кэше и на экране, не трогая порядок сообщений. */
function applyEdit(conversation, id, body) {
  const entry = history.get(conversation);
  const rebuilt = buildMessage(
    { outgoing: true, body, created_at: Date.now() },
    peerOf(conversation) ?? state.current,
  );
  if (!rebuilt) return;

  for (const node of document.querySelectorAll(`[data-message-id="${CSS.escape(id)}"]`)) {
    const fresh = rebuilt.node.cloneNode(true);
    markEdited(fresh);
    node.replaceWith(fresh);
  }
  if (!entry) return;
  for (const item of entry.items) {
    if (item.node.dataset.messageId !== id) continue;
    const fresh = rebuilt.node.cloneNode(true);
    markEdited(fresh);
    item.node = fresh;
  }
}

/** Помета «изменено»: собеседник должен видеть, что текст не первоначальный. */
function markEdited(node) {
  const meta = node.querySelector(".message-meta");
  if (!meta || meta.querySelector(".edited")) return;
  const mark = document.createElement("span");
  mark.className = "edited";
  mark.textContent = "изменено";
  meta.appendChild(mark);
}

// --- поиск по открытой переписке ----------------------------------------------

/*
  Ищем по тому, что уже поднято в беседу, и говорим об этом прямо.

  Спрашивать ядро незачем: история подтягивается страницами, и честный поиск
  по всей переписке — это отдельная команда с чтением всей базы. Пока её нет,
  панель ищет по загруженному и предлагает подгрузить ещё.
*/
let searchHits = [];
let searchAt = -1;

function closeSearch() {
  $("chat-search").classList.add("hidden");
  $("chat-search-input").value = "";
  clearSearchMarks();
  searchHits = [];
  searchAt = -1;
}

function clearSearchMarks() {
  for (const node of document.querySelectorAll("#messages li.search-hit")) {
    node.classList.remove("search-hit", "search-current");
  }
}

function runSearch() {
  const needle = $("chat-search-input").value.trim().toLowerCase();
  clearSearchMarks();
  searchHits = [];
  searchAt = -1;

  if (needle.length >= 2) {
    for (const node of document.querySelectorAll("#messages li[data-message-id]")) {
      const body = node.querySelector(".body")?.textContent?.toLowerCase() ?? "";
      if (!body.includes(needle)) continue;
      node.classList.add("search-hit");
      searchHits.push(node);
    }
  }
  $("chat-search-count").textContent = needle.length < 2
    ? "—"
    : searchHits.length === 0 ? "ничего" : `1 из ${searchHits.length}`;
  if (searchHits.length > 0) stepSearch(searchHits.length - 1);
}

function stepSearch(to) {
  if (searchHits.length === 0) return;
  searchHits[searchAt]?.classList.remove("search-current");
  searchAt = (to + searchHits.length) % searchHits.length;
  const node = searchHits[searchAt];
  node.classList.add("search-current");
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  $("chat-search-count").textContent = `${searchAt + 1} из ${searchHits.length}`;
}

$("open-search").addEventListener("click", () => {
  const panel = $("chat-search");
  const hidden = panel.classList.toggle("hidden");
  if (hidden) return closeSearch();
  $("chat-search-input").focus();
});

$("chat-search-input").addEventListener("input", runSearch);
$("chat-search-next").addEventListener("click", () => stepSearch(searchAt + 1));
$("chat-search-prev").addEventListener("click", () => stepSearch(searchAt - 1));
$("chat-search-close").addEventListener("click", () => {
  $("chat-search").classList.add("hidden");
  closeSearch();
});
$("chat-search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    stepSearch(searchAt + (event.shiftKey ? -1 : 1));
  }
});

// --- меню сообщения ---------------------------------------------------------------

/*
  Системное меню WebView2 («Обновить», «Сохранить как…», «Просмотреть код»)
  в мессенджере не к месту: оно выдаёт браузер под окном и предлагает то, чего
  в приложении нет. Своё меню есть у сообщений; везде остальном правая кнопка
  просто ничего не делает.

  Исключение — поля ввода: там системное меню даёт вставку из буфера, и
  заменить его нечем.
*/
document.addEventListener("contextmenu", (event) => {
  if (inTextField(event.target)) return;
  event.preventDefault();
});

let replyingTo = null;

$("messages").addEventListener("contextmenu", (event) => {
  const item = event.target.closest("#messages li");
  if (!item || !item.dataset.messageId) return;
  event.preventDefault();
  openMessageMenu(item, event.clientX, event.clientY);
});

function openMessageMenu(item, x, y) {
  const menu = $("message-menu");
  menu.replaceChildren();
  document.querySelectorAll("#messages li.selected").forEach((n) => n.classList.remove("selected"));
  item.classList.add("selected");

  const id = item.dataset.messageId;
  const outgoing = item.classList.contains("out");
  const text = item.querySelector(".body")?.textContent ?? "";

  const entries = [
    ["Ответить", () => startReply(id, text)],
    ["Копировать текст", () => copyText(text, "Скопировано")],
    ["Удалить у себя", () => confirmDelete(id, false), true],
  ];
  // Править можно только своё и только текст: у фотографии и голосового
  // «изменить» означало бы отправить другое, а это уже новое сообщение.
  const editable = outgoing && !item.querySelector(".message-image, .voice");
  if (editable) entries.splice(1, 0, ["Изменить", () => startEdit(id, text)]);
  // Просить об удалении можно только своё: чужую копию у собеседника мы всё
  // равно не контролируем, а кнопка обещала бы обратное.
  if (outgoing) entries.push(["Удалить у обоих", () => confirmDelete(id, true), true]);

  for (const [caption, action, danger] of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = caption;
    if (danger) button.className = "danger";
    button.addEventListener("click", () => {
      closeMessageMenu();
      action();
    });
    menu.appendChild(button);
  }

  menu.classList.remove("hidden");
  // Держим меню в окне: у нижних сообщений оно иначе уезжает за край.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - box.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - box.height - 8)}px`;
  menu.querySelector("button")?.focus();
}

function closeMessageMenu() {
  $("message-menu").classList.add("hidden");
  document.querySelectorAll("#messages li.selected").forEach((n) => n.classList.remove("selected"));
}

document.addEventListener("click", (event) => {
  if (!$("message-menu").contains(event.target)) closeMessageMenu();
});
document.addEventListener("scroll", closeMessageMenu, true);

/**
 * Спрашивает перед удалением, если так велено в настройках.
 *
 * Отменить удаление нечем: сообщение стирается из базы, а «у обоих» ещё и
 * уходит просьбой собеседнику — выполнит её его приложение, и проверить это
 * невозможно. Поэтому вопрос включён по умолчанию.
 */
function confirmDelete(id, forBoth) {
  // Откат делает вопрос лишним: человек уже видит, что произошло, и может
  // вернуть. Настройку уважаем — кому спокойнее с вопросом, тот его оставит.
  if (!preferences.confirmDelete) return deleteMessage(id, forBoth);
  const message = forBoth
    ? "Ваша копия исчезнет сразу. Собеседнику уйдёт просьба удалить свою — выполнит её его приложение, и проверить это невозможно."
    : "Сообщение исчезнет только на этом устройстве. У собеседника оно останется.";
  confirmAction(forBoth ? "Удалить у обоих?" : "Удалить у себя?", message,
    () => deleteMessage(id, forBoth));
}

/**
 * Отложенное действие, которое можно отменить.
 *
 * Удаление — единственное здесь, что нельзя переиграть: сообщение уходит из
 * локальной базы, а при «удалить у обоих» ещё и просьба уезжает собеседнику.
 * Спрашивать подтверждение заранее — плохой размен: диалог мешает каждый раз,
 * а ошибаются редко. Поэтому наоборот — действие выполняется не сразу, а через
 * несколько секунд, и всё это время его можно вернуть.
 *
 * Ждём не в интерфейсе, а до отправки команды: пока таймер идёт, ядро о
 * удалении не знает вовсе, и откат ничего не восстанавливает — просто не
 * случается.
 */
const UNDO_WINDOW_MS = 6000;
let pendingUndo = null;

function deferWithUndo(label, run, revert) {
  // Второе действие подряд не отменяет первое: доводим предыдущее до конца.
  flushUndo();
  const timer = setTimeout(() => {
    pendingUndo = null;
    run();
    hideUndo();
  }, UNDO_WINDOW_MS);
  pendingUndo = { run, revert, timer };
  showUndo(label);
}

/** Выполнить отложенное немедленно — например, перед другим действием. */
function flushUndo() {
  if (!pendingUndo) return;
  clearTimeout(pendingUndo.timer);
  const { run } = pendingUndo;
  pendingUndo = null;
  hideUndo();
  run();
}

function undoLast() {
  if (!pendingUndo) return false;
  clearTimeout(pendingUndo.timer);
  const { revert } = pendingUndo;
  pendingUndo = null;
  hideUndo();
  revert?.();
  toast("Отменено");
  return true;
}

function showUndo(label) {
  const node = $("undo-bar");
  node.querySelector("span").textContent = label;
  node.classList.add("visible");
}

function hideUndo() {
  $("undo-bar").classList.remove("visible");
}

$("undo-button").addEventListener("click", undoLast);

function deleteMessage(id, forBoth) {
  const conversation = conversationOf(state.current);
  if (!conversation) return;

  // Сообщение убираем с глаз сразу — иначе отложенное удаление выглядело бы
  // как «кнопка не сработала». Узлы держим, чтобы вернуть их при откате.
  const nodes = [...document.querySelectorAll(`[data-message-id="${CSS.escape(id)}"]`)];
  const anchors = nodes.map((node) => ({ node, next: node.nextSibling, parent: node.parentNode }));
  for (const node of nodes) node.remove();

  deferWithUndo(
    forBoth ? "Сообщение удаляется у обоих" : "Сообщение удаляется",
    () => submit({ type: "delete_message", conversation, id, for_both: forBoth }),
    () => {
      for (const { node, next, parent } of anchors) parent?.insertBefore(node, next);
    },
  );
}

function startReply(id, text) {
  replyingTo = { id, text: text.slice(0, 160) };
  renderReplyBar();
  $("composer").focus();
}

function renderReplyBar() {
  const existing = document.querySelector(".composer-reply");
  if (existing) existing.remove();
  if (!replyingTo) return;

  const bar = document.createElement("div");
  bar.className = "composer-reply";
  const label = document.createElement("span");
  label.textContent = `Ответ на: ${replyingTo.text}`;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost-button";
  cancel.textContent = "Отменить";
  cancel.addEventListener("click", () => {
    replyingTo = null;
    renderReplyBar();
  });
  bar.append(label, cancel);
  $("composer").closest(".composer").before(bar);
}

// --- «печатает» ---------------------------------------------------------------------

let typingSentAt = 0;
let typingStop = 0;

/**
 * Сигнал редкий намеренно: каждый — отдельный шифрованный конверт.
 *
 * Слать его на каждую букву значило бы утроить трафик и без пользы вращать
 * храповик MLS. Раз в четыре секунды достаточно, чтобы надпись не гасла.
 */
$("composer").addEventListener("input", () => {
  const peer = state.current;
  if (!peer || !permits("typing", peer)) return;

  const now = Date.now();
  if (now - typingSentAt > 4000) {
    typingSentAt = now;
    submit({ type: "typing", recipient_device: peer, active: true });
  }
  clearTimeout(typingStop);
  typingStop = setTimeout(() => {
    typingSentAt = 0;
    submit({ type: "typing", recipient_device: peer, active: false });
  }, 5000);
});

const typingPeers = new Map();

function showTyping(peer, active) {
  clearTimeout(typingPeers.get(peer));
  if (active) {
    // Страховка от потерянного «перестал печатать»: надпись обязана гаснуть
    // сама, иначе она залипнет навсегда.
    typingPeers.set(peer, setTimeout(() => showTyping(peer, false), 8000));
  } else {
    typingPeers.delete(peer);
  }
  if (peer !== state.current) return;
  const node = $("peer-state");
  if (active) {
    // Точки — отдельные элементы: так они действительно набирают, а не стоят
    // тремя символами в строке.
    node.textContent = "печатает";
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.append(document.createElement("i"), document.createElement("i"),
      document.createElement("i"));
    node.appendChild(dots);
    node.classList.add("typing");
  } else {
    node.classList.remove("typing");
    refreshPeerState();
  }
}

// --- присутствие -------------------------------------------------------------

/**
 * Когда собеседник в последний раз объявился.
 *
 * «В сети» здесь означает «прислал признак жизни недавно», а не «держит
 * соединение прямо сейчас». Сигнала о выходе не существует: связь рвётся молча,
 * и отправить его в этот момент уже нечем. Поэтому отметка устаревает сама —
 * иначе надпись «в сети» висела бы вечно и лгала.
 */
const seenOnline = new Map();

/** Сколько отметка считается свежей. */
const ONLINE_TTL = 5 * 60 * 1000;

function isOnline(peer) {
  const at = seenOnline.get(peer);
  return Boolean(at) && Date.now() - at < ONLINE_TTL;
}

/** Подпись под именем собеседника: набор текста важнее присутствия. */
function refreshPeerState() {
  const peer = state.current;
  const node = $("peer-state");
  if (!peer) return;
  if (typingPeers.has(peer)) return;
  node.classList.remove("typing");
  node.textContent = isOnline(peer) ? "в сети · контроль ключа включён" : "контроль ключа включён";
  node.title = "Приложение запоминает ключ собеседника и остановит отправку, если он неожиданно изменится";
}

// --- пароль при запуске (Windows) ------------------------------------------

/*
  Ключ базы лежит под DPAPI, привязанным к учётной записи Windows. Это защищает
  от «унесли диск», но не от программы, работающей под тем же пользователем:
  она попросит Windows расшифровать файл, и Windows расшифрует.

  Пароль превращается в «энтропию» DPAPI: без неё файл не открывается вовсе.
  Сам пароль никуда не пишется — отсюда и предупреждение о невосстановимости,
  которое стоит рядом с полем.
*/
$("form-locked").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("lock-password").value;
  if (!password) return;
  $("lock-error").textContent = "";
  try {
    await invoke("unlock_with_password", { password });
    $("lock-password").value = "";
    showBoot("Входим в аккаунт…");
    await submit({ type: "status" });
  } catch (error) {
    $("lock-error").textContent = String(error);
    $("lock-password").select();
  }
});

async function renderLockState() {
  try {
    const enabled = await invoke("app_lock_enabled");
    $("lock-state").textContent = enabled
      ? "Пароль включён: без него база не откроется."
      : "Пароль не задан: база открывается автоматически.";
  } catch (error) {
    $("lock-state").textContent = `Не удалось узнать состояние: ${String(error)}`;
  }
}

$("lock-apply").addEventListener("click", async () => {
  const current = $("lock-current").value;
  const next = $("lock-next").value;
  if (next && next.length < 8) {
    toast("Пароль запуска — от восьми знаков");
    return;
  }
  const apply = async () => {
    try {
      const enabled = await invoke("set_app_lock", { current, next });
      $("lock-current").value = "";
      $("lock-next").value = "";
      await renderLockState();
      toast(enabled ? "Пароль при запуске включён" : "Пароль при запуске снят");
    } catch (error) {
      toast(String(error));
    }
  };

  if (!next) {
    confirmAction(
      "Снять пароль при запуске?",
      "База снова будет открываться автоматически — как и для любой программы,"
      + " работающей под вашей учётной записью Windows.",
      apply,
    );
    return;
  }
  confirmAction(
    "Включить пароль при запуске?",
    "Его нигде не сохранят и не восстановят. Забудете — переписка на этом"
    + " устройстве останется закрытой навсегда.",
    apply,
  );
});

renderLockState();

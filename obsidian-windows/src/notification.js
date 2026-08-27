// Карточка уведомления: отдельное окно поверх остальных программ.
//
// Окно одно на все уведомления и переиспользуется, поэтому здесь два входа —
// скрипт инициализации с первым сообщением и событие со следующими.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const LIFETIME = 6500;
const card = document.getElementById("card");
const avatar = document.getElementById("avatar");
const sound = document.getElementById("sound");

// Свой акцент карточки поверх акцента приложения. «graphite» значит «как в
// приложении»: человек уже выбрал цвет в настройках, и навязывать второй
// незачем.
const accents = { violet: "#a98cff", blue: "#70a8ff", green: "#67d4a3" };

let closing = false;
let timer = null;

function dismiss() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  card.classList.add("leaving");
  // Окно закрывает Rust, но только после анимации ухода.
  setTimeout(() => invoke("dismiss_desktop_notification"), 180);
}

document.getElementById("close").addEventListener("click", dismiss);

function paint(payload) {
  if (closing) return;
  card.dataset.theme = payload.theme || "dark";
  card.style.setProperty("--accent", accents[payload.color] || payload.accent || "#f4f4f4");
  card.style.setProperty("--radius", `${payload.radius ?? 13}px`);
  card.style.setProperty("--avatar-radius", payload.squareAvatars ? "10px" : "50%");

  document.getElementById("title").textContent = payload.title || "Obsidian";
  document.getElementById("message").textContent = payload.text || "Новое сообщение";

  avatar.textContent = payload.initials || "O";
  if (payload.avatarMime && payload.avatarBase64) {
    avatar.style.backgroundImage = `url(data:${payload.avatarMime};base64,${payload.avatarBase64})`;
    avatar.classList.add("has-avatar");
  } else {
    avatar.style.removeProperty("background-image");
    avatar.classList.remove("has-avatar");
  }

  if (payload.sound) {
    sound.currentTime = 0;
    sound.play().catch(() => {});
  }

  // Перезапуск анимации появления: без этого следующее сообщение подменило бы
  // текст в уже стоящей карточке, и подмену никто бы не заметил.
  card.classList.remove("arriving");
  void card.offsetWidth;
  card.classList.add("arriving");

  clearTimeout(timer);
  timer = setTimeout(dismiss, LIFETIME);
}

listen("obsidian:notification", (event) => paint(event.payload));
paint(window.__OBSIDIAN_NOTIFICATION__ || {});

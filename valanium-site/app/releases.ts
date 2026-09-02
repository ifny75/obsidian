/**
 * Что именно раздаётся с сайта.
 *
 * Один источник на все страницы: раньше номера версий стояли по месту, и
 * страница канала уже успела сослаться на сборку, которой на сервере нет.
 * Файлы лежат в /opt/valanium-releases и раздаются nginx по /downloads/.
 */
export const RELEASES = {
  windows: { version: '0.11.0', size: '15,5 МБ', file: '/downloads/Valanium-0.11.0.exe' },
  android: { version: '0.6.2', size: '5,0 МБ', file: '/downloads/Valanium-0.6.2.apk' },
};

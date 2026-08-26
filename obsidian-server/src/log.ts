/**
 * Правило из ARCHITECTURE.md §13: сервер не логирует тела кадров, публичные
 * ключи, handle и IP. Логгер намеренно примитивен, чтобы не было соблазна
 * сунуть в него объект целиком.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold: number =
  LEVELS[(process.env["OBSIDIAN_LOG"] as Level | undefined) ?? "info"] ?? LEVELS.info;

function emit(level: Level, msg: string, fields?: Record<string, number | boolean | string>) {
  if (LEVELS[level] > threshold) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) line += ` ${k}=${v}`;
  }
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  error: (msg: string, fields?: Record<string, number | boolean | string>) => emit("error", msg, fields),
  warn: (msg: string, fields?: Record<string, number | boolean | string>) => emit("warn", msg, fields),
  info: (msg: string, fields?: Record<string, number | boolean | string>) => emit("info", msg, fields),
  debug: (msg: string, fields?: Record<string, number | boolean | string>) => emit("debug", msg, fields),
};

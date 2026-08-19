import path from 'node:path';

function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Не задана обязательная переменная окружения ${name}`);
  }
  return v.trim();
}

function num(name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} должно быть числом, получено: ${raw}`);
  if (v < min || v > max) throw new Error(`${name} должно быть в диапазоне [${min}, ${max}], получено: ${v}`);
  return v;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  return ['1', 'true', 'yes', 'on', 'да'].includes(raw.trim().toLowerCase());
}

function idList(name, def) {
  const raw = process.env[name];
  const src = raw === undefined || raw.trim() === '' ? def : raw;
  const ids = src
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const v = Number(s);
      if (!Number.isInteger(v)) throw new Error(`${name}: "${s}" не целое число`);
      return v;
    });
  return [...new Set(ids)];
}

// АЗС по умолчанию — Краснодар: 885 = Селезнева, 197/2; 886 = Уральская, 194/1.
// Топливо по умолчанию — 12 = АИ-95, 421 = G-95 (брендированный АИ-95).
// Справочник id топлива целиком см. в RESEARCH.md.
function build() {
  return {
  botToken: req('BOT_TOKEN'),
  stationIds: idList('TRACKED_STATIONS', '885,886'),
  fuelIds: idList('TRACKED_FUELS', '12,421'),

  pollIntervalSec: num('POLL_INTERVAL_SEC', 420, { min: 60, max: 86400 }),
  pollJitterPct: num('POLL_JITTER_PCT', 10, { min: 0, max: 50 }),

  notifyOnGone: bool('NOTIFY_ON_GONE', true),

  // Если API молчит дольше этого времени — предупреждаем, что данные протухли.
  // Молчание бота не должно читаться как «топлива нет». 0 = выключить.
  staleAlertMin: num('STALE_ALERT_MIN', 60, { min: 0, max: 1440 }),

  stateFile: path.resolve(process.env.STATE_FILE?.trim() || './data/state.json'),
  allowedUserIds: idList('ALLOWED_USER_IDS', ''),
  };
}

// Ошибка конфигурации всплывает при импорте модуля, поэтому ловим её здесь:
// иначе вместо внятной причины в логах контейнера будет голый стектрейс.
let parsed;
try {
  parsed = build();
} catch (err) {
  console.error(`\nОшибка конфигурации: ${err.message}`);
  console.error('Проверь переменные окружения — образец со всеми ключами лежит в .env.example\n');
  process.exit(1);
}

export const config = parsed;
export const staleAlertMs = config.staleAlertMin * 60_000;

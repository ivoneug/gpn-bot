import { log } from './logger.js';

const API_URL = 'https://gpnbonus.ru/api/stations/list';
const MAP_URL = 'https://gpnbonus.ru/fuel/refuel-map';

// Сайт отдаёт 403 на «безликие» User-Agent, поэтому представляемся десктопным Chrome.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Запасной справочник — используется, если ответ пришёл без oilProducts. */
const FALLBACK_FUELS = {
  1: 'ДТа', 12: 'АИ-95', 21: 'АИ-98', 62: 'АИ-92', 372: 'ДТл', 373: 'ГАЗ',
  374: 'ДТз', 421: 'G-95', 424: 'G-ДТ Л', 461: 'ДТм', 512: 'ДТ', 531: 'КПГ',
  541: 'ДТ Опти', 100032: 'G-100', 100036: 'АИ-100',
};

// Сокращения для длинных трассовых адресов — в том же виде, что в RESEARCH.md.
// \b в JS не работает с кириллицей, поэтому границу слова задаём через \p{L}:
// иначе "граница" после дефиса ("Кропоткин-граница") не попадёт под замену.
const ABBREVIATIONS = [
  [/(?<!\p{L})граница(?!\p{L})/gu, 'гр.'],
  [/(?<!\p{L})края(?!\p{L})/gu, 'кр.'],
  [/(?<!\p{L})области(?!\p{L})/gu, 'обл.'],
];

/**
 * Адреса приходят неряшливыми: двойные пробелы, пробелы вокруг дефисов,
 * номер дома вплотную к запятой. Пример из жизни (АЗС №10):
 * "Краснодар - Кропоткин - граница Ставропольского края  (3 км слева),1".
 */
function cleanAddress(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*-\s*/g, '-').replace(/\s*,\s*/g, ', ');
  for (const [re, to] of ABBREVIATIONS) s = s.replace(re, to);
  // У трассовых АЗС за скобкой с километром идёт номер дома — в сообщении он лишний.
  s = s.replace(/\)\s*,\s*\d+[а-я]?(\/\d+)?$/iu, ')');
  return s.trim();
}

/**
 * Приводит названия топлива к одному виду. API отдаёт shortTitle голым числом
 * ("92"), а title — с приставкой ("Бензин АИ-92"); в сообщениях хотим "АИ-92".
 * Брендированные (G-95) и дизельные (ДТл) названия остаются как есть.
 */
function normalizeFuelTitle(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (/^\d+$/.test(s)) return `АИ-${s}`;
  return s.replace(/^Бензин\s+/iu, '');
}

function normalizeStation(raw) {
  // Когда данных по АЗС нет, бэкенд отдаёт oils пустым массивом, а не объектом.
  const oilsRaw = raw.oils && !Array.isArray(raw.oils) ? raw.oils : {};
  const oils = new Map();
  for (const [key, value] of Object.entries(oilsRaw)) {
    const fuelId = Number(key);
    if (Number.isInteger(fuelId)) oils.set(fuelId, value === true);
  }
  return {
    id: raw.id,
    number: String(raw.PNPONumber ?? '').trim(),
    name: String(raw.name ?? '').trim(),
    city: String(raw.city ?? '').trim(),
    address: cleanAddress(raw.address),
    // Исходный адрес — чтобы /find находил и по неподрезанному написанию.
    rawAddress: String(raw.address ?? '').trim(),
    latitude: raw.latitude,
    longitude: raw.longitude,
    workMode: raw.workMode ?? null,
    workModeMessages: raw.workModeMessages ?? null,
    open: raw.open === true,
    oils,
    hasOilData: oils.size > 0,
  };
}

export function stationTitle(station) {
  const num = station.number ? `АЗС №${station.number}` : `АЗС id ${station.id}`;
  return station.address ? `${num}, ${station.address}` : num;
}

export function stationMapUrl(station) {
  const params = new URLSearchParams({ station: String(station.id) });
  if (station.latitude && station.longitude) {
    params.set('CenterLat', String(station.latitude));
    params.set('CenterLon', String(station.longitude));
  }
  return `${MAP_URL}#${params.toString()}`;
}

/**
 * Забирает весь список АЗС (~1925 шт., ~165 КБ по проводу с gzip).
 * Фильтров по региону у эндпоинта нет — отбор делаем на своей стороне.
 */
export async function fetchStations({ timeoutMs = 30_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = 2000 * 2 ** (attempt - 1);
      log.warn(`Повтор запроса к API через ${backoff} мс (попытка ${attempt + 1}/${retries + 1})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Referer: MAP_URL,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      // Ответ приходит с content-type: text/html, поэтому парсим текст вручную.
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Ответ не является JSON (первые 200 символов: ${text.slice(0, 200)})`);
      }
      if (!Array.isArray(data.stations)) throw new Error('В ответе нет массива stations');

      const stations = new Map();
      for (const raw of data.stations) {
        if (!Number.isInteger(raw?.id)) continue;
        stations.set(raw.id, normalizeStation(raw));
      }

      const fuels = new Map();
      for (const p of Array.isArray(data.oilProducts) ? data.oilProducts : []) {
        if (!Number.isInteger(p?.id)) continue;
        fuels.set(p.id, normalizeFuelTitle(p.shortTitle || p.title) || String(p.id));
      }
      for (const [id, title] of Object.entries(FALLBACK_FUELS)) {
        if (!fuels.has(Number(id))) fuels.set(Number(id), title);
      }

      log.debug(`Получено АЗС: ${stations.size}, видов топлива: ${fuels.size}`);
      return { stations, fuels, fetchedAt: Date.now() };
    } catch (err) {
      lastError = err;
      log.warn(`Запрос к API не удался: ${err.message}`);
    }
  }
  throw lastError;
}

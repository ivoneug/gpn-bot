import { config } from './config.js';
import { stationMapUrl, stationTitle } from './gpn.js';
import { getFuelState, getState } from './state.js';

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeRu(ts) {
  if (!ts) return 'никогда';
  return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false });
}

function agoRu(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч ${min % 60} мин назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

/** Одно сообщение на весь пакет изменений из одного опроса. */
export function formatEvents(events) {
  const appeared = events.filter((e) => e.direction === 'appeared');
  const gone = events.filter((e) => e.direction === 'gone');
  const lines = [];

  if (appeared.length > 0) {
    lines.push('⛽️ <b>Топливо появилось</b>');
    for (const e of appeared) {
      lines.push(
        `• <b>${esc(e.fuelTitle)}</b> — <a href="${stationMapUrl(e.station)}">${esc(stationTitle(e.station))}</a>`,
      );
    }
  }
  if (gone.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('🚫 <b>Топливо закончилось</b>');
    for (const e of gone) {
      lines.push(
        `• <b>${esc(e.fuelTitle)}</b> — <a href="${stationMapUrl(e.station)}">${esc(stationTitle(e.station))}</a>`,
      );
    }
  }
  lines.push('');
  lines.push(`<i>${esc(timeRu(events[0]?.at ?? Date.now()))} МСК</i>`);
  return lines.join('\n');
}

/** Текущее подтверждённое состояние по всем отслеживаемым АЗС. */
export function formatStatus(snapshot) {
  const state = getState();
  const lines = ['<b>Наличие топлива</b>', ''];

  if (!snapshot) {
    lines.push('Данных пока нет — первый опрос ещё не прошёл.');
    return lines.join('\n');
  }

  for (const stationId of config.stationIds) {
    const station = snapshot.stations.get(stationId);
    if (!station) {
      lines.push(`❓ АЗС id ${stationId} — нет в ответе API`);
      lines.push('');
      continue;
    }

    lines.push(`<a href="${stationMapUrl(station)}">${esc(stationTitle(station))}</a>`);
    if (!station.open) lines.push('  ⚠️ АЗС закрыта');
    if (!station.hasOilData) {
      lines.push('  нет данных о наличии');
      lines.push('');
      continue;
    }

    for (const fuelId of config.fuelIds) {
      const title = snapshot.fuels.get(fuelId) ?? String(fuelId);
      if (!station.oils.has(fuelId)) {
        lines.push(`  ▫️ ${esc(title)} — не продаётся на этой АЗС`);
        continue;
      }
      const live = station.oils.get(fuelId);
      const fs = getFuelState(stationId, fuelId);
      const since = fs.changedAt ? ` <i>(${agoRu(fs.changedAt)})</i>` : '';
      lines.push(`  ${live ? '✅' : '❌'} <b>${esc(title)}</b> — ${live ? 'есть' : 'нет'}${since}`);
    }
    lines.push('');
  }

  if (!state.lastPollAt) {
    lines.push('<i>Опрос ещё не завершался.</i>');
  } else {
    const ok = state.lastPollOk === false ? ', ⚠️ последний опрос не удался' : '';
    lines.push(`<i>Обновлено: ${esc(timeRu(state.lastPollAt))} МСК (${esc(agoRu(state.lastPollAt))})${ok}</i>`);
  }
  return lines.join('\n');
}

export function formatHealth({ stale, sinceMs, failures }) {
  if (!stale) return '✅ Связь с gpnbonus.ru восстановлена, данные снова свежие.';
  const min = Math.round(sinceMs / 60_000);
  const human = min < 120 ? `${min} мин` : `${Math.round(min / 60)} ч`;
  return [
    '⚠️ <b>Данные протухли</b>',
    '',
    `gpnbonus.ru не отвечает уже ${human} (неудачных опросов подряд: ${failures}).`,
    'Пока связи нет, отсутствие уведомлений <b>не</b> означает, что топлива нет.',
    'Продолжаю пытаться, о восстановлении сообщу.',
  ].join('\n');
}

export function formatHelp() {
  return [
    '<b>Бот следит за наличием топлива на АЗС Газпромнефти</b>',
    '',
    'Данные берутся с карты gpnbonus.ru и обновляются каждые ' +
      `${Math.round(config.pollIntervalSec / 60)} мин.`,
    '',
    '/start — подписаться на уведомления',
    '/stop — отписаться',
    '/status — текущее наличие на отслеживаемых АЗС',
    '/find &lt;запрос&gt; — найти АЗС по городу или адресу (чтобы добавить её id в конфиг)',
    '/help — эта справка',
    '',
    `О появлении топлива сообщаю сразу, на первом же опросе, где оно есть.` +
      (config.notifyOnGone
        ? ` Об окончании — тоже, но не чаще раза в ${config.notifyCooldownMin} мин.`
        : ''),
  ].join('\n');
}

export function formatFind(snapshot, query) {
  if (!snapshot) return 'Данных пока нет — первый опрос ещё не прошёл.';
  const q = query.trim().toLowerCase();
  if (q.length < 3) return 'Запрос слишком короткий — минимум 3 символа.';

  const found = [];
  for (const station of snapshot.stations.values()) {
    const haystack = `${station.city} ${station.address} ${station.number}`.toLowerCase();
    if (haystack.includes(q)) found.push(station);
    if (found.length >= 30) break;
  }
  if (found.length === 0) return `По запросу «${esc(query)}» ничего не нашлось.`;

  const lines = [`<b>Найдено: ${found.length}</b>`, ''];
  for (const s of found) {
    lines.push(`<code>${s.id}</code> — ${esc(s.city)}, ${esc(stationTitle(s))}`);
  }
  lines.push('');
  lines.push('<i>id можно добавить в TRACKED_STATIONS и перезапустить бота.</i>');
  return lines.join('\n');
}

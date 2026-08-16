import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const EMPTY = {
  version: 1,
  subscribers: [],
  fuelState: {}, // "<stationId>:<fuelId>" -> { confirmed, candidate, candidateCount, changedAt, notifiedAt }
  lastPollAt: 0,
  lastPollOk: null,
  lastSuccessAt: 0,
};

let state = structuredClone(EMPTY);
let writeQueue = Promise.resolve();

export function getState() {
  return state;
}

export function fuelKey(stationId, fuelId) {
  return `${stationId}:${fuelId}`;
}

export function getFuelState(stationId, fuelId) {
  const key = fuelKey(stationId, fuelId);
  if (!state.fuelState[key]) {
    state.fuelState[key] = {
      confirmed: null, // null = ещё не знаем (первый опрос задаёт базовую линию без уведомления)
      candidate: null,
      candidateCount: 0,
      changedAt: 0,
      notifiedAt: { appeared: 0, gone: 0 },
    };
  }
  const fs_ = state.fuelState[key];
  if (!fs_.notifiedAt) fs_.notifiedAt = { appeared: 0, gone: 0 };
  return fs_;
}

export async function load() {
  try {
    const raw = await fs.readFile(config.stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...structuredClone(EMPTY), ...parsed };
    state.subscribers = Array.isArray(parsed.subscribers) ? parsed.subscribers.filter(Number.isInteger) : [];
    state.fuelState = parsed.fuelState && typeof parsed.fuelState === 'object' ? parsed.fuelState : {};
    log.info(`Состояние загружено из ${config.stateFile} (подписчиков: ${state.subscribers.length})`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.info(`Файл состояния ${config.stateFile} не найден — начинаем с чистого листа`);
    } else {
      // Битый файл не должен ронять бота: логируем и стартуем заново.
      log.error(`Не удалось прочитать состояние (${err.message}) — начинаем с чистого листа`);
    }
    state = structuredClone(EMPTY);
  }
  return state;
}

/** Пишем через временный файл + rename, чтобы не оставить обрезанный JSON при падении. */
export function save() {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${config.stateFile}.tmp`;
    try {
      await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fs.rename(tmp, config.stateFile);
    } catch (err) {
      log.error(`Не удалось сохранить состояние: ${err.message}`);
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  });
  return writeQueue;
}

export function addSubscriber(chatId) {
  if (state.subscribers.includes(chatId)) return false;
  state.subscribers.push(chatId);
  save();
  return true;
}

export function removeSubscriber(chatId) {
  const idx = state.subscribers.indexOf(chatId);
  if (idx === -1) return false;
  state.subscribers.splice(idx, 1);
  save();
  return true;
}

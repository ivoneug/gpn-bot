import { config, cooldownMs, staleAlertMs } from './config.js';
import { fetchStations } from './gpn.js';
import { getFuelState, getState, save } from './state.js';
import { log } from './logger.js';

export class Tracker {
  /**
   * @param {(events: object[]) => Promise<void>} onEvents
   * @param {(info: {stale: boolean, sinceMs: number, failures: number}) => Promise<void>} [onHealth]
   */
  constructor(onEvents, onHealth) {
    this.onEvents = onEvents;
    this.onHealth = onHealth ?? (async () => {});
    this.snapshot = null;
    this.timer = null;
    this.stopped = false;
    this.warnedMissing = new Set();
    this.failures = 0;
    this.staleNotified = false;
    this.startedAt = Date.now();
  }

  nextDelayMs() {
    const base = config.pollIntervalSec * 1000;
    const jitter = base * (config.pollJitterPct / 100);
    return Math.round(base - jitter + Math.random() * 2 * jitter);
  }

  async start() {
    this.stopped = false;
    await this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    if (this.stopped) return;
    const delay = this.nextDelayMs();
    log.debug(`Следующий опрос через ${Math.round(delay / 1000)} с`);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  async tick() {
    const state = getState();
    try {
      const snapshot = await fetchStations();
      this.snapshot = snapshot;
      state.lastPollAt = snapshot.fetchedAt;
      state.lastSuccessAt = snapshot.fetchedAt;
      state.lastPollOk = true;

      const events = this.evaluate(snapshot);
      await save();

      const recovered = this.staleNotified;
      this.failures = 0;
      this.staleNotified = false;

      if (events.length > 0) {
        log.info(`Изменений к отправке: ${events.length}`);
        await this.onEvents(events);
      }
      if (recovered) await this.onHealth({ stale: false, sinceMs: 0, failures: 0 });
    } catch (err) {
      this.failures += 1;
      state.lastPollAt = Date.now();
      state.lastPollOk = false;
      await save();
      log.error(`Опрос не удался (подряд: ${this.failures}): ${err.message}`);

      // Данных нет — а значит, отсутствие уведомлений ничего не гарантирует. Скажем об этом вслух.
      const since = Date.now() - (state.lastSuccessAt || this.startedAt);
      if (staleAlertMs > 0 && !this.staleNotified && since > staleAlertMs) {
        this.staleNotified = true;
        await this.onHealth({ stale: true, sinceMs: since, failures: this.failures }).catch((e) =>
          log.error(`Не удалось отправить предупреждение о протухших данных: ${e.message}`),
        );
      }
    } finally {
      this.schedule();
    }
  }

  /** Сверяет свежий снимок с подтверждённым состоянием и возвращает события, достойные уведомления. */
  evaluate(snapshot) {
    const events = [];
    const now = Date.now();

    for (const stationId of config.stationIds) {
      const station = snapshot.stations.get(stationId);
      if (!station) {
        if (!this.warnedMissing.has(stationId)) {
          this.warnedMissing.add(stationId);
          log.warn(`АЗС id ${stationId} нет в ответе API — проверь TRACKED_STATIONS`);
        }
        continue;
      }
      this.warnedMissing.delete(stationId);

      if (!station.hasOilData) {
        log.debug(`АЗС id ${stationId}: API не отдаёт данные о наличии (oils пуст)`);
        continue;
      }

      for (const fuelId of config.fuelIds) {
        // АЗС просто не торгует этим топливом — не наш случай.
        if (!station.oils.has(fuelId)) continue;

        const value = station.oils.get(fuelId);
        const fs = getFuelState(stationId, fuelId);

        // Первый в жизни опрос по этой паре: запоминаем как базовую линию, не шумим.
        if (fs.confirmed === null) {
          fs.confirmed = value;
          fs.changedAt = now;
          log.info(`Базовое состояние: АЗС ${stationId} / топливо ${fuelId} = ${value}`);
          continue;
        }

        if (value === fs.confirmed) {
          fs.candidate = null;
          fs.candidateCount = 0;
          continue;
        }

        // Значение разошлось с подтверждённым — ждём подтверждения несколькими опросами подряд.
        if (fs.candidate === value) fs.candidateCount += 1;
        else {
          fs.candidate = value;
          fs.candidateCount = 1;
        }
        if (fs.candidateCount < config.confirmPolls) {
          log.debug(
            `АЗС ${stationId} / топливо ${fuelId}: кандидат ${value}, ` +
              `${fs.candidateCount}/${config.confirmPolls} подтверждений`,
          );
          continue;
        }

        fs.confirmed = value;
        fs.candidate = null;
        fs.candidateCount = 0;
        fs.changedAt = now;

        const direction = value ? 'appeared' : 'gone';
        if (direction === 'gone' && !config.notifyOnGone) continue;

        const lastNotified = fs.notifiedAt[direction] || 0;
        if (now - lastNotified < cooldownMs) {
          log.info(
            `Уведомление подавлено (cooldown): АЗС ${stationId} / топливо ${fuelId} / ${direction}`,
          );
          continue;
        }
        fs.notifiedAt[direction] = now;

        events.push({
          station,
          fuelId,
          fuelTitle: snapshot.fuels.get(fuelId) ?? String(fuelId),
          direction,
          at: now,
        });
      }
    }
    return events;
  }
}

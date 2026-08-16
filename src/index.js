import { config } from './config.js';
import { broadcast, createBot, setupCommands } from './bot.js';
import { stationTitle } from './gpn.js';
import { log } from './logger.js';
import { formatEvents, formatHealth } from './messages.js';
import { load, save } from './state.js';
import { Tracker } from './tracker.js';

async function main() {
  await load();

  const tracker = new Tracker(async (events) => {
    for (const e of events) {
      log.info(
        `Событие: ${e.direction === 'appeared' ? 'появилось' : 'закончилось'} ` +
          `${e.fuelTitle} — ${stationTitle(e.station)}`,
      );
    }
    await broadcast(bot, formatEvents(events));
  }, async (health) => {
    log.warn(`Здоровье опроса: ${health.stale ? 'данные протухли' : 'восстановлено'}`);
    await broadcast(bot, formatHealth(health));
  });

  const bot = createBot(() => tracker.snapshot);

  await bot.init();
  await setupCommands(bot);
  log.info(`Бот @${bot.botInfo.username} запущен`);
  log.info(
    `Отслеживаем АЗС: ${config.stationIds.join(', ')} | топливо: ${config.fuelIds.join(', ')} | ` +
      `опрос раз в ${config.pollIntervalSec} с (±${config.pollJitterPct}%)`,
  );

  // bot.start() резолвится только при остановке — не ждём его здесь.
  bot.start({ drop_pending_updates: true }).catch((err) => {
    log.error(`Long polling упал: ${err.stack || err}`);
    process.exit(1);
  });

  await tracker.start();

  // Первый снимок уже есть — покажем, что именно мы отслеживаем.
  if (tracker.snapshot) {
    for (const id of config.stationIds) {
      const s = tracker.snapshot.stations.get(id);
      log.info(s ? `  id ${id}: ${s.city}, ${stationTitle(s)}` : `  id ${id}: НЕ НАЙДЕНА в ответе API`);
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Получен ${signal}, останавливаюсь`);
    tracker.stop();
    await bot.stop().catch(() => {});
    await save();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  log.error(`Необработанный rejection: ${reason?.stack || reason}`);
});

main().catch((err) => {
  log.error(`Фатальная ошибка при запуске: ${err.stack || err}`);
  process.exit(1);
});

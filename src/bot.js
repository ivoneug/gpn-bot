import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from './config.js';
import { log } from './logger.js';
import { formatFind, formatHelp, formatStatus } from './messages.js';
import { addSubscriber, getState, removeSubscriber, save } from './state.js';

const SEND_OPTIONS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

const COMMANDS = [
  { command: 'status', description: 'Текущее наличие топлива' },
  { command: 'start', description: 'Подписаться на уведомления' },
  { command: 'stop', description: 'Отписаться от уведомлений' },
  { command: 'find', description: 'Найти АЗС по городу или адресу' },
  { command: 'help', description: 'Справка' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {() => object|null} getSnapshot — последний снимок данных от трекера
 * @param {{botInfo?: object}} [opts] — botInfo можно передать заранее, чтобы обойтись без init()
 */
export function createBot(getSnapshot, opts = {}) {
  const bot = new Bot(config.botToken, opts.botInfo ? { botInfo: opts.botInfo } : undefined);

  // Если задан белый список — чужие сообщения просто игнорируем.
  bot.use(async (ctx, next) => {
    if (config.allowedUserIds.length === 0) return next();
    const userId = ctx.from?.id;
    if (userId && config.allowedUserIds.includes(userId)) return next();
    log.warn(`Запрос от неразрешённого пользователя ${userId} (chat ${ctx.chat?.id}) — игнорируем`);
  });

  bot.command('start', async (ctx) => {
    const added = addSubscriber(ctx.chat.id);
    // Ждём записи на диск: перезапуск сразу после /start не должен терять подписку.
    await save();
    await ctx.reply(
      added ? '✅ Подписка оформлена. Буду писать, когда наличие изменится.' : 'Ты уже подписан.',
      SEND_OPTIONS,
    );
    await ctx.reply(formatStatus(getSnapshot()), SEND_OPTIONS);
  });

  bot.command('stop', async (ctx) => {
    const removed = removeSubscriber(ctx.chat.id);
    await save();
    await ctx.reply(removed ? '🔕 Отписал. Вернуться — /start' : 'Ты и так не подписан.', SEND_OPTIONS);
  });

  bot.command('status', async (ctx) => {
    await ctx.reply(formatStatus(getSnapshot()), SEND_OPTIONS);
  });

  bot.command('find', async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply('Укажи запрос, например: <code>/find Селезнева</code>', SEND_OPTIONS);
      return;
    }
    await ctx.reply(formatFind(getSnapshot(), query), SEND_OPTIONS);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(formatHelp(), SEND_OPTIONS);
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    if (e instanceof GrammyError) log.error(`Ошибка Telegram API (update ${ctx?.update?.update_id}): ${e.description}`);
    else if (e instanceof HttpError) log.error(`Не достучались до Telegram: ${e.message}`);
    else log.error(`Необработанная ошибка в обработчике: ${e?.stack || e}`);
  });

  return bot;
}

export async function setupCommands(bot) {
  try {
    await bot.api.setMyCommands(COMMANDS);
  } catch (err) {
    log.warn(`Не удалось задать список команд: ${err.message}`);
  }
}

function isDeadChat(err) {
  if (!(err instanceof GrammyError)) return false;
  const d = (err.description || '').toLowerCase();
  return (
    err.error_code === 403 ||
    d.includes('chat not found') ||
    d.includes('user is deactivated') ||
    d.includes('bot was blocked')
  );
}

/** Рассылает текст всем подписчикам, вычищая тех, кто заблокировал бота. */
export async function broadcast(bot, text) {
  const subscribers = [...getState().subscribers];
  if (subscribers.length === 0) {
    log.warn('Есть что отправить, но подписчиков нет — сообщение никуда не ушло');
    return;
  }

  for (const chatId of subscribers) {
    try {
      await bot.api.sendMessage(chatId, text, SEND_OPTIONS);
    } catch (err) {
      if (isDeadChat(err)) {
        log.warn(`Чат ${chatId} недоступен (${err.description}) — удаляю из подписчиков`);
        removeSubscriber(chatId);
      } else if (err instanceof GrammyError && err.error_code === 429) {
        const retryAfter = err.parameters?.retry_after ?? 5;
        log.warn(`Лимит Telegram, жду ${retryAfter} с и повторяю для чата ${chatId}`);
        await sleep((retryAfter + 1) * 1000);
        await bot.api.sendMessage(chatId, text, SEND_OPTIONS).catch((e) => {
          log.error(`Повторная отправка в чат ${chatId} не удалась: ${e.message}`);
        });
      } else {
        log.error(`Не удалось отправить в чат ${chatId}: ${err.message}`);
      }
    }
    await sleep(50); // Telegram не любит больше ~30 сообщений в секунду
  }
}

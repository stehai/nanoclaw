import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import {
  ASSISTANT_NAME,
  MOUNT_ALLOWLIST_PATH,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Read the first writable allowed root from the mount-allowlist, or fall back. */
function getFilesDir(): string {
  try {
    const raw = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
    const allowlist = JSON.parse(raw);
    const first = (
      allowlist.allowedRoots as Array<{
        path: string;
        allowReadWrite: boolean;
      }>
    )?.find((r) => r.allowReadWrite);
    if (first?.path) return first.path;
  } catch {}
  return path.resolve(process.cwd(), 'agent-home');
}

/** Download a Telegram file to a local path. */
async function downloadTelegramFile(
  url: string,
  destPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, { agent: https.globalAgent }, (res) => {
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private filesDir: string;
  private outboxWatcher: fs.FSWatcher | null = null;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    this.filesDir = getFilesDir();
  }

  /** Ensure inbox/outbox/sent directories exist. */
  private initFileDirs(): void {
    for (const dir of [
      path.join(this.filesDir, 'inbox'),
      path.join(this.filesDir, 'outbox', 'sent'),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Download a file from Telegram and deliver its path to the agent. */
  private async handleInboundFile(
    ctx: any,
    fileId: string,
    fileName: string,
  ): Promise<void> {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    try {
      const fileInfo = await this.bot!.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
      const destPath = path.join(this.filesDir, 'inbox', fileName);
      await downloadTelegramFile(fileUrl, destPath);

      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `[File received: ${destPath}]${caption}`,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, destPath }, 'Telegram file saved to inbox');
    } catch (err) {
      logger.error(
        { err, chatJid, fileName },
        'Failed to download Telegram file',
      );
    }
  }

  /** Watch outbox/ and send any new files via Telegram, then move to sent/. */
  private startOutboxWatcher(): void {
    const outboxDir = path.join(this.filesDir, 'outbox');
    const sentDir = path.join(outboxDir, 'sent');

    // Track files present at startup so we don't re-send them
    const knownFiles = new Set(
      fs.readdirSync(outboxDir).filter((f) => {
        const st = fs.statSync(path.join(outboxDir, f));
        return st.isFile();
      }),
    );

    const pending = new Set<string>();

    this.outboxWatcher = fs.watch(outboxDir, async (event, filename) => {
      if (!filename || pending.has(filename)) return;
      const filePath = path.join(outboxDir, filename);

      // Skip already-known files and non-files
      try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) return;
      } catch {
        return; // File already moved or doesn't exist
      }

      if (knownFiles.has(filename)) return;
      knownFiles.add(filename);
      pending.add(filename);

      // Small delay to let the write complete
      setTimeout(async () => {
        try {
          const groups = this.opts.registeredGroups();
          const telegramJids = Object.keys(groups).filter((jid) =>
            jid.startsWith('tg:'),
          );

          for (const jid of telegramJids) {
            const chatId = jid.replace(/^tg:/, '');
            await this.bot!.api.sendDocument(
              chatId,
              new InputFile(filePath, filename),
            );
            logger.info({ jid, filename }, 'Telegram outbox file sent');
          }

          // Move to sent/
          fs.renameSync(filePath, path.join(sentDir, filename));
        } catch (err) {
          logger.error({ err, filename }, 'Failed to send outbox file');
        } finally {
          pending.delete(filename);
        }
      }, 300);
    });

    logger.info({ outboxDir }, 'Telegram outbox watcher started');
  }

  async connect(): Promise<void> {
    this.initFileDirs();

    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      if (!doc) return;
      const ext = path.extname(doc.file_name || '') || '';
      const baseName = path.basename(doc.file_name || 'file', ext);
      const fileName = `${baseName}-${Date.now()}${ext}`;
      await this.handleInboundFile(ctx, doc.file_id, fileName);
    });

    this.bot.on('message:photo', async (ctx) => {
      // Use the highest-resolution photo
      const photos = ctx.message.photo;
      if (!photos?.length) return;
      const photo = photos[photos.length - 1];
      const fileName = `photo-${Date.now()}.jpg`;
      await this.handleInboundFile(ctx, photo.file_id, fileName);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          this.startOutboxWatcher();
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.outboxWatcher?.close();
    this.outboxWatcher = null;
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendPhoto(numericId, new InputFile(filePath), {
        caption,
      });
      logger.info({ jid, filePath }, 'Telegram image sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram image');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});

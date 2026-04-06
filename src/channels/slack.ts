import fs from 'fs';
import https from 'https';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type {
  BotMessageEvent,
  FileShareMessageEvent,
  GenericMessageEvent,
} from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined), bot messages
// (BotMessageEvent, subtype 'bot_message'), and file shares.
type HandledMessageEvent =
  | GenericMessageEvent
  | BotMessageEvent
  | FileShareMessageEvent;

type SlackInboundFile = NonNullable<FileShareMessageEvent['files']>[number];

function headerAsString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSlackOwnedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'slack.com' ||
    host.endsWith('.slack.com') ||
    host === 'slack-edge.com' ||
    host.endsWith('.slack-edge.com') ||
    host === 'slack-files.com' ||
    host.endsWith('.slack-files.com')
  );
}

async function downloadSlackFile(
  url: string,
  destPath: string,
  token: string,
  maxRedirects = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;
    const cleanup = (err: Error) => {
      if (settled) return;
      settled = true;
      fs.unlink(destPath, () => {});
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    file.on('error', cleanup);

    const fetchUrl = (currentUrl: string, redirectsLeft: number) => {
      const host = new URL(currentUrl).hostname;
      const includeAuth = isSlackOwnedHost(host);
      const req = https.get(
        currentUrl,
        {
          headers: includeAuth ? { Authorization: `Bearer ${token}` } : {},
          agent: https.globalAgent,
        },
        (res) => {
          const status = res.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            res.resume();
            const location = headerAsString(res.headers.location);
            if (!location) {
              file.close(() =>
                cleanup(
                  new Error(
                    `Slack file download redirect missing Location header (${status})`,
                  ),
                ),
              );
              return;
            }
            if (redirectsLeft <= 0) {
              file.close(() =>
                cleanup(new Error('Too many redirects downloading Slack file')),
              );
              return;
            }

            const nextUrl = new URL(location, currentUrl).toString();
            fetchUrl(nextUrl, redirectsLeft - 1);
            return;
          }

          if (status >= 400) {
            const err = new Error(
              `Slack file download failed (${status} ${res.statusMessage ?? ''})`,
            );
            res.resume();
            file.close(() => cleanup(err));
            return;
          }

          const contentType = (
            headerAsString(res.headers['content-type']) || ''
          ).toLowerCase();
          if (contentType.includes('text/html')) {
            res.resume();
            file.close(() =>
              cleanup(
                new Error(
                  `Slack file download returned HTML payload (${contentType || 'unknown content type'})`,
                ),
              ),
            );
            return;
          }

          file.once('finish', () => file.close(() => finish()));
          res.pipe(file);
        },
      );

      req.on('error', (err) => file.close(() => cleanup(err)));
    };

    fetchUrl(url, maxRedirects);
  });
}

function toSafeFileName(file: SlackInboundFile): string {
  const original = path.basename(file.name || file.id || 'file');
  const ext = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^\w.-]+/g, '-');
  return `${base || 'file'}-${Date.now()}${ext}`;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private botToken: string;

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }
    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message and file_share.
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the message types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share') {
        return;
      }

      // After filtering, event is one of the handled Slack message variants.
      const msg = event as HandledMessageEvent;
      const files = 'files' in msg && Array.isArray(msg.files) ? msg.files : [];

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;
      const group = groups[jid];

      const userId = msg.user;
      const botId = 'bot_id' in msg ? msg.bot_id : undefined;
      const isBotMessage = !!botId || userId === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (userId ? await this.resolveUserName(userId) : undefined) ||
          userId ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      if (content && this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      const fileMarkers: string[] = [];
      if (files.length > 0 && !isBotMessage) {
        const filesDir = resolveGroupFolderPath(group.folder);
        const inboxDir = path.join(filesDir, 'inbox');
        fs.mkdirSync(inboxDir, { recursive: true });

        for (const file of files) {
          const downloadUrl = file.url_private_download || file.url_private;
          if (!downloadUrl) {
            logger.warn(
              { jid, fileId: file.id },
              'Slack file is missing private download URL',
            );
            continue;
          }

          const fileName = toSafeFileName(file);
          const destPath = path.join(inboxDir, fileName);
          const agentPath = `/workspace/group/inbox/${fileName}`;

          try {
            await downloadSlackFile(downloadUrl, destPath, this.botToken);
            fileMarkers.push(`[File received: ${agentPath}]`);
            logger.info(
              { jid, destPath, agentPath },
              'Slack file saved to inbox',
            );
          } catch (err) {
            logger.error(
              { jid, fileName, downloadUrl, err },
              'Failed to download Slack file',
            );
          }
        }
      }

      if (fileMarkers.length > 0) {
        content = content
          ? `${content}\n${fileMarkers.join('\n')}`
          : fileMarkers.join('\n');
      }

      if (!content) return;

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: userId || botId || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.files.uploadV2({
        channel_id: channelId,
        file: fs.readFileSync(filePath),
        filename: path.basename(filePath),
        initial_comment: caption,
      });
      logger.info({ jid, filePath }, 'Slack image sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Slack image');
    }
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});

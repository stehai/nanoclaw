import { EventEmitter } from 'events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/groups/${folder}`),
}));

const fsMocks = vi.hoisted(() => ({
  watchMock: vi.fn(() => ({ close: vi.fn() })),
  mkdirSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(() => []),
  statSyncMock: vi.fn(() => ({ isFile: () => true })),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: fsMocks.mkdirSyncMock,
      readdirSync: fsMocks.readdirSyncMock,
      statSync: fsMocks.statSyncMock,
      renameSync: vi.fn(),
      unlink: vi.fn((_path, cb) => cb?.()),
      watch: fsMocks.watchMock,
      createWriteStream: vi.fn(() => {
        const stream = new EventEmitter() as EventEmitter & {
          close: (cb: () => void) => void;
        };
        stream.close = (cb: () => void) => cb();
        return stream;
      }),
    },
  };
});

vi.mock('https', async () => {
  const actual = await vi.importActual<typeof import('https')>('https');
  return {
    ...actual,
    default: {
      ...actual,
      globalAgent: {},
      get: vi.fn((_url, _opts, cb) => {
        cb({
          pipe: (file: EventEmitter) => {
            setTimeout(() => file.emit('finish'), 0);
          },
        });
        return { on: vi.fn().mockReturnThis() };
      }),
    },
  };
});

type Handler = (...args: any[]) => any;
const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    filterHandlers = new Map<string, Handler[]>();
    api = {
      getFile: vi.fn().mockResolvedValue({ file_path: 'docs/report.pdf' }),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
    };

    constructor(_token: string) {
      botRef.current = this;
    }

    command() {}

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch() {}

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
  InputFile: class InputFile {
    constructor(
      public filePath: string,
      public fileName?: string,
    ) {}
  },
}));

import { TelegramChannel } from './telegram.js';

function currentBot() {
  return botRef.current;
}

describe('TelegramChannel file paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
  });

  it('stores inbound Telegram documents in the group inbox and tells the agent the /workspace/group path', async () => {
    const onMessage = vi.fn();
    const channel = new TelegramChannel('test-token', {
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });

    await channel.connect();

    const handlers = currentBot().filterHandlers.get('message:document') || [];
    const ctx = {
      chat: { id: 100200300, type: 'group', title: 'Test Group' },
      from: { id: 99001, first_name: 'Alice', username: 'alice_user' },
      message: {
        date: Math.floor(Date.now() / 1000),
        message_id: 7,
        caption: 'please review',
        document: { file_id: 'doc-1', file_name: 'report.pdf' },
      },
    };

    for (const handler of handlers) {
      const pending = handler(ctx);
      await vi.runAllTimersAsync();
      await pending;
    }

    expect(fsMocks.mkdirSyncMock).toHaveBeenCalledWith('/tmp/groups/test-group/inbox', {
      recursive: true,
    });
    expect(fsMocks.mkdirSyncMock).toHaveBeenCalledWith(
      '/tmp/groups/test-group/outbox/sent',
      { recursive: true },
    );
    expect(onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content:
          '[File received: /workspace/group/inbox/report-1774180800000.pdf] please review',
      }),
    );
  });

  it('starts a dedicated outbox watcher for each registered Telegram group', async () => {
    const channel = new TelegramChannel('test-token', {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });

    await channel.connect();

    expect(fsMocks.watchMock).toHaveBeenCalledWith(
      '/tmp/groups/test-group/outbox',
      expect.any(Function),
    );
  });
});

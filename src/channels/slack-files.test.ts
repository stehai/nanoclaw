import { EventEmitter } from 'events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  })),
}));
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/groups/${folder}`),
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const fsMocks = vi.hoisted(() => ({
  mkdirSyncMock: vi.fn(),
  createWriteStreamMock: vi.fn((destPath: string) => {
    const stream = new EventEmitter() as EventEmitter & {
      close: (cb: () => void) => void;
      path: string;
    };
    stream.path = destPath;
    stream.close = (cb: () => void) => cb();
    return stream;
  }),
  unlinkMock: vi.fn((_path: string, cb?: () => void) => cb?.()),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: fsMocks.mkdirSyncMock,
      createWriteStream: fsMocks.createWriteStreamMock,
      unlink: fsMocks.unlinkMock,
      readFileSync: vi.fn(() => Buffer.from('test')),
    },
  };
});

type MockHttpResponse = {
  statusCode: number;
  location?: string;
  statusMessage?: string;
  headers?: Record<string, string>;
};

const httpState = vi.hoisted(() => ({
  responses: [] as MockHttpResponse[],
  calls: [] as Array<{ url: string; opts: any }>,
}));

vi.mock('https', async () => {
  const actual = await vi.importActual<typeof import('https')>('https');
  return {
    ...actual,
    default: {
      ...actual,
      globalAgent: {},
      get: vi.fn((url: string, opts: object, cb: (res: any) => void) => {
        httpState.calls.push({ url, opts });
        const current = httpState.responses.shift() || { statusCode: 200 };
        const res = {
          statusCode: current.statusCode,
          statusMessage:
            current.statusMessage ||
            (current.statusCode >= 400
              ? 'Forbidden'
              : current.statusCode >= 300
                ? 'Found'
                : 'OK'),
          headers: current.headers || (current.location ? { location: current.location } : {}),
          resume: vi.fn(),
          pipe: (file: EventEmitter) => {
            if (current.statusCode < 300 || current.statusCode >= 400) {
              file.emit('finish');
            }
          },
        };
        cb(res);
        return { on: vi.fn().mockReturnThis() };
      }),
    },
  };
});

type Handler = (...args: any[]) => any;
const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue(undefined),
      },
    };

    constructor(_opts: any) {
      appRef.current = this;
    }

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { SlackChannel, SlackChannelOpts } from './slack.js';

function createTestOpts(registered = true): SlackChannelOpts {
  const groups: Record<string, RegisteredGroup> = registered
    ? {
        'slack:C0123456789': {
          name: 'Test Channel',
          folder: 'test-channel',
          trigger: '@Jonesy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }
    : {};

  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => groups),
  };
}

function fileShareEvent(overrides: Partial<Record<string, any>> = {}) {
  return {
    type: 'message',
    subtype: 'file_share',
    channel: 'C0123456789',
    channel_type: 'channel',
    user: 'U_USER_456',
    text: 'Please review this',
    ts: '1704067200.000000',
    event_ts: '1704067200.000000',
    files: [
      {
        id: 'F123',
        name: 'report.pdf',
        url_private_download: 'https://files.slack.com/files-pri/T/F123/report',
      },
    ],
    ...overrides,
  };
}

async function triggerMessageEvent(event: ReturnType<typeof fileShareEvent>) {
  const handler = appRef.current.eventHandlers.get('message');
  if (handler) await handler({ event });
}

describe('SlackChannel inbound file shares', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
    httpState.responses = [];
    httpState.calls = [];
  });

  it('downloads shared files to group inbox and appends file marker to content', async () => {
    httpState.responses = [{ statusCode: 200 }];
    const opts = createTestOpts(true);
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(fileShareEvent());

    expect(fsMocks.mkdirSyncMock).toHaveBeenCalledWith(
      '/tmp/groups/test-channel/inbox',
      {
        recursive: true,
      },
    );
    expect(fsMocks.createWriteStreamMock).toHaveBeenCalledWith(
      '/tmp/groups/test-channel/inbox/report-1774180800000.pdf',
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content:
          'Please review this\n[File received: /workspace/group/inbox/report-1774180800000.pdf]',
      }),
    );
  });

  it('keeps mention translation when file marker is appended', async () => {
    httpState.responses = [{ statusCode: 200 }];
    const opts = createTestOpts(true);
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(
      fileShareEvent({ text: 'Hey <@U_BOT_123> check this file' }),
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content:
          '@Jonesy Hey <@U_BOT_123> check this file\n[File received: /workspace/group/inbox/report-1774180800000.pdf]',
      }),
    );
  });

  it('follows redirect to Slack CDN and keeps auth header', async () => {
    httpState.responses = [
      {
        statusCode: 302,
        location: 'https://files.slack-edge.com/files-pri/T/F123/report',
      },
      { statusCode: 200 },
    ];
    const opts = createTestOpts(true);
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(fileShareEvent());

    expect(httpState.calls).toHaveLength(2);
    expect(httpState.calls[0].url).toContain('files.slack.com');
    expect(httpState.calls[0].opts.headers.Authorization).toBe(
      'Bearer xoxb-test-token',
    );
    expect(httpState.calls[1].url).toContain('files.slack-edge.com');
    expect(httpState.calls[1].opts.headers.Authorization).toBe(
      'Bearer xoxb-test-token',
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content:
          'Please review this\n[File received: /workspace/group/inbox/report-1774180800000.pdf]',
      }),
    );
  });

  it('drops auth header on non-Slack redirect hop', async () => {
    httpState.responses = [
      {
        statusCode: 302,
        location: 'https://example.com/files/report',
      },
      { statusCode: 200 },
    ];
    const opts = createTestOpts(true);
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(fileShareEvent());

    expect(httpState.calls).toHaveLength(2);
    expect(httpState.calls[0].url).toContain('files.slack.com');
    expect(httpState.calls[0].opts.headers.Authorization).toBe(
      'Bearer xoxb-test-token',
    );
    expect(httpState.calls[1].url).toContain('example.com');
    expect(httpState.calls[1].opts.headers.Authorization).toBeUndefined();
    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content:
          'Please review this\n[File received: /workspace/group/inbox/report-1774180800000.pdf]',
      }),
    );
  });

  it('does not download files for unregistered channels', async () => {
    const opts = createTestOpts(false);
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(fileShareEvent({ channel: 'C9999999999' }));

    expect(opts.onChatMetadata).toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(fsMocks.createWriteStreamMock).not.toHaveBeenCalled();
  });

  it('logs download failures and still delivers text content', async () => {
    httpState.responses = [{ statusCode: 403 }];
    const opts = createTestOpts(true);
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(fileShareEvent({ text: 'Fallback text only' }));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jid: 'slack:C0123456789',
        fileName: 'report-1774180800000.pdf',
      }),
      'Failed to download Slack file',
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content: 'Fallback text only',
      }),
    );
  });

  it('rejects html payloads and keeps text-only content', async () => {
    httpState.responses = [
      {
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      },
    ];
    const opts = createTestOpts(true);
    const channel = new SlackChannel(opts);
    await channel.connect();

    await triggerMessageEvent(fileShareEvent({ text: 'Text with file' }));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jid: 'slack:C0123456789',
        fileName: 'report-1774180800000.pdf',
      }),
      'Failed to download Slack file',
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C0123456789',
      expect.objectContaining({
        content: 'Text with file',
      }),
    );
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  copyFileSync: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: fsMocks.existsSync,
      mkdirSync: fsMocks.mkdirSync,
      writeFileSync: fsMocks.writeFileSync,
      readFileSync: fsMocks.readFileSync,
      readdirSync: fsMocks.readdirSync,
      statSync: fsMocks.statSync,
      copyFileSync: fsMocks.copyFileSync,
    },
  };
});

// Mock mount-security
const mountSecurityMocks = vi.hoisted(() => ({
  loadMountAllowlist: vi.fn(() => null),
  validateAdditionalMounts: vi.fn(() => []),
}));
vi.mock('./mount-security.js', () => mountSecurityMocks);

vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host-gateway',
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn((hostPath: string, containerPath: string) => [
    '-v',
    `${hostPath}:${containerPath}:ro`,
  ]),
  stopContainer: vi.fn(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  exec: vi.fn(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    },
  ),
}));

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
    exec: childProcessMocks.exec,
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    childProcessMocks.spawn.mockReset();
    childProcessMocks.spawn.mockImplementation(() => fakeProc);
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockImplementation(() => false);
    fsMocks.mkdirSync.mockReset();
    fsMocks.writeFileSync.mockReset();
    fsMocks.readFileSync.mockReset();
    fsMocks.readFileSync.mockImplementation(() => '');
    fsMocks.readdirSync.mockReset();
    fsMocks.readdirSync.mockImplementation(() => []);
    fsMocks.statSync.mockReset();
    fsMocks.statSync.mockImplementation(() => ({ isDirectory: () => false }));
    fsMocks.copyFileSync.mockReset();
    mountSecurityMocks.loadMountAllowlist.mockReset();
    mountSecurityMocks.loadMountAllowlist.mockImplementation(() => null);
    mountSecurityMocks.validateAdditionalMounts.mockReset();
    mountSecurityMocks.validateAdditionalMounts.mockImplementation(() => []);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('does not rewrite host paths in the prompt', async () => {
    fsMocks.existsSync.mockImplementation(((target: any) => {
      const p = String(target);
      return (
        p === '/tmp/shared' ||
        p === '/tmp/nanoclaw-test-groups/test-group' ||
        p === '/tmp/nanoclaw-test-data/ipc/test-group/input/_close'
      );
    }) as any);
    mountSecurityMocks.loadMountAllowlist.mockImplementation((() => ({
      allowedRoots: [
        {
          path: '/tmp/shared',
          allowReadWrite: true,
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    }) as any));

    const prompt =
      'Open /tmp/shared/report.txt and summarize it for me exactly as written.';
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, prompt },
      () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const stdinPayload = fakeProc.stdin.read()?.toString() || '';
    expect(stdinPayload).toContain(prompt);
    expect(stdinPayload).not.toContain('/home/node/mounts/');
  });

  it('uses unique container paths for allowlist roots with the same basename', async () => {
    fsMocks.existsSync.mockImplementation(((target: any) => {
      const p = String(target);
      return (
        p === '/tmp/foo/files' ||
        p === '/var/data/files' ||
        p === '/tmp/nanoclaw-test-groups/test-group'
      );
    }) as any);
    mountSecurityMocks.loadMountAllowlist.mockImplementation((() => ({
      allowedRoots: [
        { path: '/tmp/foo/files', allowReadWrite: true },
        { path: '/var/data/files', allowReadWrite: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    }) as any));

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const [, args] = childProcessMocks.spawn.mock.calls[0];
    const mountArgs = args.filter((arg: string) => arg.startsWith('/tmp/foo/files:') || arg.startsWith('/var/data/files:'));
    expect(mountArgs).toHaveLength(2);
    expect(mountArgs[0]).not.toBe(mountArgs[1]);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';

import SftpClient from 'ssh2-sftp-client';

const HIDRIVE_HOST = process.env.HIDRIVE_HOST || 'sftp.hidrive.strato.com';
const HIDRIVE_USER = process.env.HIDRIVE_USER || 'nanoclaw';
const HIDRIVE_KEY_PATHS = [
  path.join(os.homedir(), '.ssh', 'strato-nanoclaw'),
  '/workspace/extra/hidrive-keys/strato-nanoclaw',
];
const CLIPBOARD_ROOT =
  process.env.HIDRIVE_CLIPBOARD_ROOT ||
  '/nanoclaw-agent/clipboard';
const DEFAULT_MAX_AGE_DAYS = 30;

interface RemoteEntry {
  name: string;
  type: string;
  modifyTime?: number;
}

interface CleanupResult {
  deletedFiles: string[];
  deletedDirs: string[];
  keptFiles: string[];
}

function parseArgs(args: string[]): { days: number; dryRun: boolean } {
  let days = DEFAULT_MAX_AGE_DAYS;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    if (arg === '--days' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (parsed > 0) days = parsed;
      i++;
    }
  }

  return { days, dryRun };
}

function getPrivateKey(): string {
  for (const keyPath of HIDRIVE_KEY_PATHS) {
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath, 'utf-8');
    }
  }
  throw new Error(
    `HiDrive SSH key not found. Checked: ${HIDRIVE_KEY_PATHS.join(', ')}`,
  );
}

function joinRemotePath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/, '')}/${child}`;
}

function isDirectory(entry: RemoteEntry): boolean {
  return entry.type === 'd';
}

async function cleanupDirectory(
  client: SftpClient,
  dirPath: string,
  cutoffMs: number,
  dryRun: boolean,
  result: CleanupResult,
): Promise<boolean> {
  const entries = (await client.list(dirPath)) as RemoteEntry[];
  let hasRemainingEntries = false;

  for (const entry of entries) {
    const entryPath = joinRemotePath(dirPath, entry.name);

    if (isDirectory(entry)) {
      const childHasContent = await cleanupDirectory(
        client,
        entryPath,
        cutoffMs,
        dryRun,
        result,
      );
      if (childHasContent) {
        hasRemainingEntries = true;
      } else {
        if (dryRun) {
          result.deletedDirs.push(entryPath);
        } else {
          await client.rmdir(entryPath, false);
          result.deletedDirs.push(entryPath);
        }
      }
      continue;
    }

    const modifiedMs = entry.modifyTime ?? 0;
    if (modifiedMs < cutoffMs) {
      if (dryRun) {
        result.deletedFiles.push(entryPath);
      } else {
        await client.delete(entryPath);
        result.deletedFiles.push(entryPath);
      }
    } else {
      result.keptFiles.push(entryPath);
      hasRemainingEntries = true;
    }
  }

  return hasRemainingEntries;
}

async function main(): Promise<void> {
  const { days, dryRun } = parseArgs(process.argv.slice(2));
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const client = new SftpClient();

  try {
    await client.connect({
      host: HIDRIVE_HOST,
      port: 22,
      username: HIDRIVE_USER,
      privateKey: getPrivateKey(),
      readyTimeout: 20000,
    });

    const rootExists = await client.exists(CLIPBOARD_ROOT);
    if (!rootExists) {
      throw new Error(`HiDrive clipboard path does not exist: ${CLIPBOARD_ROOT}`);
    }

    const result: CleanupResult = {
      deletedFiles: [],
      deletedDirs: [],
      keptFiles: [],
    };

    await cleanupDirectory(client, CLIPBOARD_ROOT, cutoffMs, dryRun, result);

    const mode = dryRun ? 'dry-run' : 'deleted';
    console.log(
      JSON.stringify(
        {
          mode,
          clipboardRoot: CLIPBOARD_ROOT,
          maxAgeDays: days,
          deletedFiles: result.deletedFiles.length,
          deletedDirs: result.deletedDirs.length,
          keptFiles: result.keptFiles.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});

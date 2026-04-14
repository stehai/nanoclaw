import fs from 'fs';
import path from 'path';

import { MCP_CREDENTIALS_PATH } from './config.js';
import { logger } from './logger.js';

export interface OAuth2Credential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string[];
  updatedAt?: string;
}

interface McpCredentialStore {
  oauth2?: Record<string, OAuth2Credential>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureSecureMode(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn(
        { filePath, mode: mode.toString(8) },
        'MCP credentials file is too permissive; expected 600',
      );
    }
  } catch {
    // ignore
  }
}

function loadStore(): McpCredentialStore {
  if (!fs.existsSync(MCP_CREDENTIALS_PATH)) return {};
  ensureSecureMode(MCP_CREDENTIALS_PATH);
  try {
    const raw = fs.readFileSync(MCP_CREDENTIALS_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      logger.warn(
        { path: MCP_CREDENTIALS_PATH },
        'Invalid MCP credentials format (expected object)',
      );
      return {};
    }
    return parsed as McpCredentialStore;
  } catch (err) {
    logger.warn(
      { err, path: MCP_CREDENTIALS_PATH },
      'Failed to read MCP credentials store',
    );
    return {};
  }
}

function saveStore(store: McpCredentialStore): void {
  fs.mkdirSync(path.dirname(MCP_CREDENTIALS_PATH), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(
    MCP_CREDENTIALS_PATH,
    JSON.stringify(store, null, 2) + '\n',
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(MCP_CREDENTIALS_PATH, 0o600);
  } catch {
    // ignore
  }
}

export function getOAuth2Credential(key: string): OAuth2Credential | null {
  const store = loadStore();
  const value = store.oauth2?.[key];
  if (!value || typeof value.accessToken !== 'string' || !value.accessToken) {
    return null;
  }
  return value;
}

export function setOAuth2Credential(
  key: string,
  credential: OAuth2Credential,
): void {
  const store = loadStore();
  if (!store.oauth2) store.oauth2 = {};
  store.oauth2[key] = {
    ...credential,
    updatedAt: new Date().toISOString(),
  };
  saveStore(store);
}

export function deleteOAuth2Credential(key: string): void {
  const store = loadStore();
  if (!store.oauth2?.[key]) return;
  delete store.oauth2[key];
  saveStore(store);
}

export function isOAuth2CredentialExpired(
  credential: OAuth2Credential,
  now = Date.now(),
): boolean {
  if (!credential.expiresAt) return false;
  const expires = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires <= now;
}

import fs from 'fs';

import { MCP_SERVERS_CONFIG_PATH } from './config.js';
import { getOAuth2Credential } from './mcp-credentials.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type TransportType = 'http' | 'sse' | 'stdio';
export type AuthType = 'none' | 'api_key' | 'oauth2_pkce';

const RESERVED_NAMES = new Set(['nanoclaw', 'open_brain']);
const MCP_PROXY_PREFIX = '/_nanoclaw/mcp/';

export interface McpAuthConfig {
  type: AuthType;
  envKey?: string;
  credentialKey?: string;
  header?: string;
  prefix?: string;
  targetEnvVar?: string;
  clientId?: string;
  scopes: string[];
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  callbackMode?: 'hosted' | 'manual';
}

export interface McpServerPolicy {
  mainOnly: boolean;
  allowGroups: string[];
  denyGroups: string[];
  allowedTools: string[];
  deniedTools: string[];
}

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: TransportType;
  url?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  envFrom: string[];
  headers: Record<string, string>;
  auth: McpAuthConfig;
  policy: McpServerPolicy;
}

export interface ProxyMcpTarget {
  name: string;
  url: string;
  headers: Record<string, string>;
  auth: McpAuthConfig;
}

export interface ExternalContainerMcpServer {
  name: string;
  transport: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  allowedTools: string[];
  deniedTools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && !!v);
}

function validServerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

function parseAuthConfig(value: Record<string, unknown>): McpAuthConfig {
  const authObj = isRecord(value.auth) ? value.auth : {};
  const authType = asString(authObj.type) || 'none';
  if (authType === 'api_key') {
    return {
      type: 'api_key',
      envKey: asString(authObj.envKey) || undefined,
      header: asString(authObj.header) || undefined,
      prefix: asString(authObj.prefix) || undefined,
      targetEnvVar: asString(authObj.targetEnvVar) || undefined,
      scopes: [],
    };
  }
  if (authType === 'oauth2_pkce') {
    const callbackMode = asString(authObj.callbackMode);
    return {
      type: 'oauth2_pkce',
      credentialKey: asString(authObj.credentialKey) || undefined,
      header: asString(authObj.header) || undefined,
      prefix: asString(authObj.prefix) || undefined,
      targetEnvVar: asString(authObj.targetEnvVar) || undefined,
      clientId: asString(authObj.clientId) || undefined,
      scopes: parseStringArray(authObj.scopes),
      issuer: asString(authObj.issuer) || undefined,
      authorizationEndpoint:
        asString(authObj.authorizationEndpoint) || undefined,
      tokenEndpoint: asString(authObj.tokenEndpoint) || undefined,
      callbackMode:
        callbackMode === 'manual' || callbackMode === 'hosted'
          ? callbackMode
          : 'hosted',
    };
  }
  return { type: 'none', scopes: [] };
}

function parsePolicy(value: Record<string, unknown>): McpServerPolicy {
  const policyObj = isRecord(value.policy) ? value.policy : {};
  return {
    mainOnly: policyObj.mainOnly === true,
    allowGroups: parseStringArray(policyObj.allowGroups),
    denyGroups: parseStringArray(policyObj.denyGroups),
    allowedTools: parseStringArray(policyObj.allowedTools),
    deniedTools: parseStringArray(policyObj.deniedTools),
  };
}

export function loadMcpServerConfigs(): McpServerConfig[] {
  if (!fs.existsSync(MCP_SERVERS_CONFIG_PATH)) return [];

  let rawText = '';
  try {
    rawText = fs.readFileSync(MCP_SERVERS_CONFIG_PATH, 'utf-8');
  } catch (err) {
    logger.warn(
      { err, path: MCP_SERVERS_CONFIG_PATH },
      'Failed to read MCP server configuration',
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    logger.warn(
      { err, path: MCP_SERVERS_CONFIG_PATH },
      'Invalid JSON in MCP server configuration',
    );
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.servers)) {
    logger.warn(
      { path: MCP_SERVERS_CONFIG_PATH },
      'MCP server configuration must contain a "servers" array',
    );
    return [];
  }

  const result: McpServerConfig[] = [];
  for (const value of parsed.servers) {
    if (!isRecord(value)) continue;

    const name = asString(value.name);
    const transport = asString(value.transport);
    if (!name || !validServerName(name) || RESERVED_NAMES.has(name)) {
      logger.warn(
        { name },
        'Skipping MCP server with invalid or reserved name',
      );
      continue;
    }
    if (transport !== 'http' && transport !== 'sse' && transport !== 'stdio') {
      logger.warn(
        { name, transport },
        'Skipping MCP server with invalid transport',
      );
      continue;
    }

    const enabled = value.enabled !== false;
    const args = parseStringArray(value.args);
    const env: Record<string, string> = {};
    if (isRecord(value.env)) {
      for (const [k, v] of Object.entries(value.env)) {
        if (typeof v === 'string') env[k] = v;
      }
    }

    const headers: Record<string, string> = {};
    if (isRecord(value.headers)) {
      for (const [k, v] of Object.entries(value.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }

    const command = asString(value.command) || undefined;
    const url = asString(value.url) || undefined;
    if (transport === 'stdio' && !command) {
      logger.warn({ name }, 'Skipping stdio MCP server without command');
      continue;
    }
    if ((transport === 'http' || transport === 'sse') && !url) {
      logger.warn({ name }, 'Skipping remote MCP server without URL');
      continue;
    }
    if (url) {
      try {
        new URL(url);
      } catch {
        logger.warn({ name, url }, 'Skipping MCP server with invalid URL');
        continue;
      }
    }

    result.push({
      name,
      enabled,
      transport,
      url,
      command,
      args,
      env,
      envFrom: parseStringArray(value.envFrom),
      headers,
      auth: parseAuthConfig(value),
      policy: parsePolicy(value),
    });
  }

  return result;
}

export function getMcpServerConfigByName(
  serverName: string,
): McpServerConfig | null {
  for (const config of loadMcpServerConfigs()) {
    if (config.name === serverName) return config;
  }
  return null;
}

export function isMcpServerAllowedForGroup(
  server: McpServerConfig,
  groupFolder: string,
  isMain: boolean,
): boolean {
  if (server.policy.mainOnly && !isMain) return false;
  if (
    server.policy.allowGroups.length > 0 &&
    !server.policy.allowGroups.includes(groupFolder)
  ) {
    return false;
  }
  if (server.policy.denyGroups.includes(groupFolder)) return false;
  return true;
}

function lookupSecret(
  key: string,
  envFromFile: Record<string, string>,
): string | undefined {
  return process.env[key] || envFromFile[key];
}

function withAuthHeader(
  headers: Record<string, string>,
  headerName: string | undefined,
  prefix: string | undefined,
  token: string,
): Record<string, string> {
  const header = headerName || 'Authorization';
  const resolvedPrefix =
    prefix != null
      ? prefix
      : header.toLowerCase() === 'authorization'
        ? 'Bearer '
        : '';
  return { ...headers, [header]: `${resolvedPrefix}${token}` };
}

function resolveStdioEnv(
  server: McpServerConfig,
  envFromFile: Record<string, string>,
): Record<string, string> | null {
  const resolvedEnv: Record<string, string> = { ...server.env };
  for (const key of server.envFrom) {
    const value = lookupSecret(key, envFromFile);
    if (value) resolvedEnv[key] = value;
  }

  if (server.auth.type === 'api_key') {
    if (!server.auth.envKey) {
      logger.warn({ server: server.name }, 'MCP api_key auth missing envKey');
      return null;
    }
    const value = lookupSecret(server.auth.envKey, envFromFile);
    if (!value) {
      logger.warn(
        { server: server.name, envKey: server.auth.envKey },
        'Skipping MCP stdio server: missing API key env value',
      );
      return null;
    }
    const targetEnvVar = server.auth.targetEnvVar || 'MCP_API_KEY';
    resolvedEnv[targetEnvVar] = value;
  }

  if (server.auth.type === 'oauth2_pkce') {
    const credentialKey = server.auth.credentialKey || server.name;
    const credential = getOAuth2Credential(credentialKey);
    if (!credential?.accessToken) {
      logger.warn(
        { server: server.name, credentialKey },
        'Skipping MCP stdio server: OAuth credential not found',
      );
      return null;
    }
    const targetEnvVar = server.auth.targetEnvVar || 'MCP_ACCESS_TOKEN';
    resolvedEnv[targetEnvVar] = credential.accessToken;
  }

  return resolvedEnv;
}

function collectRequestedEnvKeys(servers: McpServerConfig[]): string[] {
  const keys = new Set<string>();
  for (const server of servers) {
    for (const key of server.envFrom) keys.add(key);
    if (server.auth.type === 'api_key' && server.auth.envKey) {
      keys.add(server.auth.envKey);
    }
  }
  return Array.from(keys);
}

function canUseRemoteServer(
  server: McpServerConfig,
  envFromFile: Record<string, string>,
): boolean {
  if (server.auth.type === 'none') return true;
  if (server.auth.type === 'api_key') {
    if (!server.auth.envKey) return false;
    return !!lookupSecret(server.auth.envKey, envFromFile);
  }
  const credentialKey = server.auth.credentialKey || server.name;
  const credential = getOAuth2Credential(credentialKey);
  return !!(credential?.accessToken || credential?.refreshToken);
}

export function resolveExternalMcpProxyTargets(): Map<string, ProxyMcpTarget> {
  const servers = loadMcpServerConfigs().filter(
    (server) => server.enabled && server.transport !== 'stdio',
  );

  const targets = new Map<string, ProxyMcpTarget>();
  for (const server of servers) {
    if (!server.url) continue;
    targets.set(server.name, {
      name: server.name,
      url: server.url,
      headers: { ...server.headers },
      auth: server.auth,
    });
  }
  return targets;
}

export function resolveExternalMcpServersForGroup(
  groupFolder: string,
  isMain: boolean,
): ExternalContainerMcpServer[] {
  const servers = loadMcpServerConfigs().filter((server) => server.enabled);
  const envKeys = collectRequestedEnvKeys(servers);
  const envFromFile = envKeys.length > 0 ? readEnvFile(envKeys) : {};

  const result: ExternalContainerMcpServer[] = [];
  for (const server of servers) {
    if (!isMcpServerAllowedForGroup(server, groupFolder, isMain)) continue;

    if (server.transport === 'http' || server.transport === 'sse') {
      if (!canUseRemoteServer(server, envFromFile)) continue;
      result.push({
        name: server.name,
        transport: server.transport,
        allowedTools: server.policy.allowedTools,
        deniedTools: server.policy.deniedTools,
      });
      continue;
    }

    const resolvedEnv = resolveStdioEnv(server, envFromFile);
    if (!resolvedEnv || !server.command) continue;
    result.push({
      name: server.name,
      transport: 'stdio',
      command: server.command,
      args: server.args,
      env: resolvedEnv,
      allowedTools: server.policy.allowedTools,
      deniedTools: server.policy.deniedTools,
    });
  }

  return result;
}

export function buildProxyPathForMcpServer(serverName: string): string {
  return `${MCP_PROXY_PREFIX}${encodeURIComponent(serverName)}`;
}

export function applyAuthTokenToHeaders(
  baseHeaders: Record<string, string>,
  auth: McpAuthConfig,
  token: string,
): Record<string, string> {
  return withAuthHeader(baseHeaders, auth.header, auth.prefix, token);
}

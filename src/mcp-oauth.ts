import { createHash, randomBytes } from 'crypto';

import { MCP_OAUTH_CALLBACK_BASE_URL } from './config.js';
import {
  getOAuth2Credential,
  isOAuth2CredentialExpired,
  setOAuth2Credential,
  deleteOAuth2Credential,
  OAuth2Credential,
} from './mcp-credentials.js';
import {
  getMcpServerConfigByName,
  isMcpServerAllowedForGroup,
  McpServerConfig,
} from './mcp-registry.js';
import { logger } from './logger.js';

interface OAuthDiscovery {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
}

interface PendingAuthFlow {
  serverName: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  credentialKey: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 30 * 1000;
const pendingFlows = new Map<string, PendingAuthFlow>();
const discoveryCache = new Map<string, OAuthDiscovery>();

function prunePendingFlows(now = Date.now()): void {
  for (const [state, flow] of pendingFlows.entries()) {
    if (flow.expiresAt <= now) pendingFlows.delete(state);
  }
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function resolveCallbackBaseUrl(): string {
  return MCP_OAUTH_CALLBACK_BASE_URL.replace(/\/+$/, '');
}

function callbackUrl(): string {
  const base = resolveCallbackBaseUrl();
  if (!base) {
    throw new Error(
      'MCP_OAUTH_CALLBACK_BASE_URL is not configured. Set it to your public NanoClaw URL (e.g. https://assistant.example.com).',
    );
  }
  return `${base}/_nanoclaw/oauth/callback`;
}

function isLikelyExpired(credential: OAuth2Credential): boolean {
  if (!credential.expiresAt) return false;
  const expires = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires - REFRESH_SKEW_MS <= Date.now();
}

async function fetchOAuthDiscovery(server: McpServerConfig): Promise<OAuthDiscovery> {
  const cached = discoveryCache.get(server.name);
  if (cached) return cached;

  const issuer = server.auth.issuer || (server.url ? new URL(server.url).origin : '');
  if (!issuer) return {};

  const url = `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      logger.warn(
        { server: server.name, status: response.status },
        'OAuth discovery endpoint returned non-OK status',
      );
      return {};
    }
    const payload = (await response.json()) as OAuthDiscovery;
    discoveryCache.set(server.name, payload);
    return payload;
  } catch (err) {
    logger.warn(
      { server: server.name, err },
      'OAuth discovery request failed',
    );
    return {};
  }
}

async function resolveOAuthEndpoints(server: McpServerConfig): Promise<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
}> {
  const discovered = await fetchOAuthDiscovery(server);
  const authorizationEndpoint =
    server.auth.authorizationEndpoint || discovered.authorization_endpoint;
  const tokenEndpoint = server.auth.tokenEndpoint || discovered.token_endpoint;

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(
      `OAuth endpoints missing for "${server.name}". Configure auth.authorizationEndpoint/auth.tokenEndpoint or auth.issuer in mcp-servers.json.`,
    );
  }
  return { authorizationEndpoint, tokenEndpoint };
}

function requireOauthServer(
  serverName: string,
  groupFolder: string,
  isMain: boolean,
): McpServerConfig {
  const server = getMcpServerConfigByName(serverName);
  if (!server || !server.enabled) {
    throw new Error(`MCP server "${serverName}" is not configured or disabled.`);
  }
  if (!isMcpServerAllowedForGroup(server, groupFolder, isMain)) {
    throw new Error(`MCP server "${serverName}" is not allowed for this group.`);
  }
  if (server.auth.type !== 'oauth2_pkce') {
    throw new Error(`MCP server "${serverName}" is not configured for OAuth2.`);
  }
  if (!server.auth.clientId) {
    throw new Error(
      `MCP server "${serverName}" is missing auth.clientId in mcp-servers.json.`,
    );
  }
  return server;
}

function buildAuthUrl(
  authorizationEndpoint: string,
  params: Record<string, string>,
): string {
  const url = new URL(authorizationEndpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function tokenExpiryIso(expiresIn: unknown): string | undefined {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

async function exchangeToken(
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string[];
}> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${payload?.error_description || payload?.error || text || 'unknown error'}`,
    );
  }

  const accessToken = payload?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('OAuth token response missing access_token');
  }

  return {
    accessToken,
    refreshToken:
      typeof payload?.refresh_token === 'string'
        ? payload.refresh_token
        : undefined,
    tokenType:
      typeof payload?.token_type === 'string' ? payload.token_type : undefined,
    scope:
      typeof payload?.scope === 'string'
        ? payload.scope.split(/\s+/).filter(Boolean)
        : undefined,
    expiresAt: tokenExpiryIso(payload?.expires_in),
  };
}

export async function startMcpOAuthFlow(
  serverName: string,
  groupFolder: string,
  isMain: boolean,
): Promise<{
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}> {
  prunePendingFlows();
  const server = requireOauthServer(serverName, groupFolder, isMain);
  const { authorizationEndpoint, tokenEndpoint } =
    await resolveOAuthEndpoints(server);
  const redirectUri = callbackUrl();

  const state = base64Url(randomBytes(16));
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(
    createHash('sha256').update(codeVerifier).digest(),
  );
  const scopes = server.auth.scopes;
  const authorizationUrl = buildAuthUrl(authorizationEndpoint, {
    response_type: 'code',
    client_id: server.auth.clientId || '',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const flow: PendingAuthFlow = {
    serverName: server.name,
    state,
    codeVerifier,
    redirectUri,
    tokenEndpoint,
    clientId: server.auth.clientId || '',
    credentialKey: server.auth.credentialKey || server.name,
    scopes,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
  pendingFlows.set(state, flow);

  return {
    authorizationUrl,
    state,
    expiresAt: new Date(flow.expiresAt).toISOString(),
  };
}

function formatHtml(title: string, message: string): string {
  const safeTitle = title.replace(/[<>&"]/g, '');
  const safeMessage = message.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${safeTitle}</title></head>
<body style="font-family:system-ui;padding:24px;max-width:720px;margin:auto">
<h1>${safeTitle}</h1>
<p>${safeMessage}</p>
</body>
</html>`;
}

async function finalizeAuthCode(
  flow: PendingAuthFlow,
  code: string,
): Promise<void> {
  const exchanged = await exchangeToken(
    flow.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: flow.clientId,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.codeVerifier,
    }),
  );

  setOAuth2Credential(flow.credentialKey, {
    accessToken: exchanged.accessToken,
    refreshToken: exchanged.refreshToken,
    expiresAt: exchanged.expiresAt,
    tokenType: exchanged.tokenType,
    scope: exchanged.scope || flow.scopes,
  });
}

export async function completeMcpOAuthCallback(
  params: URLSearchParams,
): Promise<{
  ok: boolean;
  message: string;
  html: string;
}> {
  prunePendingFlows();

  const state = params.get('state') || '';
  const code = params.get('code') || '';
  const error = params.get('error') || '';
  const errorDescription = params.get('error_description') || '';

  if (!state) {
    const message = 'Missing OAuth state.';
    return { ok: false, message, html: formatHtml('OAuth Failed', message) };
  }
  const flow = pendingFlows.get(state);
  if (!flow) {
    const message = 'OAuth state is invalid or expired.';
    return { ok: false, message, html: formatHtml('OAuth Failed', message) };
  }

  if (error) {
    pendingFlows.delete(state);
    const message = `OAuth provider returned error: ${errorDescription || error}`;
    return { ok: false, message, html: formatHtml('OAuth Failed', message) };
  }
  if (!code) {
    const message = 'Missing authorization code.';
    return { ok: false, message, html: formatHtml('OAuth Failed', message) };
  }

  try {
    await finalizeAuthCode(flow, code);
    pendingFlows.delete(state);
    const message = `Connected ${flow.serverName}. You can return to chat.`;
    return { ok: true, message, html: formatHtml('OAuth Connected', message) };
  } catch (err) {
    pendingFlows.delete(state);
    const message =
      err instanceof Error ? err.message : 'OAuth callback exchange failed';
    return { ok: false, message, html: formatHtml('OAuth Failed', message) };
  }
}

export async function completeMcpOAuthManual(
  serverName: string,
  code: string,
  state: string | undefined,
  groupFolder: string,
  isMain: boolean,
): Promise<{ ok: boolean; message: string }> {
  prunePendingFlows();
  requireOauthServer(serverName, groupFolder, isMain);

  let flow: PendingAuthFlow | undefined;
  if (state) {
    flow = pendingFlows.get(state);
  } else {
    flow = Array.from(pendingFlows.values()).find(
      (entry) => entry.serverName === serverName,
    );
  }
  if (!flow) {
    return {
      ok: false,
      message:
        'No pending OAuth flow found for this server. Start auth again first.',
    };
  }
  if (!code) {
    return { ok: false, message: 'Authorization code is required.' };
  }

  try {
    await finalizeAuthCode(flow, code);
    pendingFlows.delete(flow.state);
    return {
      ok: true,
      message: `Connected ${flow.serverName}.`,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'OAuth code exchange failed';
    return { ok: false, message };
  }
}

export async function getMcpOAuthStatus(
  serverName: string,
  groupFolder: string,
  isMain: boolean,
): Promise<{
  ok: boolean;
  status: 'connected' | 'pending' | 'expired' | 'not_connected' | 'invalid';
  message: string;
}> {
  prunePendingFlows();

  let server: McpServerConfig;
  try {
    server = requireOauthServer(serverName, groupFolder, isMain);
  } catch (err) {
    return {
      ok: false,
      status: 'invalid',
      message: err instanceof Error ? err.message : 'Invalid server',
    };
  }

  const hasPending = Array.from(pendingFlows.values()).some(
    (flow) => flow.serverName === server.name,
  );
  if (hasPending) {
    return {
      ok: true,
      status: 'pending',
      message: `OAuth flow pending for ${server.name}. Complete browser login.`,
    };
  }

  const credentialKey = server.auth.credentialKey || server.name;
  const credential = getOAuth2Credential(credentialKey);
  if (!credential?.accessToken) {
    return {
      ok: true,
      status: 'not_connected',
      message: `${server.name} is not connected.`,
    };
  }

  if (isLikelyExpired(credential) && !credential.refreshToken) {
    return {
      ok: true,
      status: 'expired',
      message: `${server.name} token expired and cannot be refreshed. Reconnect required.`,
    };
  }

  return {
    ok: true,
    status: 'connected',
    message: `${server.name} is connected.`,
  };
}

export function disconnectMcpOAuth(
  serverName: string,
  groupFolder: string,
  isMain: boolean,
): { ok: boolean; message: string } {
  let server: McpServerConfig;
  try {
    server = requireOauthServer(serverName, groupFolder, isMain);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Invalid server',
    };
  }

  const credentialKey = server.auth.credentialKey || server.name;
  deleteOAuth2Credential(credentialKey);
  for (const [state, flow] of pendingFlows.entries()) {
    if (flow.serverName === server.name) pendingFlows.delete(state);
  }
  return { ok: true, message: `${server.name} disconnected.` };
}

async function refreshOAuthToken(
  server: McpServerConfig,
  credential: OAuth2Credential,
): Promise<OAuth2Credential | null> {
  if (!credential.refreshToken) return null;

  const endpoints = await resolveOAuthEndpoints(server);
  const exchanged = await exchangeToken(
    endpoints.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: server.auth.clientId || '',
      scope: server.auth.scopes.join(' '),
    }),
  );

  const nextCredential: OAuth2Credential = {
    accessToken: exchanged.accessToken,
    refreshToken: exchanged.refreshToken || credential.refreshToken,
    expiresAt: exchanged.expiresAt,
    tokenType: exchanged.tokenType || credential.tokenType,
    scope: exchanged.scope || credential.scope || server.auth.scopes,
  };

  setOAuth2Credential(server.auth.credentialKey || server.name, nextCredential);
  return nextCredential;
}

export async function getValidOAuthAccessToken(
  serverName: string,
): Promise<string | null> {
  const server = getMcpServerConfigByName(serverName);
  if (!server || server.auth.type !== 'oauth2_pkce') return null;

  const credentialKey = server.auth.credentialKey || server.name;
  const credential = getOAuth2Credential(credentialKey);
  if (!credential) return null;
  if (!credential.accessToken && !credential.refreshToken) return null;
  if (!credential.accessToken && credential.refreshToken) {
    try {
      const refreshed = await refreshOAuthToken(server, credential);
      return refreshed?.accessToken || null;
    } catch (err) {
      logger.warn(
        { server: serverName, err },
        'Failed to refresh OAuth token without existing access token',
      );
      return null;
    }
  }

  if (!isLikelyExpired(credential)) return credential.accessToken;
  if (!credential.refreshToken) return null;

  try {
    const refreshed = await refreshOAuthToken(server, credential);
    return refreshed?.accessToken || null;
  } catch (err) {
    logger.warn(
      { server: serverName, err },
      'Failed to refresh OAuth token',
    );
    return null;
  }
}

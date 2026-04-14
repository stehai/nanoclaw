/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  applyAuthTokenToHeaders,
  resolveExternalMcpProxyTargets,
} from './mcp-registry.js';
import {
  completeMcpOAuthCallback,
  completeMcpOAuthManual,
  disconnectMcpOAuth,
  getMcpOAuthStatus,
  getValidOAuthAccessToken,
  startMcpOAuthFlow,
} from './mcp-oauth.js';
import {
  validateMcpControlGrant,
  validateMcpProxyGrant,
} from './mcp-proxy-grants.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const MCP_PROXY_PREFIX = '/_nanoclaw/mcp/';
const MCP_OAUTH_PREFIX = '/_nanoclaw/oauth/';

function stripHopByHopHeaders(
  headers: Record<string, string | number | string[] | undefined>,
): void {
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
}

function parseMcpProxyRequest(reqUrl: string): {
  serverName: string;
  pathSuffix: string;
  query: string;
  grant: string;
} | null {
  const parsed = new URL(reqUrl, 'http://nanoclaw-proxy.local');
  if (!parsed.pathname.startsWith(MCP_PROXY_PREFIX)) return null;

  const remainder = parsed.pathname.slice(MCP_PROXY_PREFIX.length);
  const parts = remainder.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const [encodedServerName, ...suffixParts] = parts;
  const serverName = decodeURIComponent(encodedServerName);
  const grant = parsed.searchParams.get('grant') || '';
  if (!serverName || !grant) return null;

  parsed.searchParams.delete('grant');
  const query = parsed.searchParams.toString();
  const pathSuffix = suffixParts.length > 0 ? `/${suffixParts.join('/')}` : '';

  return { serverName, pathSuffix, query, grant };
}

function buildUpstreamPath(
  basePath: string,
  suffix: string,
  query: string,
): string {
  const normalizedBase = basePath.endsWith('/')
    ? basePath.slice(0, -1)
    : basePath;
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  const mergedPath = suffix ? `${normalizedBase}${normalizedSuffix}` : basePath;
  return query ? `${mergedPath}?${query}` : mergedPath;
}

function sendJson(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  const text = body.toString('utf-8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseControlGrant(req: IncomingMessage): {
  groupFolder: string;
  isMain: boolean;
} | null {
  const raw = req.headers['x-nanoclaw-control-grant'];
  const grant =
    typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  if (!grant) return null;
  return validateMcpControlGrant(grant);
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks);
          const rawUrl = req.url || '';
          const parsedUrl = new URL(rawUrl, 'http://nanoclaw-proxy.local');

          if (parsedUrl.pathname === '/_nanoclaw/oauth/callback') {
            const callbackError = parsedUrl.searchParams.get('error') || '';
            const callbackErrorDescription =
              parsedUrl.searchParams.get('error_description') || '';
            const statePresent = Boolean(parsedUrl.searchParams.get('state'));
            const codePresent = Boolean(parsedUrl.searchParams.get('code'));
            logger.info(
              {
                statePresent,
                codePresent,
                error: callbackError || undefined,
                errorDescription: callbackErrorDescription || undefined,
              },
              'Received MCP OAuth callback',
            );
            const result = await completeMcpOAuthCallback(
              parsedUrl.searchParams,
            );
            if (result.ok) {
              logger.info(
                { message: result.message },
                'MCP OAuth callback completed',
              );
            } else {
              logger.warn(
                {
                  message: result.message,
                  statePresent,
                  codePresent,
                  error: callbackError || undefined,
                  errorDescription: callbackErrorDescription || undefined,
                },
                'MCP OAuth callback failed',
              );
            }
            const html = result.html;
            res.writeHead(result.ok ? 200 : 400, {
              'content-type': 'text/html; charset=utf-8',
              'content-length': Buffer.byteLength(html),
            });
            res.end(html);
            return;
          }

          if (parsedUrl.pathname.startsWith(MCP_OAUTH_PREFIX)) {
            const grant = parseControlGrant(req);
            if (!grant) {
              sendJson(res, 403, { ok: false, error: 'Invalid control grant' });
              return;
            }

            if (
              parsedUrl.pathname === '/_nanoclaw/oauth/start' &&
              req.method === 'POST'
            ) {
              let serverName = '';
              try {
                const payload = parseJsonBody(body);
                serverName =
                  typeof payload.serverName === 'string'
                    ? payload.serverName
                    : '';
              } catch (err) {
                sendJson(res, 400, {
                  ok: false,
                  error: err instanceof Error ? err.message : 'Invalid request',
                });
                return;
              }
              if (!serverName) {
                sendJson(res, 400, {
                  ok: false,
                  error: 'serverName is required',
                });
                return;
              }
              try {
                const started = await startMcpOAuthFlow(
                  serverName,
                  grant.groupFolder,
                  grant.isMain,
                );
                sendJson(res, 200, { ok: true, ...started });
              } catch (err) {
                sendJson(res, 400, {
                  ok: false,
                  error:
                    err instanceof Error
                      ? err.message
                      : 'Failed to start OAuth',
                });
              }
              return;
            }

            if (
              parsedUrl.pathname === '/_nanoclaw/oauth/status' &&
              req.method === 'GET'
            ) {
              const serverName = parsedUrl.searchParams.get('server') || '';
              if (!serverName) {
                sendJson(res, 400, {
                  ok: false,
                  error: 'server query parameter is required',
                });
                return;
              }
              const status = await getMcpOAuthStatus(
                serverName,
                grant.groupFolder,
                grant.isMain,
              );
              sendJson(res, status.ok ? 200 : 400, status);
              return;
            }

            if (
              parsedUrl.pathname === '/_nanoclaw/oauth/disconnect' &&
              req.method === 'POST'
            ) {
              let serverName = '';
              try {
                const payload = parseJsonBody(body);
                serverName =
                  typeof payload.serverName === 'string'
                    ? payload.serverName
                    : '';
              } catch (err) {
                sendJson(res, 400, {
                  ok: false,
                  error: err instanceof Error ? err.message : 'Invalid request',
                });
                return;
              }
              const result = disconnectMcpOAuth(
                serverName,
                grant.groupFolder,
                grant.isMain,
              );
              sendJson(res, result.ok ? 200 : 400, result);
              return;
            }

            if (
              parsedUrl.pathname === '/_nanoclaw/oauth/complete' &&
              req.method === 'POST'
            ) {
              let serverName = '';
              let code = '';
              let state: string | undefined;
              try {
                const payload = parseJsonBody(body);
                serverName =
                  typeof payload.serverName === 'string'
                    ? payload.serverName
                    : '';
                code = typeof payload.code === 'string' ? payload.code : '';
                state =
                  typeof payload.state === 'string' ? payload.state : undefined;
              } catch (err) {
                sendJson(res, 400, {
                  ok: false,
                  error: err instanceof Error ? err.message : 'Invalid request',
                });
                return;
              }
              const result = await completeMcpOAuthManual(
                serverName,
                code,
                state,
                grant.groupFolder,
                grant.isMain,
              );
              sendJson(res, result.ok ? 200 : 400, result);
              return;
            }

            sendJson(res, 404, { ok: false, error: 'Unknown OAuth endpoint' });
            return;
          }

          const isMcpProxyRoute = rawUrl.startsWith(MCP_PROXY_PREFIX);
          const mcpRequest = rawUrl ? parseMcpProxyRequest(rawUrl) : null;
          if (isMcpProxyRoute && !mcpRequest) {
            res.writeHead(400);
            res.end('Invalid MCP proxy request');
            return;
          }
          if (mcpRequest) {
            const targets = resolveExternalMcpProxyTargets();
            const target = targets.get(mcpRequest.serverName);
            if (!target) {
              res.writeHead(404);
              res.end('Unknown MCP server');
              return;
            }
            if (
              !validateMcpProxyGrant(mcpRequest.grant, mcpRequest.serverName)
            ) {
              res.writeHead(403);
              res.end('Invalid MCP grant');
              return;
            }

            const targetUrl = new URL(target.url);
            const isTargetHttps = targetUrl.protocol === 'https:';
            const makeTargetRequest = isTargetHttps
              ? httpsRequest
              : httpRequest;
            const path = buildUpstreamPath(
              targetUrl.pathname,
              mcpRequest.pathSuffix,
              mcpRequest.query,
            );

            const headers: Record<
              string,
              string | number | string[] | undefined
            > = {
              ...(req.headers as Record<string, string>),
              host: targetUrl.host,
              'content-length': body.length,
              ...target.headers,
            };
            stripHopByHopHeaders(headers);
            delete headers['x-nanoclaw-control-grant'];

            if (target.auth.type === 'api_key') {
              if (!target.auth.envKey) {
                res.writeHead(502);
                res.end('MCP server auth is misconfigured');
                return;
              }
              const keySource = readEnvFile([target.auth.envKey]);
              const apiKey =
                process.env[target.auth.envKey] ||
                keySource[target.auth.envKey];
              if (!apiKey) {
                res.writeHead(401);
                res.end('MCP server credential is not configured');
                return;
              }
              Object.assign(
                headers,
                applyAuthTokenToHeaders({}, target.auth, apiKey),
              );
            } else if (target.auth.type === 'oauth2_pkce') {
              const accessToken = await getValidOAuthAccessToken(target.name);
              if (!accessToken) {
                res.writeHead(401);
                res.end('MCP OAuth authorization required');
                return;
              }
              Object.assign(
                headers,
                applyAuthTokenToHeaders({}, target.auth, accessToken),
              );
            }

            const upstream = makeTargetRequest(
              {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isTargetHttps ? 443 : 80),
                path,
                method: req.method,
                headers,
              } as RequestOptions,
              (upRes) => {
                res.writeHead(upRes.statusCode || 502, upRes.headers);
                upRes.pipe(res);
              },
            );
            upstream.on('error', (err) => {
              logger.error(
                { err, server: mcpRequest.serverName, path },
                'MCP proxy upstream error',
              );
              if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
              }
            });
            upstream.write(body);
            upstream.end();
            return;
          }

          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };
          stripHopByHopHeaders(headers);
          delete headers['x-nanoclaw-control-grant'];

          if (authMode === 'api-key') {
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }

          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode || 502, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        } catch (err) {
          logger.error({ err }, 'Credential proxy internal error');
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
          }
        }
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

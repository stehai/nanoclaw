import { randomBytes } from 'crypto';

interface McpProxyGrant {
  serverName: string;
  expiresAt: number;
}

interface McpControlGrant {
  groupFolder: string;
  isMain: boolean;
  expiresAt: number;
}

const grants = new Map<string, McpProxyGrant>();
const controlGrants = new Map<string, McpControlGrant>();
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function pruneExpired(now = Date.now()): void {
  for (const [token, grant] of grants.entries()) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
  for (const [token, grant] of controlGrants.entries()) {
    if (grant.expiresAt <= now) controlGrants.delete(token);
  }
}

export function issueMcpProxyGrant(
  serverName: string,
  ttlMs = DEFAULT_TTL_MS,
): string {
  pruneExpired();
  const token = randomBytes(24).toString('base64url');
  grants.set(token, {
    serverName,
    expiresAt: Date.now() + Math.max(1, ttlMs),
  });
  return token;
}

export function validateMcpProxyGrant(
  token: string,
  serverName: string,
): boolean {
  pruneExpired();
  const grant = grants.get(token);
  if (!grant) return false;
  if (grant.serverName !== serverName) return false;
  return grant.expiresAt > Date.now();
}

export function issueMcpControlGrant(
  groupFolder: string,
  isMain: boolean,
  ttlMs = DEFAULT_TTL_MS,
): string {
  pruneExpired();
  const token = randomBytes(24).toString('base64url');
  controlGrants.set(token, {
    groupFolder,
    isMain,
    expiresAt: Date.now() + Math.max(1, ttlMs),
  });
  return token;
}

export function validateMcpControlGrant(token: string): {
  groupFolder: string;
  isMain: boolean;
} | null {
  pruneExpired();
  const grant = controlGrants.get(token);
  if (!grant) return null;
  if (grant.expiresAt <= Date.now()) return null;
  return {
    groupFolder: grant.groupFolder,
    isMain: grant.isMain,
  };
}

/** @internal */
export function _resetMcpProxyGrantsForTests(): void {
  grants.clear();
  controlGrants.clear();
}

import { describe, expect, it } from 'vitest';

import {
  _resetMcpProxyGrantsForTests,
  issueMcpControlGrant,
  issueMcpProxyGrant,
  validateMcpControlGrant,
  validateMcpProxyGrant,
} from './mcp-proxy-grants.js';

describe('mcp-proxy-grants', () => {
  it('issues and validates a server-bound grant', () => {
    _resetMcpProxyGrantsForTests();
    const grant = issueMcpProxyGrant('parqet', 10_000);
    expect(validateMcpProxyGrant(grant, 'parqet')).toBe(true);
    expect(validateMcpProxyGrant(grant, 'other')).toBe(false);
  });

  it('expires grants after ttl', async () => {
    _resetMcpProxyGrantsForTests();
    const grant = issueMcpProxyGrant('parqet', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(validateMcpProxyGrant(grant, 'parqet')).toBe(false);
  });

  it('issues and validates control grants with group context', () => {
    _resetMcpProxyGrantsForTests();
    const grant = issueMcpControlGrant('whatsapp_main', true, 10_000);
    expect(validateMcpControlGrant(grant)).toEqual({
      groupFolder: 'whatsapp_main',
      isMain: true,
    });
  });
});

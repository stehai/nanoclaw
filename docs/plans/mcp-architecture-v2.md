# NanoClaw MCP Architecture v2 (Generic, HTTP/OAuth-First)

## Summary
Replace ad-hoc MCP wiring with a generic MCP platform:
- Primary path: remote MCP via `http`/`sse` with host-side auth handling.
- Secondary path: local `stdio` MCP for local tools.
- Secrets remain on host for remote MCP integrations.

## Key Design
1. Unified registry at `~/.config/nanoclaw/mcp-servers.json`.
2. Host-side proxying for remote MCP (`/_nanoclaw/mcp/<server>?grant=...`) with per-server ephemeral grants.
3. Dynamic MCP descriptor pass-through from host to container via `NANOCLAW_EXTERNAL_MCP_SERVERS_JSON`.
4. Dynamic tool namespace exposure (`mcp__<server>__*`) with policy-aware filtering.
5. OAuth credential source at `~/.config/nanoclaw/mcp-credentials.json` (host-only, strict file mode).
6. OAuth lifecycle automation:
   - start flow: `POST /_nanoclaw/oauth/start`
   - callback: `GET /_nanoclaw/oauth/callback`
   - status: `GET /_nanoclaw/oauth/status`
   - disconnect: `POST /_nanoclaw/oauth/disconnect`
   - manual completion fallback: `POST /_nanoclaw/oauth/complete`
7. Token refresh on demand for remote MCP proxy requests (uses refresh token when access token is expired).
8. Control-grant enforcement (`NANOCLAW_MCP_CONTROL_GRANT`) for OAuth management endpoints, so group identity is trusted by host proxy.

## Config Contract
`~/.config/nanoclaw/mcp-servers.json`:

```json
{
  "servers": [
    {
      "name": "parqet",
      "enabled": true,
      "transport": "http",
      "url": "https://mcp.parqet.com/mcp",
      "auth": {
        "type": "oauth2_pkce",
        "credentialKey": "parqet",
        "clientId": "your-parqet-client-id",
        "scopes": ["portfolio:read"],
        "issuer": "https://connect.parqet.com",
        "callbackMode": "hosted"
      },
      "policy": {
        "mainOnly": true,
        "allowedTools": ["portfolio_list", "account_get"]
      }
    }
  ]
}
```

Credential file (`~/.config/nanoclaw/mcp-credentials.json`):

```json
{
  "oauth2": {
    "parqet": {
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": "2026-04-12T15:00:00.000Z",
      "updatedAt": "2026-04-12T13:00:00.000Z"
    }
  }
}
```

## Notes
- `nanoclaw` and `open_brain` are reserved MCP server names.
- If `deniedTools` is configured without `allowedTools`, external MCP tools are not exposed.
- Hosted OAuth callback requires `MCP_OAUTH_CALLBACK_BASE_URL` (for example `https://assistant.example.com`).
- OAuth `state` entries are in-memory and expire after 10 minutes; stale links fail with "OAuth state is invalid or expired."
- Some providers validate `redirect_uri` before callback. If they reject it, NanoClaw receives no callback request.
- For hosted callback debugging, inspect reverse-proxy access logs (for example Caddy: `/var/log/caddy/krabbe.access.log`) and NanoClaw callback logs (`Received MCP OAuth callback`, `MCP OAuth callback failed`).
- If hosted callback is unavailable, use manual code completion via `mcp_complete_server_auth`.

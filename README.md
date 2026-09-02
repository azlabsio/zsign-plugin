# zSign Agent Plugin

The e-signature API built for agents. One curl to send, one call to pay. ESIGN/UETA. Prepaid credits, no seats. MCP at zsign.io/mcp.

Homepage: https://zsign.io

## Connect

This pack points Cursor at the remote Streamable HTTP MCP server:

`https://zsign.io/mcp`

Auth is OAuth 2.1 with Dynamic Client Registration. Clients discover it from:

- `https://zsign.io/.well-known/oauth-protected-resource/mcp`
- `https://zsign.io/.well-known/oauth-authorization-server`

No API key header is required when OAuth completes. No secret is stored in this pack.

## Packs

Prepaid credits, no seats:

- Starter $27/50
- Growth $87/250
- Scale $297/1000
- White-label $49/mo

## Files

- `plugin.json` — Agent Plugins 1.0.0 manifest
- `mcp.json` — remote MCP server
- `.cursor-plugin/plugin.json` — Cursor logo and homepage (Agent Plugins `plugin.json` has no logo field)
- `assets/logo.svg` — copied from `frontend/public/favicon.svg`

# @zsign/convex

zSign e-signature component for Convex. An app installs this component to send a
document for signature, observe envelope progress reactively, run completion
callbacks, and retrieve the signed PDF + completion certificate when done.

Published on npm as [`@zsign/convex`](https://www.npmjs.com/package/@zsign/convex).
`example/` is the minimal authenticated demo app it was proven with.
Agent-facing install/use guide: [SKILL.md](SKILL.md).

## Install

```bash
npm install @zsign/convex
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import zsign from "@zsign/convex/convex.config.js";

const app = defineApp();
app.use(zsign, {
  env: {
    ZSIGN_API_KEY: process.env.ZSIGN_API_KEY,
    ZSIGN_API_BASE_URL: process.env.ZSIGN_API_BASE_URL,
    ZSIGN_WEBHOOK_SECRET: process.env.ZSIGN_WEBHOOK_SECRET,
    ZSIGN_WEBHOOK_SECRET_PREVIOUS: process.env.ZSIGN_WEBHOOK_SECRET_PREVIOUS,
  },
});
export default app;
```

## Env (component, declared in convex.config.ts)

- `ZSIGN_API_KEY` (required) — `zs_live_…`/`zs_test_…` org key.
- `ZSIGN_API_BASE_URL` (optional) — defaults to `https://api.zsign.io`.
- `ZSIGN_WEBHOOK_SECRET` (optional) — `whsec_…`; required to verify webhook
  signatures.
- `ZSIGN_WEBHOOK_SECRET_PREVIOUS` (optional) — previous `whsec_…`, accepted in
  parallel during secret rotation.

## App usage

```ts
import { Zsign } from "@zsign/convex";
import { components } from "./_generated/api";

const zsign = new Zsign(components.zsign);

// Action: send. operationId is your idempotency/correlation key — replays
// return the stored result instead of creating a second envelope.
await zsign.send(ctx, {
  file, filename: "proposal.pdf",
  recipients: [{ name, email, role: "client", signingOrder: 1 }],
  operationId, // required; also sent as the HTTP Idempotency-Key
  metadata: { dealId: "..." }, // strings only; zsign.* keys are reserved
});
// -> { documentId, sessionId, signingUrls, replayed? }

// Queries: reactive reads (subscribe from UI or use in other functions)
await zsign.status(ctx, operationId); // envelope + recipients + completion ids
await zsign.list(ctx, { activeOnly: true }); // non-terminal envelopes

// Actions: canonical sync + artifacts
await zsign.refresh(ctx, operationId); // force a GET against the zSign API
await zsign.getSignedPdf(ctx, completedDocumentId); // -> ArrayBuffer
await zsign.getCertificate(ctx, documentId);        // -> ArrayBuffer
```

## Webhooks

Component http routes did not mount on the self-hosted backend this was built
against, so the app wires one route itself using the shipped verifier:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { verifyWebhookRequest } from "@zsign/convex";
import { internal } from "./_generated/api";

const http = httpRouter();
http.route({
  path: "/zsign/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const res = await verifyWebhookRequest(request, [
      process.env.ZSIGN_WEBHOOK_SECRET,
      process.env.ZSIGN_WEBHOOK_SECRET_PREVIOUS,
    ]);
    if (!res.ok) return new Response(res.error, { status: res.status });
    try {
      await ctx.runMutation(components.zsign.lib.applyWebhookEvent, res.event);
    } catch {
      return new Response("webhook receipt unavailable", { status: 503 });
    }
    return new Response("ok", { status: 200 });
  }),
});
export default http;
```

Verified signature (`X-Webhook-Signature: t=…,v1=…`, HMAC-SHA256 over
`t.{raw_body}`, 300s tolerance, either current or previous secret) happens
before any mutation; unknown `X-Webhook-Id`s are deduped; unknown sessions are
persisted as orphaned events and replayed onto the envelope if it appears
later. A receipt failure returns 503 so zSign retries delivery.

## Completion callbacks

```ts
// internal mutation the app owns
export const onEnvelopeCompleted = internalMutation({
  args: {
    callbackId: v.string(), operationId: v.string(), sessionId: v.string(),
    documentId: v.string(), completedDocumentId: v.string(),
    metadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => { /* advance your workflow */ },
});

// drain (e.g. from a cron action)
await zsign.onCompleted(ctx, internal.myFunctions.onEnvelopeCompleted);
```

Handlers are mutations. Each `(envelope, kind)` callback is deduped and
persisted; a handler that throws stays `failed` with `lastError` and is retried
by the next drain — at-least-once, not exactly-once.

## Reconciliation

Webhook-driven state is guarded by `generation` + status rank; on a conflict
(out-of-order or inconsistent event) the component schedules
`reconcile.refreshEnvelope`, which fetches `GET /api/v1/documents/{id}` and
applies canonical state only if the generation still matches, with bounded
backoff. `terminal` envelopes are never refreshed. `lastSyncedAt` / `syncError`
surface per-envelope health; `zsign.refresh(ctx, operationId)` forces a manual
sync.

## Verified end-to-end (2026-09-14)

Stack: self-hosted `ghcr.io/get-convex/convex-backend` (docker, :3210/:3211),
local zSign backend (:7101, local Postgres + `local_gcs_uvicorn.py`), webhook
`http://127.0.0.1:3211/zsign/webhook`.

1. **Send** — component action builds multipart manually (Convex runtime's
   FormData drops Blob MIME; zSign 422s without `application/pdf`), POSTs with
   `Idempotency-Key` = operationId. Tags `{signature*:client}` auto-assign to
   `role: "client"`.
2. **Webhooks → reactive status** — all lifecycle events delivered, 200 each;
   status `completed` with `completedDocumentId` (the completed doc's id —
   `document.completed`'s `data.document_id` is NOT the original).
3. **Callbacks** — `document.completed` persisted an `onCompleted` callback; a
   failing drain recorded `lastError`, and the next drain retried it to
   `succeeded`. The example app's `completions` row was written by its own
   `internalMutation` handler.
4. **Artifacts** — signed PDF (tags redacted, signature stamped) and
   certificate both return bytes through component actions.
5. **Signature verification** — good sig → applied; replayed `X-Webhook-Id` →
   `"duplicate"`; bad sig / stale `t` → 401; `ZSIGN_WEBHOOK_SECRET_PREVIOUS`
   accepted.
6. **Replay** — `send` twice with the same `operationId` → `{replayed: true,
   same documentId}`; with PR #393's `Idempotency-Key` the upstream call also
   collapses to one envelope + one debit.
7. **Auth wrappers (example)** — token-authenticated `sendEnvelope` /
   `envelopeStatus` / `listEnvelopes` / `refreshEnvelope` / artifact fetches;
   bad token → `unauthenticated`, wrong tenant → `not found`.
8. **Packed artifact** — `npm pack` → installed into a clean app dir →
   `convex codegen` + `tsc` clean, `Zsign` client types resolve.

## Failure semantics

- Webhook receipt: verify → dedupe → persist. Unknown envelope → `orphaned`
  row, re-attached on `insertEnvelope` by `sessionId`.
- Send: operation allocated before the HTTP call; a network/5xx failure marks
  it `failed` and a retry re-sends; a `sent` op short-circuits to the stored
  result.
- Reconcile: generation guard drops stale applies; bounded backoff then stops.
- Callbacks: deduped, persisted, failure-visible, retryable — at-least-once.

zSign has no staging environment, so external-email checks used a dedicated,
clearly labeled live account (signup → 0 credits, email verify grants 3, one
send debits exactly 1, invitation delivered).

## Agent plugin pack

This repo also ships the zSign agent plugin pack at the root — the same files
Cursor uses to connect to the remote MCP server. They are not part of the npm
package (`files` limits the tarball to `src/`, `docs/`, `SKILL.md`,
`CHANGELOG.md`).

- `plugin.json` — Agent Plugins 1.0.0 manifest
- `mcp.json` — remote Streamable HTTP MCP server at `https://zsign.io/mcp`
  (OAuth 2.1 with Dynamic Client Registration; no API key header once OAuth
  completes, no secret stored in the pack)
- `.cursor-plugin/plugin.json` — Cursor logo and homepage (Agent Plugins
  `plugin.json` has no logo field)
- `assets/logo.svg` — copied from `frontend/public/favicon.svg`

Prepaid credits, no seats: Starter $27/50 · Growth $87/250 · Scale $297/1000 ·
White-label $49/mo.

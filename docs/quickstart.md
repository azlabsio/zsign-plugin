# Quickstart — @zsign/convex

Send a document for signature from a Convex app and get a live-updating status,
a completion callback, and the signed PDF. Target: working integration in
~10 minutes.

Prerequisites: a Convex project (`npx convex dev` works), a zSign API key
(`zs_live_…`), and a webhook secret (`whsec_…`, from
`POST /api/webhooks` on your zSign deployment).

## 1. Install

```bash
npm install @zsign/convex
```

## 2. Mount the component

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
  },
});
export default app;
```

```bash
npx convex env set ZSIGN_API_KEY zs_live_...
npx convex env set ZSIGN_WEBHOOK_SECRET whsec_...
# ZSIGN_API_BASE_URL is optional; defaults to https://zsign.io
npx convex dev   # once, to generate bindings
```

## 3. Wire the webhook route

Component http routes don't mount on self-hosted backends, so the app owns the
route; the component ships the verifier.

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { verifyWebhookRequest } from "@zsign/convex";

const http = httpRouter();
http.route({
  path: "/zsign/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const res = await verifyWebhookRequest(request, [
      process.env.ZSIGN_WEBHOOK_SECRET,
      process.env.ZSIGN_WEBHOOK_SECRET_PREVIOUS, // set during rotation only
    ]);
    if (!res.ok) return new Response(res.error, { status: res.status });
    try {
      await ctx.runMutation(internal.zsign.applyWebhook, res.event);
    } catch {
      // 5xx → zSign retries the delivery
      return new Response("webhook receipt unavailable", { status: 503 });
    }
    return new Response("ok", { status: 200 });
  }),
});
export default http;
```

`applyWebhook` is a one-line app mutation that forwards into the component
(component mutations can't be called from an httpAction directly):

```ts
// convex/zsign.ts
export const applyWebhook = internalMutation({
  args: {
    eventId: v.string(), type: v.string(),
    sessionId: v.optional(v.string()), documentId: v.optional(v.string()),
    signerEmail: v.optional(v.string()), completedAt: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: (ctx, args) =>
    ctx.runMutation(components.zsign.lib.applyWebhookEvent, args),
});
```

Then point your zSign webhook at `https://<your-app>.convex.site/zsign/webhook`.

## 4. Send a document

```ts
const zsign = new Zsign(components.zsign);

export const sendProposal = action({
  args: { dealId: v.string(), signerName: v.string(), signerEmail: v.string() },
  handler: async (ctx, args) => {
    const file = await (await fetch("https://…/proposal.pdf")).arrayBuffer();
    return zsign.send(ctx, {
      file,
      filename: "proposal.pdf",           // must end in .pdf
      recipients: [
        { name: args.signerName, email: args.signerEmail, role: "client" },
      ],
      operationId: `deal-${args.dealId}`, // your idempotency key — reuse to retry
      sendInvite: true,
    });
  },
});
```

`send` returns `{ envelopeId, documentId, sessionId, signingUrls, replayed }`.
Store `operationId` on your own record — it's your handle for everything else.

**If your PDF uses `{type:party:name}` field tags, `role` must match the tag
party** (`{signature:client:…}` needs `role: "client"`).

## 5. Show live status

```ts
export const envelopeStatus = query({
  args: { operationId: v.string() },
  handler: (ctx, args) => zsign.status(ctx, args.operationId),
});
```

This is a reactive query — the UI updates as webhooks land. `status` moves
`created → sent → in_progress → completed` (or `declined`/`expired`/`voided`),
with per-recipient progress and `completedDocumentId` on completion.

## 6. Do work on completion

```ts
// convex/zsign.ts
export const onEnvelopeCompleted = internalMutation({
  args: {
    callbackId: v.string(), operationId: v.string(), sessionId: v.string(),
    documentId: v.string(), completedDocumentId: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => { /* mark your deal signed, kick off next step */ },
});

export const drainCompletions = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number; failed: number }> =>
    zsign.onCompleted(ctx, internal.zsign.onEnvelopeCompleted),
});
```

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
const crons = cronJobs();
crons.interval("zsign completions", { seconds: 60 }, internal.zsign.drainCompletions);
export default crons;
```

Delivery is **at-least-once**: a throwing handler is retried on the next drain.
Make yours idempotent (e.g. check for an existing row keyed by operationId).

## 7. Get the artifacts

```ts
export const downloadSigned = action({
  args: { operationId: v.string() },
  handler: async (ctx, args) => {
    const env = await zsign.status(ctx, args.operationId);
    if (!env?.completedDocumentId) throw new Error("not completed");
    const pdf = await zsign.getSignedPdf(ctx, env.completedDocumentId); // ArrayBuffer
    const cert = await zsign.getCertificate(ctx, env.documentId);       // ArrayBuffer
    return { pdf, cert };
  },
});
```

`documentId` is the original upload; `completedDocumentId` is the signed copy —
they are different IDs and not interchangeable.

## Done

If webhooks arrive, `status` flips to `completed` and `drainCompletions` runs
your handler. If webhooks can't reach you, call `zsign.refresh(ctx,
operationId)` to pull canonical state, or rely on the built-in reconcile loop —
it re-fetches on any conflict with bounded backoff.

Next: [API reference](./api.md) · [Troubleshooting](./troubleshooting.md)

---
name: zsign-convex
description: >-
  Add e-signature to a Convex app with the @zsign/convex component — send a PDF
  for signature, watch envelope status reactively, run a completion callback,
  and fetch the signed PDF and certificate. Use when a Convex app needs
  documents signed, when the user mentions zSign, "send for signature",
  e-signature envelopes, or signing links from Convex functions.
---

# @zsign/convex — zSign e-signature component

zSign is an e-signature API. This component gives a Convex app its own
envelope tables, webhook ingestion, reconciliation, and completion-callback
queue — the app talks to a typed `Zsign` client, not the REST API.

Choose it when the app needs a document signed by one or more recipients and
wants signing progress as a reactive Convex query. Not for in-app document
editing or PDF generation — zSign signs PDFs you already have.

## Install and configure

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
    ZSIGN_API_KEY: process.env.ZSIGN_API_KEY,           // required, zs_live_…
    ZSIGN_API_BASE_URL: process.env.ZSIGN_API_BASE_URL, // optional
    ZSIGN_WEBHOOK_SECRET: process.env.ZSIGN_WEBHOOK_SECRET, // whsec_…
  },
});
export default app;
```

Component env vars are isolated from the app's — declare them in `app.use` as
above, then `npx convex env set ZSIGN_API_KEY …` and `npx convex dev` once.

## Required authorization

- `ZSIGN_API_KEY` — org API key (`zs_live_…` / `zs_test_…`). Every send is a
  real operation that can consume a credit on the zSign account.
- `ZSIGN_WEBHOOK_SECRET` — `whsec_…` from `POST /api/webhooks` on the zSign
  deployment. Required to verify webhook signatures.

## PDF field syntax

A PDF can carry inline field tags of the form `{type:party:name}` — e.g.
`{signature:client:signature}`, `{date:signer:signed_on}`. **The tag party must
equal the recipient `role`** passed to `send`: `{signature:client:…}` requires
`role: "client"`. A tag whose party matches no recipient stays unassigned and
zSign rejects completion with `missing_required_fields`. PDFs without tags get
fields placed through zSign's editor instead — either way `send` is the same.

## Wire the webhook route

Component `http.ts` routes do not mount on every backend, so the app owns the
route; the package ships the verifier:

```ts
// convex/http.ts
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
      return new Response("webhook receipt unavailable", { status: 503 });
    }
    return new Response("ok", { status: 200 });
  }),
});
```

`applyWebhook` is a one-line `internalMutation` the app owns that forwards to
`components.zsign.lib.applyWebhookEvent` (component mutations can't be called
from an `httpAction`). Point the zSign webhook at
`https://<app>.convex.site/zsign/webhook`.

## Send and watch — working example

```ts
const zsign = new Zsign(components.zsign);

// action
await zsign.send(ctx, {
  file,                              // ArrayBuffer of the PDF
  filename: "proposal.pdf",          // must end in .pdf
  recipients: [{ name, email, role: "client" }],
  operationId: `deal-${dealId}`,     // REQUIRED idempotency + correlation key
});
// → { envelopeId, documentId, sessionId, signingUrls, replayed }

// query — reactive; UI updates as webhooks land
await zsign.status(ctx, operationId);
// status: created → sent → in_progress → completed | declined | expired | voided
```

`operationId` is the contract for everything: re-sending the same one returns
`{replayed: true}` instead of a second envelope. Namespace it per tenant
(`${tenantId}.${dealId}`) — the namespace is global per deployment.

## Completion callbacks

`zsign.onCompleted(ctx, yourMutation)` drains persisted callbacks; the handler
must be a mutation (components can't call app functions, so the drain runs
through your ctx). Wire it to a cron. Delivery is **at-least-once**: a throwing
handler stays `failed` with `lastError` and is retried next drain — make the
handler idempotent.

## Artifacts

```ts
const env = await zsign.status(ctx, operationId);
await zsign.getSignedPdf(ctx, env.completedDocumentId); // signed copy
await zsign.getCertificate(ctx, env.documentId);        // audit certificate
```

`documentId` (original upload) and `completedDocumentId` (signed copy) are
different IDs — `document.completed`'s `data.document_id` is the *completed*
one, not the original.

## Recovery from common errors

- **422 on send** — don't hand-build `FormData` (Convex's runtime drops Blob
  MIME); `zsign.send` already builds multipart. `filename` must end `.pdf`.
- **`missing_required_fields`** — a tag party doesn't match any recipient
  `role`; see PDF field syntax above.
- **Status never changes** — route must live in the app's `convex/http.ts`;
  bad signature → 401; envelope row arriving after its webhook self-heals via
  orphaned events. Force a canonical pull with `zsign.refresh(ctx,
  operationId)`.
- **Webhooks unreachable** — reconcile loop self-heals on conflicts with
  bounded backoff (~6 tries, then `syncError` + `lastSyncedAt` on the row);
  `refresh` is the manual recovery path.
- **Secret rotation** — set `ZSIGN_WEBHOOK_SECRET_PREVIOUS` to the old secret;
  both verify until cutover.
- **Nominally-incompatible ctx types** — two installed copies of `convex`;
  dedupe to one hoisted copy.

## Testing

```ts
import { registerZsign } from "@zsign/convex/test";
registerZsign(t); // mounts under name "zsign" in convex-test
```

Full reference: `docs/quickstart.md`, `docs/api.md`,
`docs/troubleshooting.md` in the package.

# API reference — @zsign/convex

## Client class

```ts
import { Zsign } from "@zsign/convex";
const zsign = new Zsign(components.zsign);
```

All methods take the caller's `ctx` first — pass whatever your function has
(query, mutation, or action ctx all work; the class types them structurally).

### `send(ctx, args)` — action

```ts
zsign.send(ctx, {
  file: ArrayBuffer,              // PDF bytes
  filename: string,               // must end in .pdf (checked before send)
  name?: string,                  // envelope display name; defaults to filename
  recipients: [{ name, email, role? }],  // role should match PDF tag party
  operationId: string,            // REQUIRED — idempotency + correlation key
  metadata?: Record<string, string>,
  sequential?: boolean,           // default true
  sendInvite?: boolean,           // default true
  sendCompletionEmail?: boolean,  // default true
}) → Promise<{
  envelopeId, documentId, sessionId, signingUrls, replayed
}>
```

- `operationId` is the contract's correlation key: the component allocates an
  operation record before the HTTP call, and sends it as the upstream
  `Idempotency-Key`. A repeat call with a completed operation returns
  `{replayed: true, …}` without touching zSign; a repeat whose first send died
  mid-flight collapses upstream (requires zSign idempotency support).
  `operationId` is a **global** namespace per deployment: if your app is
  multi-tenant and ids come from business keys (e.g. `deal-${dealId}`),
  namespace them yourself — e.g. `${tenantId}.${dealId}` — like
  `example/convex/zsign.ts` does, or two tenants' identical ids collide.
- `metadata` is string-only. Keys under `zsign.*` are reserved — the component
  writes `zsign.operation_id` / `zsign.component_version` and overrides any
  user-supplied `zsign.*` keys.
- Manual multipart: the component builds the `multipart/form-data` body itself
  because the Convex runtime drops `Blob`/`File` MIME types and zSign requires
  `application/pdf` (it 422s `application/octet-stream`).

### `status(ctx, operationId)` — query

Reactive read of the envelope row:

```ts
{
  _id, operationId, documentId, sessionId,
  status: "created"|"sent"|"in_progress"|"completed"|"declined"|"expired"|"voided",
  terminal: boolean,
  recipients: [{ email, name, status, signedAt? }],
  metadata?, completedDocumentId?, completedAt?,
  lastSyncedAt?, syncError?, generation, createdAt, updatedAt,
}
```

`documentId` = original upload. `completedDocumentId` = the signed document —
different ID, use it for `getSignedPdf`.

### `list(ctx, { activeOnly? })` — query

All envelopes, or non-terminal only when `activeOnly: true`.

### `refresh(ctx, operationId)` — action

Force a canonical pull (`GET /api/v1/documents/{id}`) and apply it under a
generation guard. Returns `{found, status, terminal, applied, …}`. Terminal
envelopes are never refreshed.

### `getSignedPdf(ctx, completedDocumentId)` / `getCertificate(ctx, documentId)` — actions

Return `ArrayBuffer`. 4xx/5xx throws with the status in the message.

### `verifyWebhook(request, secrets)` — helper (also `verifyWebhookRequest`)

```ts
const res = await verifyWebhookRequest(request, [currentSecret, previousSecret]);
// res.ok → res.event: { eventId, type, sessionId?, documentId?, signerEmail?,
//   completedAt?, metadata? }  — pass to lib.applyWebhookEvent
// !res.ok → res.status, res.error — return that status unchanged
```

HMAC-SHA256 over `t.{raw_body}` vs `v1` in `X-Webhook-Signature`, 300s
timestamp tolerance, timing-safe compare. Event id comes from `X-Webhook-Id`
header, falling back to the body.

### `onCompleted(ctx, handler, { limit? })` — action

Drains persisted callbacks. `handler` must be an app **mutation** (public or
internal) accepting `OnCompletedArgs`:

```ts
{ callbackId, operationId, sessionId, documentId,
  completedDocumentId?, metadata? }
```

A component cannot invoke app functions, so the drain runs through your ctx.
Each callback is deduped by `(envelopeId, kind)`; a throwing handler is marked
`failed` with `lastError` and retried by the next drain — **at-least-once, not
exactly-once**. Returns `{ processed, failed }`.

## Component functions (advanced)

`components.zsign.*` — call directly only if you're bypassing the client class.

| Function | Kind | Purpose |
|---|---|---|
| `lib.applyWebhookEvent` | mutation (public) | verify-then-persist receipt; returns `{outcome: "applied"|"duplicate"|"orphaned"|"conflict"}` |
| `lib.getByOperation` / `lib.getBySession` / `lib.list` | query | read surface used by the client |
| `lib.getOperation` | query | operation record (`allocated`/`sent`/`failed`, `error`) |
| `lib.pendingCallbacks` / `lib.callbackEnvelope` / `lib.finishCallback` | query/query/mutation | callback queue primitives used by `onCompleted` |
| `send.send` / `send.getSignedPdf` / `send.getCertificate` | action | upstream calls |
| `reconcile.refresh` | action (public) | manual canonical sync by operationId |

Internal (scheduler/self): `lib.allocateOperation`, `lib.markSendFailed`,
`lib.insertEnvelope`, `lib.applyCanonicalState`, `lib.markSyncError`,
`reconcile.refreshEnvelope`.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `ZSIGN_API_KEY` | yes | `zs_live_…`/`zs_test_…` org API key |
| `ZSIGN_API_BASE_URL` | no | defaults `https://zsign.io`; a trailing `/api` or `/api/v1` is stripped |
| `ZSIGN_WEBHOOK_SECRET` | for webhooks | `whsec_…`; without it signature verification can't run |
| `ZSIGN_WEBHOOK_SECRET_PREVIOUS` | no | rotation: both secrets accepted until cutover |

## Testing

```ts
import { registerZsign } from "@zsign/convex/test";
const t = convexTest(schema, modules);
registerZsign(t);  // mounts the component under name "zsign"
```

## Failure semantics

- **Webhook receipt** — verify → dedupe → persist → apply. Unknown eventIds
  dedupe by `X-Webhook-Id`. Unknown sessions persist as orphaned events and are
  re-applied (in arrival order) when the envelope row appears.
- **Send** — operation allocated before the POST; network/5xx marks it
  `failed` (retryable by re-sending the same operationId); `sent` ops replay.
- **Reconcile** — any event that would demote a terminal envelope, or a rank
  conflict, schedules a canonical refresh; writes are dropped if `generation`
  moved while fetching. Backoff 0s→5s→30s→2m→10m→30m, then `syncError` and stop.
- **Callbacks** — persisted, deduped, retryable, at-least-once.

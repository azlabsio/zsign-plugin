# Troubleshooting — @zsign/convex

## Send fails with `zSign send failed (422)` mentioning file content

The Convex runtime's `FormData`/`Blob`/`File` lose their MIME type, so a naive
`FormData` upload arrives as `application/octet-stream` and zSign 422s. The
component already builds the multipart body by hand — if you hit this, you're
bypassing `zsign.send`; don't. Also: `filename` must end in `.pdf` — the
component rejects anything else before calling zSign.

## Tags in my PDF don't bind to the signer (`missing_required_fields`)

Tag party must equal the recipient `role`. `{signature:client:signature}`
requires `recipients: [{ role: "client", … }]`. `{…:signer:…}` requires
`role: "signer"`. Fields with unassigned parties stay unassigned and zSign
rejects completion with `missing_required_fields`.

## Webhooks arrive but status never changes

1. Check the route actually runs — component-defined `http.ts` routes **did not
   mount** on self-hosted convex-backend 1.45; the route must live in your app's
   `convex/http.ts` (see quickstart §3).
2. A bad signature returns 401 and mutates nothing — check
   `ZSIGN_WEBHOOK_SECRET` matches the `whsec_…` from webhook registration.
3. A receipt failure returns 503 so zSign retries; check your Convex function
   logs for the error behind it.
4. The envelope row may not exist yet (the webhook beat the send response) —
   it's persisted as an orphaned event and applied automatically when the
   envelope inserts. If it never did, call `zsign.refresh(ctx, operationId)`.

## Webhooks can't reach my deployment at all

Run `zsign.refresh(ctx, operationId)` — it pulls `GET /api/v1/documents/{id}`
directly. Envelopes also self-heal: any conflicting/late event schedules a
canonical refresh. `syncError` + `lastSyncedAt` on the envelope row tell you
the reconcile loop's health; after ~6 bounded retries it stops and records the
error — a manual `refresh` is the recovery path.

## `document_id` from `document.completed` isn't my document

By design: that field is the **completed** document's id. The component stores
it separately as `completedDocumentId`. Use `documentId` (original) for
`getCertificate` and `completedDocumentId` for `getSignedPdf`.

## Rotating the webhook secret

Set `ZSIGN_WEBHOOK_SECRET_PREVIOUS` to the old `whsec_…`, update
`ZSIGN_WEBHOOK_SECRET` to the new one, redeploy, then re-register the webhook
at zSign. Both secrets verify during the overlap; remove `…_PREVIOUS` after
cutover.

## `onCompleted` handler never runs

Drains are pull-based: nothing runs until your app calls
`zsign.onCompleted(ctx, yourMutation)` — wire a cron (quickstart §6) or an
http-triggered action. If the handler throws, the callback row stays `failed`
with `lastError`; fix and the next drain retries. Deliveries are at-least-once —
make the handler idempotent (e.g. insert-if-absent on operationId).

## `Type 'X' is not assignable` when passing ctx to `Zsign` methods

Client ctx types are structural (`runQuery`/`runMutation`/`runAction`) on
purpose — `QueryCtx`/`ActionCtx` from different `convex` package copies are
nominally incompatible. If you see this, you probably have two `convex`
versions installed; dedupe (npm workspaces / single hoisted copy) fixes it.

## Self-hosted backend: `npx convex dev` demands login

Self-hosted `convex-backend` docker needs `CONVEX_SELF_HOSTED_URL` +
`CONVEX_SELF_HOSTED_ADMIN_KEY` in `.env.local` (see `example/.env.local`) —
no Convex account. HTTP actions live on the site URL port (:3211 in the
docker default), not the API port.

## `npm test` can't find `src/component/_generated`

The component's `_generated/` bindings are committed to the repo (CI can't run
`convex codegen` — it needs a deployment token). If they're missing locally,
run `npx convex dev --once` in `example/` and they'll be
regenerated; then leave them checked in.

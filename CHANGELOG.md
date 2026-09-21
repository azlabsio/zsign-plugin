# Changelog

## Unreleased

- Every component function now declares a `returns` validator (Convex
  Components Directory advisory). Table field validators moved to
  `src/component/validators.ts` so `schema.ts` and the `returns` shapes share
  one definition. `send` now returns `envelopeId` typed as `Id<"envelopes">`
  (still assignable to `string`); `applyWebhookEvent.outcome` is the literal
  union `"applied" | "conflict" | "duplicate" | "orphaned"`. No runtime
  behaviour change.

## 0.1.1 — 2026-09-14

- Export `./_generated/component.js` so consumers can import `ComponentApi`
  from `@zsign/convex/_generated/component.js`, as required by the Convex
  component authoring guide. 0.1.0 shipped the file but not the export, so the
  subpath failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## 0.1.0 — 2026-09-14

Initial public release.

- `Zsign` client: `send` (idempotent via `operationId`), reactive `status` and
  `list`, canonical `refresh`, `getSignedPdf`, `getCertificate`, and an
  at-least-once `onCompleted` callback drain.
- Component: envelope/operation/callback tables, HMAC-SHA256 webhook
  verification with dedupe and orphaned-event replay, generation-guarded
  reconciliation with bounded backoff, webhook-secret rotation support.
- `verifyWebhookRequest` helper for the app-owned `convex/http.ts` route.
- `@zsign/convex/test` export: `registerZsign(t)` for `convex-test`.
- Verified end-to-end against self-hosted `convex-backend` and a local zSign
  backend — see README "Verified end-to-end".

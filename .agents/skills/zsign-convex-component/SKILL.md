---
name: zsign-convex-component
description: Work on the @zsign/convex package (this repo) — tests, codegen, the example app, and live verification against the local zSign stack. Use when touching src/, tests/, example/, or debugging the Convex component.
---

# @zsign/convex component

This repo is the installable Convex component (`defineComponent("zsign")`),
published as `@zsign/convex`; the package lives at the repo root alongside the
zSign agent plugin pack (`plugin.json`, `mcp.json`, `.cursor-plugin/`).
App-facing client: `src/client/index.ts` (`Zsign` class). Component internals:
`src/component/{schema,lib,send,reconcile,webhook,http,convex.config}.ts`.
Docs live in `docs/`.

## Tests

- `npm test` — vitest + `convex-test` (needs ^0.0.58; earlier
  versions throw "Write outside of transaction" on scheduled functions).
- `registerZsign(t)` from `@zsign/convex/test` mounts the component in
  `convexTest` via `t.registerComponent("zsign", schema, modules)`.
- `src/component/_generated/` **is committed on purpose** — CI can't run
  `convex codegen` (needs a deployment token). If the component's functions or
  schema change, regenerate via `npx convex dev --once` in `example/` and
  re-commit. `example/convex/_generated/` stays gitignored.
- `npm run typecheck` — strict tsc over src+tests.
- Retry-scheduling inside `reconcile.refreshEnvelope` can't run under
  convex-test (action ctx has no tx for `_scheduled_functions`); tests exercise
  the final retry slot instead, and the live chain is verified against the
  real backend.

## Example app bring-up (live e2e)

Self-hosted Convex, no cloud account:
`docker run ghcr.io/get-convex/convex-backend` (API :3210, http actions :3211).

`example/.env.local` needs `CONVEX_SELF_HOSTED_URL`,
`CONVEX_SELF_HOSTED_ADMIN_KEY`, `CONVEX_URL`. Deploy:
`cd example && set -a && . ./.env.local && set +a && npx convex dev --once`.

Component env on the deployment: `ZSIGN_API_BASE_URL=http://172.17.0.1:7101`
(docker bridge → local zSign), `ZSIGN_API_KEY=zs_live_…` (repo-scoped secret
`ZSIGN_CONVEX_TEST_API_KEY`), `ZSIGN_WEBHOOK_SECRET=whsec_…`.

zSign's singleton webhook must point at
`http://127.0.0.1:3211/zsign/webhook` — component http.ts routes do NOT mount
on backend 1.45; the app route (`example/convex/http.ts`) is the proven path.

## Known traps (all proven live)

- Convex runtime `FormData`/`Blob` drop MIME → zSign 422s; `send` builds
  multipart manually. Don't "fix" it back.
- Tag party == recipient `role` (`{signature:client:…}` needs `role:"client"`).
- `document.completed`'s `data.document_id` is the COMPLETED doc id, not the
  original — `getSignedPdf` takes `completedDocumentId`, `getCertificate`
  takes `documentId`.
- `FunctionReference` has no runtime `_type`; `onCompleted` handlers must be
  mutations.
- Action ctx has no `ctx.db` — auth lookups go through `ctx.runQuery` on
  internal queries (`example/convex/zsign.ts` shows the pattern).
- Two `convex` package copies produce incompatible nominal ctx types — keep a
  single hoisted copy (npm workspaces — `example/` is a workspace member).

## Live verification recipe

Requires the local zSign backend from the `zsign` repo (see its `verify-zsign`
skill: `source .cursor/dev-env.sh`, `PYTHONPATH=backend python
.claude/skills/verify-zsign/helpers/local_gcs_uvicorn.py` on :7101).

1. `npx convex dev --once` in `example/` (deploys app + component).
2. `npx convex run auth:signUp '{...}'` → token; `zsign:sendEnvelope` with a
   tagged PDF → `{documentId, sessionId, signingUrls}`.
3. Sign headless: `npx zsign-control sign api <jwt> --typed "Name"`
   (token is positional; signature fields need `--typed`/`--drawn`).
4. `zsign:envelopeStatus` → `completed` + `completedDocumentId`;
   `zsign:processCompletions` drains the persisted onCompleted callback;
   `fetchSignedPdf`/`fetchCertificate` return bytes.
5. Replay: `sendEnvelope` again with same operationId → `replayed: true`.

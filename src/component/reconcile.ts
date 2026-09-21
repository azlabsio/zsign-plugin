import { v } from "convex/values";
import { internalAction, action, env } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import { resolveBaseUrl } from "./baseUrl.js";
import type { Id } from "./_generated/dataModel.js";

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000, 1_800_000];

// zSign GET /api/v1/documents/{id} shape (frozen contract).
type CanonicalStatus = {
  status: string;
  session?: {
    status: string;
    completed_at?: string | null;
    recipients?: {
      name: string;
      email: string;
      status: string;
      signed_at?: string | null;
    }[];
  } | null;
  completed_document_id?: string | null;
};

function canonicalEnvelopeStatus(body: CanonicalStatus): string {
  return body.session?.status ?? body.status;
}

// Outcome of one canonical fetch: `applied` mirrors applyCanonicalState,
// `retry` means another attempt was scheduled, `done` means nothing further
// will run for this envelope.
const refreshResult = v.object({
  applied: v.optional(v.boolean()),
  retry: v.optional(v.boolean()),
  done: v.optional(v.boolean()),
});

export const refreshEnvelope = internalAction({
  args: {
    envelopeId: v.id("envelopes"),
    attempt: v.optional(v.number()),
    // Conflict-triggered reconciles (post-terminal event) pass this to bypass
    // the routine terminal short-circuit.
    allowTerminal: v.optional(v.boolean()),
  },
  returns: refreshResult,
  handler: async (ctx, args): Promise<{ applied?: boolean; retry?: boolean; done?: boolean }> => {
    const attempt = args.attempt ?? 0;
    const envelope = await ctx.runQuery(internal.lib.getEnvelopeInternal, {
      envelopeId: args.envelopeId,
    });
    if (!envelope) return { done: true };
    if (envelope.terminal && !args.allowTerminal) {
      return { done: true }; // terminal envelopes stop routine refresh
    }

    const generation = envelope.generation;
    const baseUrl = resolveBaseUrl(env.ZSIGN_API_BASE_URL);

    try {
      const res = await fetch(
        `${baseUrl}/api/v1/documents/${envelope.documentId}`,
        { headers: { Authorization: `Bearer ${env.ZSIGN_API_KEY}` } },
      );
      if (!res.ok) {
        throw new Error(`status fetch failed (${res.status})`);
      }
      const body = (await res.json()) as CanonicalStatus;
      const result = await ctx.runMutation(internal.lib.applyCanonicalState, {
        envelopeId: args.envelopeId,
        generation,
        status: canonicalEnvelopeStatus(body),
        recipients: body.session?.recipients?.map((r) => ({
          email: r.email,
          name: r.name,
          status: r.status,
          signedAt: r.signed_at ? Date.parse(r.signed_at) : undefined,
        })),
        completedDocumentId: body.completed_document_id ?? undefined,
        completedAt: body.session?.completed_at
          ? Date.parse(body.session.completed_at)
          : undefined,
      });
      // Canonical "completed" can briefly precede the artifact id while zSign
      // finishes generating it — keep polling (bounded) so the completion
      // callback isn't created without completedDocumentId.
      const canonical = canonicalEnvelopeStatus(body);
      if (
        canonical === "completed" &&
        !body.completed_document_id &&
        attempt + 1 < MAX_ATTEMPTS
      ) {
        await ctx.scheduler.runAfter(
          BACKOFF_MS[attempt + 1],
          internal.reconcile.refreshEnvelope,
          {
            envelopeId: args.envelopeId,
            attempt: attempt + 1,
            allowTerminal: true,
          },
        );
        return { applied: result.applied, retry: true };
      }
      return { applied: result.applied };
    } catch (e) {
      await ctx.runMutation(internal.lib.markSyncError, {
        envelopeId: args.envelopeId,
        error: e instanceof Error ? e.message : String(e),
      });
      if (attempt + 1 < MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(
          BACKOFF_MS[attempt + 1],
          internal.reconcile.refreshEnvelope,
          {
            envelopeId: args.envelopeId,
            attempt: attempt + 1,
            allowTerminal: args.allowTerminal,
          },
        );
        return { retry: true };
      }
      return { done: true };
    }
  },
});

// App-facing manual refresh: `zsign.refresh(ctx, operationId)` calls this.
export const refresh = action({
  args: { operationId: v.string() },
  returns: v.object({
    found: v.boolean(),
    operation: v.optional(v.union(v.string(), v.null())),
    status: v.optional(v.string()),
    terminal: v.optional(v.boolean()),
    ...refreshResult.fields,
  }),
  // Explicit: returning a runAction of an internal function in this same file
  // would make the generated api type circular.
  handler: async (
    ctx,
    args,
  ): Promise<{
    found: boolean;
    operation?: string | null;
    status?: string;
    terminal?: boolean;
    applied?: boolean;
    retry?: boolean;
    done?: boolean;
  }> => {
    const envelope = await ctx.runQuery(api.lib.getByOperation, {
      operationId: args.operationId,
    });
    if (!envelope) {
      const op = await ctx.runQuery(api.lib.getOperation, {
        operationId: args.operationId,
      });
      return { found: false, operation: op?.status ?? null };
    }
    if (envelope.terminal) {
      return { found: true, status: envelope.status, terminal: true };
    }
    const result = await ctx.runAction(internal.reconcile.refreshEnvelope, {
      envelopeId: envelope._id as Id<"envelopes">,
      attempt: 0,
    });
    return { found: true, ...result };
  },
});

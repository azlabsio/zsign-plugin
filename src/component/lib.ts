import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

const recipientValidator = v.object({
  email: v.string(),
  name: v.string(),
  status: v.string(),
  signedAt: v.optional(v.number()),
});

const TERMINAL = new Set(["completed", "declined", "voided", "expired"]);

// Coarse ordering for envelope-level status. Recipient-level "signed" events
// update recipient rows but don't move the envelope past in_progress; only a
// canonical refresh or a terminal event can land past this rank. Events never
// demote a terminal envelope — those go through reconcile instead.
const EVENT_STATUS: Record<string, string> = {
  "document.created": "created",
  "document.sent": "sent",
  "document.viewed": "in_progress",
  "document.signed": "in_progress",
  "document.completed": "completed",
  "document.expired": "expired",
  "document.declined": "declined",
  "document.voided": "voided",
};

const STATUS_RANK: Record<string, number> = {
  created: 1,
  sent: 2,
  in_progress: 3,
  completed: 10,
  declined: 10,
  expired: 10,
  voided: 10,
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const allocateOperation = internalMutation({
  args: { operationId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique();
    if (existing) return existing;
    const now = Date.now();
    const _id = await ctx.db.insert("operations", {
      operationId: args.operationId,
      status: "allocated",
      createdAt: now,
      updatedAt: now,
    });
    return (await ctx.db.get(_id))!;
  },
});

export const markSendFailed = internalMutation({
  args: { operationId: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    const op = await ctx.db
      .query("operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique();
    if (!op || op.status === "sent") return;
    await ctx.db.patch(op._id, {
      status: "failed",
      error: args.error.slice(0, 1000),
      updatedAt: Date.now(),
    });
  },
});

export const getOperation = query({
  args: { operationId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique(),
});

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

type EventEffect = {
  type: string;
  signerEmail?: string;
  documentId?: string;
  completedAt?: string;
};

async function applyEventToEnvelope(
  ctx: MutationCtx,
  envelope: Doc<"envelopes">,
  event: EventEffect,
): Promise<"applied" | "conflict"> {
  const now = Date.now();
  const nextStatus = EVENT_STATUS[event.type];
  const patch: Record<string, unknown> = { updatedAt: now };

  if (event.type === "document.signed" && event.signerEmail) {
    patch.recipients = envelope.recipients.map((r) =>
      r.email === event.signerEmail
        ? { ...r, status: "signed", signedAt: r.signedAt ?? now }
        : r,
    );
  }

  if (nextStatus) {
    if (
      envelope.terminal &&
      (!TERMINAL.has(nextStatus) || nextStatus !== envelope.status)
    ) {
      // Any state-changing event after a terminal status — including a
      // DIFFERENT terminal one (a delayed declined/voided landing on a
      // completed envelope) — means local state and zSign disagree. Fetch
      // canonical state instead of overwriting terminal truth.
      await ctx.scheduler.runAfter(0, internal.reconcile.refreshEnvelope, {
        envelopeId: envelope._id,
        attempt: 0,
        allowTerminal: true,
      });
      return "conflict";
    }
    const currentRank = STATUS_RANK[envelope.status] ?? 0;
    const nextRank = STATUS_RANK[nextStatus] ?? 0;
    if (nextRank >= currentRank) {
      patch.status = nextStatus;
      if (TERMINAL.has(nextStatus)) patch.terminal = true;
    }
  }

  if (event.type === "document.completed") {
    patch.completedDocumentId = event.documentId;
    patch.completedAt = event.completedAt
      ? Date.parse(event.completedAt)
      : now;
    patch.recipients = envelope.recipients.map((r) => ({
      ...r,
      status: r.status === "signed" ? r.status : "signed",
      signedAt: r.signedAt ?? now,
    }));
  }

  patch.generation = envelope.generation + 1;
  await ctx.db.patch(envelope._id, patch);

  // The callback carries completedDocumentId to the app — create it only once
  // the artifact id exists; a "completed" state without it means the artifact
  // is still generating upstream (reconcile backfills it).
  if (event.type === "document.completed" && patch.completedDocumentId) {
    await ensureCompletionCallback(ctx, envelope._id);
  }
  return "applied";
}

async function ensureCompletionCallback(
  ctx: MutationCtx,
  envelopeId: Id<"envelopes">,
): Promise<void> {
  const dedupeKey = `${envelopeId}:completed`;
  const existing = await ctx.db
    .query("callbacks")
    .withIndex("by_dedupe_key", (q) => q.eq("dedupeKey", dedupeKey))
    .unique();
  if (existing) return;
  const now = Date.now();
  await ctx.db.insert("callbacks", {
    envelopeId,
    kind: "onCompleted",
    dedupeKey,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export const insertEnvelope = internalMutation({
  args: {
    operationId: v.string(),
    documentId: v.string(),
    sessionId: v.string(),
    name: v.string(),
    recipients: v.array(recipientValidator),
    metadata: v.optional(v.record(v.string(), v.string())),
    signingUrls: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("envelopes")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique();
    if (existing) return existing._id;

    const now = Date.now();
    const envelopeId = await ctx.db.insert("envelopes", {
      ...args,
      status: "sent",
      generation: 1,
      terminal: false,
      createdAt: now,
      updatedAt: now,
    });

    const op = await ctx.db
      .query("operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique();
    if (op) {
      await ctx.db.patch(op._id, {
        status: "sent",
        envelopeId,
        updatedAt: now,
      });
    }

    // Re-attach webhooks that arrived before the send response came back.
    const orphans = (
      await ctx.db
        .query("events")
        .withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
        .collect()
    )
      .filter((e) => e.envelopeId === undefined)
      .sort((a, b) => a.processedAt - b.processedAt);
    for (const e of orphans) {
      const env = (await ctx.db.get(envelopeId))!;
      await applyEventToEnvelope(ctx, env, e);
      await ctx.db.patch(e._id, { envelopeId });
    }

    return envelopeId;
  },
});

export const applyWebhookEvent = mutation({
  args: {
    eventId: v.string(),
    type: v.string(),
    sessionId: v.optional(v.string()),
    documentId: v.optional(v.string()),
    signerEmail: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<{ outcome: string }> => {
    const seen = await ctx.db
      .query("events")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (seen) return { outcome: "duplicate" };

    const envelope = args.sessionId
      ? await ctx.db
          .query("envelopes")
          .withIndex("by_session_id", (q) =>
            q.eq("sessionId", args.sessionId!),
          )
          .unique()
      : null;

    if (!envelope) {
      // Early webhook: persist it so insertEnvelope's orphan re-attach (or a
      // manual reconcile) applies it later instead of dropping it.
      await ctx.db.insert("events", {
        eventId: args.eventId,
        type: args.type,
        sessionId: args.sessionId,
        signerEmail: args.signerEmail,
        documentId: args.documentId,
        completedAt: args.completedAt,
        processedAt: Date.now(),
      });
      return { outcome: "orphaned" };
    }

    const outcome = await applyEventToEnvelope(ctx, envelope, args);
    await ctx.db.insert("events", {
      eventId: args.eventId,
      type: args.type,
      sessionId: args.sessionId,
      envelopeId: envelope._id,
      signerEmail: args.signerEmail,
      documentId: args.documentId,
      completedAt: args.completedAt,
      processedAt: Date.now(),
    });
    return { outcome };
  },
});

// ---------------------------------------------------------------------------
// Canonical refresh (called by reconcile.refreshEnvelope with a generation the
// caller read before fetching. If a webhook landed in between, generation moved
// and this write is dropped instead of clobbering newer state.)
// ---------------------------------------------------------------------------

export const applyCanonicalState = internalMutation({
  args: {
    envelopeId: v.id("envelopes"),
    generation: v.number(),
    status: v.string(),
    recipients: v.optional(v.array(recipientValidator)),
    completedDocumentId: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const envelope = await ctx.db.get(args.envelopeId);
    if (!envelope) return { applied: false };
    if (envelope.generation !== args.generation) return { applied: false };

    const now = Date.now();
    const patch: Record<string, unknown> = {
      generation: args.generation + 1,
      lastSyncedAt: now,
      syncError: undefined,
      updatedAt: now,
    };
    if (TERMINAL.has(args.status) || STATUS_RANK[args.status] !== undefined) {
      patch.status = args.status;
      patch.terminal = TERMINAL.has(args.status);
    }
    if (args.recipients) patch.recipients = args.recipients;
    if (args.completedDocumentId !== undefined) {
      patch.completedDocumentId = args.completedDocumentId;
    }
    if (args.completedAt !== undefined) patch.completedAt = args.completedAt;

    await ctx.db.patch(envelope._id, patch);
    if (
      args.status === "completed" &&
      (args.completedDocumentId ?? envelope.completedDocumentId)
    ) {
      await ensureCompletionCallback(ctx, envelope._id);
    }
    return { applied: true };
  },
});

export const markSyncError = internalMutation({
  args: { envelopeId: v.id("envelopes"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.envelopeId, {
      syncError: args.error.slice(0, 1000),
      updatedAt: Date.now(),
    });
  },
});

export const getEnvelopeInternal = internalQuery({
  args: { envelopeId: v.id("envelopes") },
  handler: async (ctx, args) => ctx.db.get(args.envelopeId),
});

// ---------------------------------------------------------------------------
// Callbacks (app-drainable work queue)
// ---------------------------------------------------------------------------

export const pendingCallbacks = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("callbacks")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(args.limit ?? 50);
    const failed = await ctx.db
      .query("callbacks")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(args.limit ?? 50);
    return [...pending, ...failed]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, args.limit ?? 50);
  },
});

export const callbackEnvelope = query({
  args: { callbackId: v.id("callbacks") },
  handler: async (ctx, args) => {
    const cb = await ctx.db.get(args.callbackId);
    if (!cb) return null;
    const envelope = await ctx.db.get(cb.envelopeId);
    if (!envelope) return null;
    return {
      callbackId: cb._id,
      kind: cb.kind,
      attempts: cb.attempts,
      documentId: envelope.documentId,
      sessionId: envelope.sessionId,
      operationId: envelope.operationId,
      completedDocumentId: envelope.completedDocumentId,
      metadata: envelope.metadata,
    };
  },
});

export const finishCallback = mutation({
  args: {
    callbackId: v.id("callbacks"),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cb = await ctx.db.get(args.callbackId);
    if (!cb) return;
    await ctx.db.patch(cb._id, {
      status: args.ok ? "succeeded" : "failed",
      attempts: cb.attempts + 1,
      lastError: args.ok ? undefined : args.error?.slice(0, 1000),
      updatedAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export const getByOperation = query({
  args: { operationId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("envelopes")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique(),
});

export const getBySession = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("envelopes")
      .withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
      .unique(),
});

export const list = query({
  args: { activeOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (args.activeOnly) {
      return ctx.db
        .query("envelopes")
        .withIndex("by_terminal", (q) => q.eq("terminal", false))
        .collect();
    }
    return ctx.db.query("envelopes").collect();
  },
});


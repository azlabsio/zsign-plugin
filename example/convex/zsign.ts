import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import type { QueryCtx, ActionCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { Zsign } from "@zsign/convex";

const zsign = new Zsign(components.zsign);

// ---------------------------------------------------------------------------
// Authenticated app wrappers. Every entrypoint resolves the caller first;
// ownership is derived from the app's own server-created record
// (envelopeOwners), never from webhook metadata or client claims.
// ---------------------------------------------------------------------------

export const ownerForOperation = internalQuery({
  args: { operationId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("envelopeOwners")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique(),
});

// Claims the operationId for a user and returns the EFFECTIVE owner id —
// callers must compare it to their own userId and bail on mismatch. Doing the
// claim inside one mutation makes the check-and-set atomic: two concurrent
// sends can't both pass an absent-owner check.
export const claimOwnership = internalMutation({
  args: { operationId: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("envelopeOwners")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique();
    if (existing) return existing.userId;
    await ctx.db.insert("envelopeOwners", {
      operationId: args.operationId,
      userId: args.userId,
      createdAt: Date.now(),
    });
    return args.userId;
  },
});

// Caller-supplied operationIds are tenant-local (`deal-${dealId}`) — the
// ownership table and the upstream Idempotency-Key are global namespaces, so
// scope by userId before claiming or sending. Two users naming the same
// business id can then never collide or block each other.
function scopedOperationId(
  userId: Id<"users">,
  operationId: string,
): string {
  return `${userId}.${operationId}`;
}

async function ownedEnvelope(
  ctx: QueryCtx | ActionCtx,
  userId: Id<"users">,
  operationId: string,
) {
  const scoped = scopedOperationId(userId, operationId);
  const owner = await ctx.runQuery(internal.zsign.ownerForOperation, {
    operationId: scoped,
  });
  if (!owner || owner.userId !== userId) throw new Error("not found");
  const envelope = await zsign.status(ctx, scoped);
  if (!envelope) throw new Error("not found");
  return { envelope, scoped };
}

async function requireUser(
  ctx: QueryCtx | ActionCtx,
  token: string,
): Promise<Id<"users">> {
  const userId = await ctx.runQuery(internal.auth.userForToken, { token });
  if (!userId) throw new Error("unauthenticated");
  return userId;
}

export const sendEnvelope = action({
  args: {
    token: v.string(),
    file: v.bytes(),
    filename: v.string(),
    signerName: v.string(),
    signerEmail: v.string(),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx, args.token);
    // Claim before send — atomically. The effective owner comes back; if it
    // isn't us, another user took this operationId. The scoped id is also
    // what goes upstream as the Idempotency-Key.
    const operationId = scopedOperationId(userId, args.operationId);
    const effectiveOwner = await ctx.runMutation(internal.zsign.claimOwnership, {
      operationId,
      userId,
    });
    if (effectiveOwner !== userId) {
      throw new Error("operationId belongs to another user");
    }
    return zsign.send(ctx, {
      file: args.file,
      filename: args.filename,
      recipients: [
        { name: args.signerName, email: args.signerEmail, role: "client" },
      ],
      operationId,
      sendInvite: false,
    });
  },
});

export const envelopeStatus = query({
  args: { token: v.string(), operationId: v.string() },
  handler: async (ctx, args) =>
    (await ownedEnvelope(ctx, await requireUser(ctx, args.token), args.operationId))
      .envelope,
});

export const listEnvelopes = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const userId = await ctx.runQuery(internal.auth.userForToken, {
      token: args.token,
    });
    if (!userId) throw new Error("unauthenticated");
    const owned = await ctx.db
      .query("envelopeOwners")
      .withIndex("by_user_id", (q) => q.eq("userId", userId))
      .collect();
    const envelopes = [];
    for (const o of owned) {
      const env = await zsign.status(ctx, o.operationId);
      if (env) envelopes.push(env);
    }
    return envelopes;
  },
});

export const refreshEnvelope = action({
  args: { token: v.string(), operationId: v.string() },
  handler: async (ctx, args) => {
    const { scoped } = await ownedEnvelope(
      ctx,
      await requireUser(ctx, args.token),
      args.operationId,
    );
    return zsign.refresh(ctx, scoped);
  },
});

export const fetchSignedPdf = action({
  args: { token: v.string(), operationId: v.string() },
  handler: async (ctx, args) => {
    const { envelope: env } = await ownedEnvelope(
      ctx,
      await requireUser(ctx, args.token),
      args.operationId,
    );
    if (!env.completedDocumentId) throw new Error("envelope not completed");
    return zsign.getSignedPdf(ctx, env.completedDocumentId);
  },
});

export const fetchCertificate = action({
  args: { token: v.string(), operationId: v.string() },
  handler: async (ctx, args) => {
    const { envelope: env } = await ownedEnvelope(
      ctx,
      await requireUser(ctx, args.token),
      args.operationId,
    );
    return zsign.getCertificate(ctx, env.documentId);
  },
});

// ---------------------------------------------------------------------------
// onCompleted draining. The component persists callback work; the app executes
// it through its own ctx, so handlers are ordinary app functions.
// ---------------------------------------------------------------------------

export const onEnvelopeCompleted = internalMutation({
  args: {
    callbackId: v.string(),
    operationId: v.string(),
    sessionId: v.string(),
    documentId: v.string(),
    completedDocumentId: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db
      .query("envelopeOwners")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique();
    if (!owner) return; // unknown envelope — nothing to advance
    const existing = await ctx.db
      .query("completions")
      .withIndex("by_operation_id", (q) =>
        q.eq("operationId", args.operationId),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("completions", {
        operationId: args.operationId,
        userId: owner.userId,
        processedAt: Date.now(),
        note: "envelope completed",
      });
    }
  },
});

// Scheduled by crons.ts (and callable by hand): drain persisted callbacks.
export const processCompletions = action({
  args: {},
  // Explicit: the handler's arg references this same module's internal api,
  // which would otherwise make its own inferred type circular.
  handler: async (ctx): Promise<{ processed: number; failed: number }> =>
    zsign.onCompleted(ctx, internal.zsign.onEnvelopeCompleted),
});

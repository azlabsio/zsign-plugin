import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const recipientValidator = v.object({
  email: v.string(),
  name: v.string(),
  status: v.string(),
  signedAt: v.optional(v.number()),
});

export default defineSchema({
  // One row per send attempt. Allocated before the external POST so an early
  // webhook or an interrupted send has a durable record to reconcile against.
  // `operationId` is also the Idempotency-Key sent to zSign.
  operations: defineTable({
    operationId: v.string(),
    status: v.string(), // allocated | sent | failed
    envelopeId: v.optional(v.id("envelopes")),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_operation_id", ["operationId"]),

  envelopes: defineTable({
    operationId: v.string(),
    documentId: v.string(), // original upload id; never overwritten
    sessionId: v.string(),
    completedDocumentId: v.optional(v.string()),
    // Stored so a replayed send can return the same signing links the first
    // response carried (sendInvite:false callers need them).
    signingUrls: v.optional(v.any()),
    name: v.string(),
    status: v.string(),
    recipients: v.array(recipientValidator),
    // Integrator metadata — string-only, validated on the way in.
    metadata: v.optional(v.record(v.string(), v.string())),
    // Monotonic write guard: canonical refreshes apply only while the
    // generation they read still matches, so a stale refresh can never
    // overwrite a newer webhook result.
    generation: v.number(),
    terminal: v.boolean(),
    lastSyncedAt: v.optional(v.number()),
    syncError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_operation_id", ["operationId"])
    .index("by_document_id", ["documentId"])
    .index("by_terminal", ["terminal"]),

  // Durable webhook receipt log. Insertion is the dedupe: a second delivery
  // of the same eventId is acknowledged without reapplying effects.
  events: defineTable({
    eventId: v.string(),
    type: v.string(),
    sessionId: v.optional(v.string()),
    envelopeId: v.optional(v.id("envelopes")),
    // Payload fields needed to re-apply an orphaned event once its envelope
    // exists.
    signerEmail: v.optional(v.string()),
    documentId: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    processedAt: v.number(),
  })
    .index("by_event_id", ["eventId"])
    .index("by_session_id", ["sessionId"]),

  // Persisted post-completion work the app drains with its own handlers.
  // One row per (envelope, kind) via dedupeKey; failures stay visible and
  // retryable.
  callbacks: defineTable({
    envelopeId: v.id("envelopes"),
    kind: v.string(), // currently only "onCompleted"
    dedupeKey: v.string(),
    status: v.string(), // pending | succeeded | failed
    attempts: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dedupe_key", ["dedupeKey"])
    .index("by_status", ["status"]),
});

import { v } from "convex/values";

// Single source of truth for the table shapes. schema.ts builds the tables
// from the *Fields objects; the *Doc validators (fields + system columns) are
// what functions declare in `returns` when they hand a row across the
// component boundary, so the app-side types track the schema exactly.

export const recipientValidator = v.object({
  email: v.string(),
  name: v.string(),
  status: v.string(),
  signedAt: v.optional(v.number()),
});

export const operationFields = {
  operationId: v.string(),
  status: v.string(), // allocated | sent | failed
  envelopeId: v.optional(v.id("envelopes")),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const envelopeFields = {
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
};

export const eventFields = {
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
};

export const callbackFields = {
  envelopeId: v.id("envelopes"),
  kind: v.string(), // currently only "onCompleted"
  dedupeKey: v.string(),
  status: v.string(), // pending | succeeded | failed
  attempts: v.number(),
  lastError: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const operationDoc = v.object({
  _id: v.id("operations"),
  _creationTime: v.number(),
  ...operationFields,
});

export const envelopeDoc = v.object({
  _id: v.id("envelopes"),
  _creationTime: v.number(),
  ...envelopeFields,
});

export const callbackDoc = v.object({
  _id: v.id("callbacks"),
  _creationTime: v.number(),
  ...callbackFields,
});

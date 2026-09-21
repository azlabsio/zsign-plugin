import { defineSchema, defineTable } from "convex/server";
import {
  callbackFields,
  envelopeFields,
  eventFields,
  operationFields,
} from "./validators.js";

export default defineSchema({
  // One row per send attempt. Allocated before the external POST so an early
  // webhook or an interrupted send has a durable record to reconcile against.
  // `operationId` is also the Idempotency-Key sent to zSign.
  operations: defineTable(operationFields).index("by_operation_id", [
    "operationId",
  ]),

  envelopes: defineTable(envelopeFields)
    .index("by_session_id", ["sessionId"])
    .index("by_operation_id", ["operationId"])
    .index("by_document_id", ["documentId"])
    .index("by_terminal", ["terminal"]),

  // Durable webhook receipt log. Insertion is the dedupe: a second delivery
  // of the same eventId is acknowledged without reapplying effects.
  events: defineTable(eventFields)
    .index("by_event_id", ["eventId"])
    .index("by_session_id", ["sessionId"]),

  // Persisted post-completion work the app drains with its own handlers.
  // One row per (envelope, kind) via dedupeKey; failures stay visible and
  // retryable.
  callbacks: defineTable(callbackFields)
    .index("by_dedupe_key", ["dedupeKey"])
    .index("by_status", ["status"]),
});

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Demo auth: email + salted PBKDF2 password, sessions are opaque tokens.
// Replace with Convex Auth / Clerk / Auth0 in a real app — the point of this
// file is the wrapper shape, not the credential model.
export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  sessions: defineTable({
    token: v.string(),
    userId: v.id("users"),
    expiresAt: v.number(),
  }).index("by_token", ["token"]),

  // Tenant ownership lives in the APP, derived from the server-created
  // operation record — never from webhook metadata, which is untrusted.
  envelopeOwners: defineTable({
    operationId: v.string(),
    userId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_operation_id", ["operationId"])
    .index("by_user_id", ["userId"]),

  // Where the demo's onCompleted handler lands its work.
  completions: defineTable({
    operationId: v.string(),
    userId: v.id("users"),
    processedAt: v.number(),
    signedPdfBytes: v.optional(v.number()),
    note: v.optional(v.string()),
  }).index("by_operation_id", ["operationId"]),
});

import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: new TextEncoder().encode(salt),
    },
    key,
    256,
  );
  return toHex(bits);
}

async function issueSession(ctx: MutationCtx, userId: Id<"users">) {
  const token = crypto.randomUUID();
  await ctx.db.insert("sessions", {
    token,
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { token, userId };
}

export const signUp = mutation({
  args: { name: v.string(), email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    // An existing email is not proof of identity — never issue a session
    // for an account whose password wasn't just verified.
    if (existing) {
      throw new Error("An account with this email already exists — sign in");
    }
    const passwordSalt = crypto.randomUUID();
    const passwordHash = await hashPassword(args.password, passwordSalt);
    const userId = await ctx.db.insert("users", {
      name: args.name,
      email: args.email,
      passwordHash,
      passwordSalt,
      createdAt: Date.now(),
    });
    return issueSession(ctx, userId);
  },
});

export const signIn = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    const invalid = new Error("Invalid email or password");
    if (!user) throw invalid;
    const hash = await hashPassword(args.password, user.passwordSalt);
    if (hash !== user.passwordHash) throw invalid;
    return issueSession(ctx, user._id);
  },
});

// Resolves a session token to a userId. Internal so only other app functions
// (queries and actions alike, via ctx.runQuery) can call it.
export const userForToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!session || session.expiresAt < Date.now()) return null;
    return session.userId;
  },
});

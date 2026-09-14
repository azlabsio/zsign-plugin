import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../src/component/schema.js";
import { api, internal } from "../src/component/_generated/api.js";

// Test the component's own functions directly — convex-test resolves
// `import.meta.glob` at build time for the component's modules.
const modules = import.meta.glob("../src/component/**/*.ts");

function t() {
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedEnvelope(
  t: ReturnType<typeof convexTest>,
  args: {
    operationId: string;
    sessionId: string;
    documentId?: string;
    recipients?: { email: string; name: string; status: string }[];
  },
) {
  return t.mutation(internal.lib.allocateOperation, {
    operationId: args.operationId,
  }).then(() =>
    t.mutation(internal.lib.insertEnvelope, {
      operationId: args.operationId,
      documentId: args.documentId ?? "doc-1",
      sessionId: args.sessionId,
      name: "test.pdf",
      recipients: args.recipients ?? [
        { email: "signer@example.com", name: "Signer", status: "sent" },
      ],
    }),
  );
}

describe("applyWebhookEvent", () => {
  test("duplicate event ids are acknowledged without reapplying", async () => {
    const t_ = t();
    const env = await seedEnvelope(t_, {
      operationId: "op-1",
      sessionId: "sess-1",
    });
    const event = {
      eventId: "evt-1",
      type: "document.viewed",
      sessionId: "sess-1",
      signerEmail: "signer@example.com",
    };
    const first = await t_.mutation(api.lib.applyWebhookEvent, event);
    const second = await t_.mutation(api.lib.applyWebhookEvent, event);
    expect(first).toEqual({ outcome: "applied" });
    expect(second).toEqual({ outcome: "duplicate" });
    await t_.run(async (ctx) => {
      const events = await ctx.db.query("events").collect();
      expect(events).toHaveLength(1);
    });
  });

  test("early webhooks persist as orphans and re-attach when the envelope lands", async () => {
    const t_ = t();
    // Webhook arrives before send() has inserted the envelope.
    const orphan = await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "evt-early",
      type: "document.completed",
      sessionId: "sess-late",
      documentId: "completed-doc-9",
      completedAt: "2026-01-01T00:00:00Z",
    });
    expect(orphan).toEqual({ outcome: "orphaned" });

    await seedEnvelope(t_, {
      operationId: "op-2",
      sessionId: "sess-late",
    });
    const env = await t_.query(api.lib.getBySession, {
      sessionId: "sess-late",
    });
    expect(env?.status).toBe("completed");
    expect(env?.completedDocumentId).toBe("completed-doc-9");
    expect(env?.terminal).toBe(true);

    // And the completion produced callback work for the app to drain.
    const pending = await t_.query(api.lib.pendingCallbacks, {});
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("onCompleted");
  });

  test("reordered events: a viewed event cannot demote a completed envelope", async () => {
    const t_ = t();
    await seedEnvelope(t_, {
      operationId: "op-3",
      sessionId: "sess-3",
    });
    await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "evt-c",
      type: "document.completed",
      sessionId: "sess-3",
      documentId: "cdoc-3",
    });
    const conflict = await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "evt-v",
      type: "document.viewed",
      sessionId: "sess-3",
    });
    expect(conflict).toEqual({ outcome: "conflict" });
    const env = await t_.query(api.lib.getBySession, {
      sessionId: "sess-3",
    });
    expect(env?.status).toBe("completed");
    expect(env?.terminal).toBe(true);

    // The conflict scheduled a canonical refresh; run it to prove the
    // generation guard keeps the terminal state (and to drain the scheduler
    // so convex-test doesn't leak a write outside a transaction).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "completed",
          session: { status: "completed", recipients: [] },
          completed_document_id: "cdoc-3",
        }),
      ),
    );
    await t_.finishAllScheduledFunctions(async () => {});
    const after = await t_.query(api.lib.getBySession, {
      sessionId: "sess-3",
    });
    expect(after?.status).toBe("completed");

  });

  test("a different terminal event on a completed envelope reconciles instead of overwriting", async () => {
    const t_ = t();
    await seedEnvelope(t_, {
      operationId: "op-term",
      sessionId: "sess-term",
    });
    await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "evt-c9",
      type: "document.completed",
      sessionId: "sess-term",
      documentId: "cdoc-9",
    });
    // A delayed/ordered-wrong declined event must not clobber the completed
    // state — zSign's canonical response decides.
    const conflict = await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "evt-d9",
      type: "document.declined",
      sessionId: "sess-term",
    });
    expect(conflict).toEqual({ outcome: "conflict" });
    const env = await t_.query(api.lib.getBySession, {
      sessionId: "sess-term",
    });
    expect(env?.status).toBe("completed");
    expect(env?.completedDocumentId).toBe("cdoc-9");
    expect(env?.terminal).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "completed",
          session: { status: "completed", recipients: [] },
          completed_document_id: "cdoc-9",
        }),
      ),
    );
    await t_.finishAllScheduledFunctions(async () => {});
    const after = await t_.query(api.lib.getBySession, {
      sessionId: "sess-term",
    });
    expect(after?.status).toBe("completed");
  });

  test("signed events update the matching recipient only", async () => {
    const t_ = t();
    await seedEnvelope(t_, {
      operationId: "op-4",
      sessionId: "sess-4",
      recipients: [
        { email: "a@example.com", name: "A", status: "sent" },
        { email: "b@example.com", name: "B", status: "sent" },
      ],
    });
    await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "evt-s",
      type: "document.signed",
      sessionId: "sess-4",
      signerEmail: "a@example.com",
    });
    const env = await t_.query(api.lib.getBySession, {
      sessionId: "sess-4",
    });
    expect(env?.recipients.find((r: any) => r.email === "a@example.com")?.status).toBe(
      "signed",
    );
    expect(env?.recipients.find((r: any) => r.email === "b@example.com")?.status).toBe(
      "sent",
    );
    expect(env?.status).toBe("in_progress");
  });
});

describe("operations", () => {
  test("allocateOperation is idempotent and markSendFailed preserves sent ops", async () => {
    const t_ = t();
    const op1 = await t_.mutation(internal.lib.allocateOperation, {
      operationId: "op-x",
    });
    const op2 = await t_.mutation(internal.lib.allocateOperation, {
      operationId: "op-x",
    });
    expect(op2._id).toBe(op1._id);

    await t_.mutation(internal.lib.markSendFailed, {
      operationId: "op-x",
      error: "http 402",
    });
    const failed = await t_.query(api.lib.getOperation, {
      operationId: "op-x",
    });
    expect(failed?.status).toBe("failed");

    // Once an envelope exists, a late failure report cannot un-send it.
    await seedEnvelope(t_, { operationId: "op-x", sessionId: "sess-x" });
    await t_.mutation(internal.lib.markSendFailed, {
      operationId: "op-x",
      error: "stale failure",
    });
    const op = await t_.query(api.lib.getOperation, {
      operationId: "op-x",
    });
    expect(op?.status).toBe("sent");
  });
});

describe("canonical state + generation guard", () => {
  test("a refresh that read a stale generation is dropped", async () => {
    const t_ = t();
    await seedEnvelope(t_, {
      operationId: "op-5",
      sessionId: "sess-5",
    });
    const env = await t_.query(api.lib.getBySession, {
      sessionId: "sess-5",
    });
    const staleGen = env!.generation;

    // A webhook lands between the refresh's read and write.
    await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "evt-1",
      type: "document.signed",
      sessionId: "sess-5",
      signerEmail: "signer@example.com",
    });

    const result = await t_.mutation(internal.lib.applyCanonicalState, {
      envelopeId: env!._id,
      generation: staleGen,
      status: "sent",
      recipients: [
        { email: "signer@example.com", name: "Signer", status: "sent" },
      ],
    });
    expect(result).toEqual({ applied: false });
    const after = await t_.query(api.lib.getBySession, {
      sessionId: "sess-5",
    });
    expect(after?.recipients[0].status).toBe("signed");
  });

  test("a matching-generation canonical apply wins and clears syncError", async () => {
    const t_ = t();
    await seedEnvelope(t_, {
      operationId: "op-6",
      sessionId: "sess-6",
    });
    const env = await t_.query(api.lib.getBySession, {
      sessionId: "sess-6",
    });
    await t_.mutation(internal.lib.markSyncError, {
      envelopeId: env!._id,
      error: "boom",
    });
    const result = await t_.mutation(internal.lib.applyCanonicalState, {
      envelopeId: env!._id,
      generation: env!.generation,
      status: "completed",
      completedDocumentId: "cdoc-6",
      completedAt: Date.now(),
    });
    expect(result).toEqual({ applied: true });
    const after = await t_.query(api.lib.getBySession, {
      sessionId: "sess-6",
    });
    expect(after?.status).toBe("completed");
    expect(after?.terminal).toBe(true);
    expect(after?.syncError).toBeUndefined();

  });
});

describe("reconcile failure handling", () => {
  test("backend unavailable → syncError persisted, envelope unchanged", async () => {
    const t_ = t();
    await seedEnvelope(t_, {
      operationId: "op-8",
      sessionId: "sess-8",
    });
    const before = await t_.query(api.lib.getBySession, {
      sessionId: "sess-8",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    // Attempt 5 is the last slot — no further scheduling, no real timers.
    // (Retry scheduling itself isn't exercisable here: convex-test's action
    // ctx has no transaction for the _scheduled_functions write.)
    const result = await t_.action(internal.reconcile.refreshEnvelope, {
      envelopeId: before!._id,
      attempt: 5,
    });
    expect(result).toEqual({ done: true });
    const after = await t_.query(api.lib.getBySession, {
      sessionId: "sess-8",
    });
    expect(after?.status).toBe(before?.status);
    expect(after?.syncError).toContain("ECONNREFUSED");
  });
});

describe("callbacks", () => {
  test("completion creates exactly one callback; finishCallback persists failures", async () => {
    const t_ = t();
    await seedEnvelope(t_, {
      operationId: "op-7",
      sessionId: "sess-7",
    });
    for (const id of ["e1", "e2", "e3"]) {
      await t_.mutation(api.lib.applyWebhookEvent, {
        eventId: id,
        type: "document.completed",
        sessionId: "sess-7",
        documentId: "cdoc-7",
      });
    }
    const pending = await t_.query(api.lib.pendingCallbacks, {});
    expect(pending).toHaveLength(1);

    await t_.mutation(api.lib.finishCallback, {
      callbackId: pending[0]._id,
      ok: false,
      error: "handler threw",
    });
    const retryable = await t_.query(api.lib.pendingCallbacks, {});
    expect(retryable).toHaveLength(1);
    expect(retryable[0].status).toBe("failed");
    expect(retryable[0].lastError).toBe("handler threw");

    await t_.mutation(api.lib.finishCallback, {
      callbackId: retryable[0]._id,
      ok: true,
    });
    expect(await t_.query(api.lib.pendingCallbacks, {})).toHaveLength(0);
  });
});

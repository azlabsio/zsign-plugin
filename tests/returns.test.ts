import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../src/component/schema.js";
import { api, internal } from "../src/component/_generated/api.js";

// Every function declares a `returns` validator, and convex-test enforces
// them at call time. component.test.ts already drives most of lib.ts; this
// file covers the public surface it doesn't, so a return shape that drifts
// from its validator fails here instead of in an app.
const modules = import.meta.glob("../src/component/**/*.ts");

function t() {
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

describe("returns validators", () => {
  test("send: a response without signing_urls still satisfies the validator", async () => {
    const t_ = t();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ document_id: "doc-r1", session_id: "sess-r1" }),
      ),
    );
    const result = await t_.action(api.send.send, {
      file: new ArrayBuffer(4),
      filename: "a.pdf",
      recipients: [{ name: "S", email: "s@example.com" }],
      operationId: "op-r1",
    });
    expect(result.documentId).toBe("doc-r1");
    expect(result.sessionId).toBe("sess-r1");
    expect(result.replayed).toBe(false);
    expect(result.signingUrls).toBeUndefined();

    // Replay path returns the stored envelope's fields through the same
    // validator.
    const replay = await t_.action(api.send.send, {
      file: new ArrayBuffer(4),
      filename: "a.pdf",
      recipients: [{ name: "S", email: "s@example.com" }],
      operationId: "op-r1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.envelopeId).toBe(result.envelopeId);
  });

  test("getByOperation and list return full envelope docs", async () => {
    const t_ = t();
    await t_.mutation(internal.lib.allocateOperation, { operationId: "op-r2" });
    await t_.mutation(internal.lib.insertEnvelope, {
      operationId: "op-r2",
      documentId: "doc-r2",
      sessionId: "sess-r2",
      name: "b.pdf",
      recipients: [{ email: "x@example.com", name: "X", status: "sent" }],
      signingUrls: { "x@example.com": "https://sign.example/x" },
    });
    const env = await t_.query(api.lib.getByOperation, {
      operationId: "op-r2",
    });
    expect(env?.sessionId).toBe("sess-r2");
    expect(env?.signingUrls).toEqual({
      "x@example.com": "https://sign.example/x",
    });
    expect(await t_.query(api.lib.getByOperation, { operationId: "nope" })).toBe(
      null,
    );

    const all = await t_.query(api.lib.list, {});
    expect(all).toHaveLength(1);
    const active = await t_.query(api.lib.list, { activeOnly: true });
    expect(active[0]._id).toBe(env!._id);
  });

  test("callbackEnvelope: metadata absent, completedDocumentId present", async () => {
    const t_ = t();
    await t_.mutation(internal.lib.allocateOperation, { operationId: "op-r3" });
    await t_.mutation(internal.lib.insertEnvelope, {
      operationId: "op-r3",
      documentId: "doc-r3",
      sessionId: "sess-r3",
      name: "c.pdf",
      recipients: [{ email: "y@example.com", name: "Y", status: "sent" }],
    });
    await t_.mutation(api.lib.applyWebhookEvent, {
      eventId: "ev-r3",
      type: "document.completed",
      sessionId: "sess-r3",
      documentId: "cdoc-r3",
    });
    const [cb] = await t_.query(api.lib.pendingCallbacks, {});
    const detail = await t_.query(api.lib.callbackEnvelope, {
      callbackId: cb._id,
    });
    expect(detail).toMatchObject({
      callbackId: cb._id,
      kind: "onCompleted",
      attempts: 0,
      operationId: "op-r3",
      completedDocumentId: "cdoc-r3",
    });
    expect(detail?.metadata).toBeUndefined();
  });

  test("refresh: unknown operation, then a live canonical pull", async () => {
    const t_ = t();
    expect(
      await t_.action(api.reconcile.refresh, { operationId: "missing" }),
    ).toEqual({ found: false, operation: null });

    await t_.mutation(internal.lib.allocateOperation, { operationId: "op-r4" });
    await t_.mutation(internal.lib.insertEnvelope, {
      operationId: "op-r4",
      documentId: "doc-r4",
      sessionId: "sess-r4",
      name: "d.pdf",
      recipients: [{ email: "z@example.com", name: "Z", status: "sent" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "in_progress",
          session: { status: "in_progress", recipients: [] },
        }),
      ),
    );
    const live = await t_.action(api.reconcile.refresh, {
      operationId: "op-r4",
    });
    expect(live).toEqual({ found: true, applied: true });
  });

  test("getSignedPdf returns the artifact bytes", async () => {
    const t_ = t();
    const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer; // %PDF
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => payload,
      })),
    );
    const bytes = await t_.action(api.send.getSignedPdf, {
      completedDocumentId: "cdoc-r5",
    });
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array(payload));
  });
});

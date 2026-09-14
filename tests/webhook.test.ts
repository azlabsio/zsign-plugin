import { describe, expect, test, vi } from "vitest";
import {
  hmacSha256Hex,
  verifyWebhookRequest,
} from "../src/component/webhook.js";

const SECRET = "whsec_test_secret";

async function signedRequest(
  body: object,
  opts?: {
    secret?: string;
    eventId?: string;
    t?: number;
    omitSignature?: boolean;
  },
): Promise<Request> {
  const raw = JSON.stringify(body);
  const headers = new Headers();
  if (opts?.eventId) headers.set("X-Webhook-Id", opts.eventId);
  if (!opts?.omitSignature) {
    const t = opts?.t ?? Math.floor(Date.now() / 1000);
    const v1 = await hmacSha256Hex(opts?.secret ?? SECRET, `${t}.${raw}`);
    headers.set("X-Webhook-Signature", `t=${t},v1=${v1}`);
  }
  return new Request("https://example.com/zsign/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

const EVENT = {
  id: "evt_1",
  type: "document.signed",
  data: {
    session_id: "sess-1",
    signer_email: "signer@example.com",
  },
};

describe("verifyWebhookRequest", () => {
  test("accepts a validly signed delivery and normalizes snake_case", async () => {
    const res = await verifyWebhookRequest(await signedRequest(EVENT), [
      SECRET,
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.event).toMatchObject({
        eventId: "evt_1",
        type: "document.signed",
        sessionId: "sess-1",
        signerEmail: "signer@example.com",
      });
    }
  });

  test("rejects a tampered body / wrong secret with 401", async () => {
    const res = await verifyWebhookRequest(
      await signedRequest(EVENT, { secret: "whsec_wrong" }),
      [SECRET],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  test("rejects a stale timestamp with 401", async () => {
    const res = await verifyWebhookRequest(
      await signedRequest(EVENT, {
        t: Math.floor(Date.now() / 1000) - 1000,
      }),
      [SECRET],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  test("rejects a missing signature with 401", async () => {
    const res = await verifyWebhookRequest(
      await signedRequest(EVENT, { omitSignature: true }),
      [SECRET],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  test("rotation window: the previous secret still verifies", async () => {
    const res = await verifyWebhookRequest(
      await signedRequest(EVENT, { secret: "whsec_old" }),
      ["whsec_new", "whsec_old"],
    );
    expect(res.ok).toBe(true);
  });

  test("header event id wins over body id; body id is the fallback", async () => {
    const withHeader = await verifyWebhookRequest(
      await signedRequest(EVENT, { eventId: "delivery-9" }),
      [SECRET],
    );
    expect(withHeader.ok && withHeader.event.eventId === "delivery-9").toBe(
      true,
    );
    const fallback = await verifyWebhookRequest(await signedRequest(EVENT), [
      SECRET,
    ]);
    expect(fallback.ok && fallback.event.eventId === "evt_1").toBe(true);
  });
});

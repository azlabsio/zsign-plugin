// Shared webhook verification + parsing. Used by the component's own http
// route and re-exported through the client so the app-level route stays a
// one-liner. Web Crypto only — no Node crypto — so it runs in Convex HTTP
// actions.

const TOLERANCE_SECONDS = 300;

export async function hmacSha256Hex(
  secret: string,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type ParsedWebhook = {
  eventId: string;
  type: string;
  sessionId?: string;
  documentId?: string;
  signerEmail?: string;
  completedAt?: string;
  metadata?: unknown;
};

export type WebhookVerification =
  | { ok: true; event: ParsedWebhook }
  | { ok: false; status: number; error: string };

// `secrets` accepts [current, previous] so a rotation window keeps old-signed
// deliveries valid while senders migrate.
export async function verifyWebhookRequest(
  request: Request,
  secrets: (string | undefined)[],
): Promise<WebhookVerification> {
  const rawBody = await request.text();
  const active = secrets.filter((s): s is string => Boolean(s));
  if (active.length === 0) {
    return { ok: false, status: 500, error: "webhook secret not configured" };
  }

  const header = request.headers.get("X-Webhook-Signature");
  if (!header) {
    return { ok: false, status: 401, error: "missing signature" };
  }
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((kv) => kv.split("=", 2) as [string, string])
      .filter(([k]) => k.length > 0),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) {
    return { ok: false, status: 401, error: "malformed signature" };
  }
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) {
    return { ok: false, status: 401, error: "stale signature" };
  }

  let matched = false;
  for (const secret of active) {
    const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
    if (timingSafeEqual(expected, v1)) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    return { ok: false, status: 401, error: "invalid signature" };
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error: "invalid json" };
  }
  const data = (event.data ?? {}) as Record<string, unknown>;
  const eventId =
    request.headers.get("X-Webhook-Id") ??
    (typeof event.id === "string" ? event.id : undefined);
  if (!eventId || typeof event.type !== "string") {
    return { ok: false, status: 400, error: "missing event id or type" };
  }

  return {
    ok: true,
    event: {
      eventId,
      type: event.type,
      sessionId:
        typeof data.session_id === "string" ? data.session_id : undefined,
      documentId:
        typeof data.document_id === "string" ? data.document_id : undefined,
      signerEmail:
        typeof data.signer_email === "string" ? data.signer_email : undefined,
      completedAt:
        typeof data.completed_at === "string" ? data.completed_at : undefined,
      metadata: data.metadata,
    },
  };
}

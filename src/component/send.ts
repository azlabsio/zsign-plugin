import { v } from "convex/values";
import { action, env } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";

const DEFAULT_BASE_URL = "https://api.zsign.io";
const COMPONENT_VERSION = "0.1.0";

export const send = action({
  args: {
    file: v.bytes(),
    filename: v.string(),
    name: v.optional(v.string()),
    recipients: v.array(
      v.object({
        name: v.string(),
        email: v.string(),
        role: v.optional(v.string()),
      }),
    ),
    operationId: v.string(),
    metadata: v.optional(v.record(v.string(), v.string())),
    sequential: v.optional(v.boolean()),
    sendInvite: v.optional(v.boolean()),
    sendCompletionEmail: v.optional(v.boolean()),
  },
  // Explicit: the handler calls back into internal.lib / api.lib, and
  // inferring it would make the component's own api type reference itself.
  handler: async (
    ctx,
    args,
  ): Promise<{
    envelopeId: string;
    documentId: string;
    sessionId: string;
    signingUrls: unknown;
    replayed: boolean;
  }> => {
    if (!args.filename.toLowerCase().endsWith(".pdf")) {
      throw new Error("zsign.send only accepts PDF files");
    }

    // Allocate the operation record BEFORE the external POST so an early
    // webhook or an interrupted send has durable state to attach to. A repeat
    // call with a completed operation replays its stored result.
    const op = await ctx.runMutation(internal.lib.allocateOperation, {
      operationId: args.operationId,
    });
    if (op.status === "sent" && op.envelopeId) {
      const existing = await ctx.runQuery(api.lib.getByOperation, {
        operationId: args.operationId,
      });
      if (existing) {
        return {
          envelopeId: existing._id,
          documentId: existing.documentId,
          sessionId: existing.sessionId,
          signingUrls: existing.signingUrls,
          replayed: true,
        };
      }
    }

    const baseUrl = env.ZSIGN_API_BASE_URL ?? DEFAULT_BASE_URL;
    const apiKey = env.ZSIGN_API_KEY;

    // The Convex runtime's FormData drops the file MIME type and zSign
    // rejects application/octet-stream — build the multipart body by hand.
    const boundary = `----zsign${Date.now().toString(16)}${Math.random()
      .toString(16)
      .slice(2)}`;
    const fields: Record<string, string> = {
      recipients: JSON.stringify(args.recipients),
      metadata: JSON.stringify({
        ...args.metadata,
        // Opaque component-owned correlation keys. User keys named
        // "zsign.*" are overridden, never trusted.
        "zsign.operation_id": args.operationId,
        "zsign.component_version": COMPONENT_VERSION,
      }),
      sequential: String(args.sequential ?? true),
      send_invite: String(args.sendInvite ?? true),
      send_completion_email: String(args.sendCompletionEmail ?? true),
    };
    if (args.name) fields.name = args.name;

    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const [k, value] of Object.entries(fields)) {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${value}\r\n`,
        ),
      );
    }
    // The filename lands inside a quoted-string header parameter — strip
    // quotes, backslashes, CR/LF, and non-ASCII so a hostile or merely odd
    // name can't inject or corrupt MIME headers.
    const safeFilename = args.filename.replace(/[^\x20-\x7E]|["\\]/g, "_");
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
    );
    chunks.push(new Uint8Array(args.file));
    chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.length;
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/v1/documents/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          // operationId doubles as the server-enforced Idempotency-Key: a
          // retried send replays instead of debiting a second envelope.
          "Idempotency-Key": args.operationId,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
    } catch (e) {
      // Network-level failure: the send may or may not have landed. Record
      // the failure so refresh/manual inspection can see it; the caller can
      // safely retry with the same operationId thanks to the backend's
      // Idempotency-Key handling.
      const message = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.lib.markSendFailed, {
        operationId: args.operationId,
        error: `network: ${message}`,
      });
      throw new Error(`zSign send failed (network): ${message}`);
    }

    const responseBody = (await res.json().catch(() => ({}))) as {
      document_id?: string;
      session_id?: string;
      signing_urls?: unknown;
      detail?: unknown;
    };
    if (!res.ok || !responseBody.document_id || !responseBody.session_id) {
      const detail = JSON.stringify(responseBody);
      await ctx.runMutation(internal.lib.markSendFailed, {
        operationId: args.operationId,
        error: `http ${res.status}: ${detail}`,
      });
      throw new Error(`zSign send failed (${res.status}): ${detail}`);
    }

    const recipients = args.recipients.map((r) => ({
      email: r.email,
      name: r.name,
      status: "sent",
    }));

    const envelopeId = await ctx.runMutation(internal.lib.insertEnvelope, {
      operationId: args.operationId,
      documentId: responseBody.document_id,
      sessionId: responseBody.session_id,
      name: args.name ?? args.filename,
      recipients,
      metadata: args.metadata,
      signingUrls: responseBody.signing_urls,
    });

    return {
      envelopeId,
      documentId: responseBody.document_id,
      sessionId: responseBody.session_id,
      signingUrls: responseBody.signing_urls,
      replayed: false,
    };
  },
});

async function fetchArtifact(
  apiKey: string,
  baseUrl: string,
  path: string,
): Promise<ArrayBuffer> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`zSign artifact fetch failed (${res.status}): ${path}`);
  }
  return res.arrayBuffer();
}

export const getSignedPdf = action({
  args: { completedDocumentId: v.string() },
  handler: async (ctx, args) =>
    fetchArtifact(
      env.ZSIGN_API_KEY,
      env.ZSIGN_API_BASE_URL ?? DEFAULT_BASE_URL,
      `/api/v1/documents/${args.completedDocumentId}/download`,
    ),
});

export const getCertificate = action({
  args: { documentId: v.string() },
  handler: async (ctx, args) =>
    fetchArtifact(
      env.ZSIGN_API_KEY,
      env.ZSIGN_API_BASE_URL ?? DEFAULT_BASE_URL,
      `/api/v1/documents/${args.documentId}/certificate`,
    ),
});

import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { verifyWebhookRequest } from "../component/webhook.js";

export type { ParsedWebhook, WebhookVerification } from "../component/webhook.js";
export { verifyWebhookRequest };
export type ZsignComponent = ComponentApi;

// Structural ctx types: any app ctx (query, mutation, or action) satisfies
// these, sidestepping GenericXxxCtx<DataModel> invariance across package
// boundaries.
export type ZsignQueryCtx = {
  // `any[]` on args is deliberate: QueryCtx and ActionCtx declare different
  // optional trailing params (transaction limits, scheduling options), and no
  // single rest-tuple is assignable from both. Argument correctness is still
  // enforced at the call site by the FunctionReference's own args type.
  runQuery<Query extends FunctionReference<"query", "public" | "internal">>(
    query: Query,
    ...args: any[]
  ): Promise<FunctionReturnType<Query>>;
};
export type ZsignMutationCtx = {
  runMutation<
    Mutation extends FunctionReference<"mutation", "public" | "internal">,
  >(
    mutation: Mutation,
    ...args: any[]
  ): Promise<FunctionReturnType<Mutation>>;
};
export type ZsignActionCtx = ZsignQueryCtx &
  ZsignMutationCtx & {
    runAction<
      Action extends FunctionReference<"action", "public" | "internal">,
    >(
      action: Action,
      ...args: any[]
    ): Promise<FunctionReturnType<Action>>;
  };

export type ZsignRecipient = {
  name: string;
  email: string;
  role?: string;
};

export type ZsignSendArgs = {
  file: ArrayBuffer;
  filename: string;
  name?: string;
  recipients: ZsignRecipient[];
  // Required: also becomes the server-enforced Idempotency-Key. Reuse it to
  // safely retry a send whose result was uncertain.
  operationId: string;
  metadata?: Record<string, string>;
  sequential?: boolean;
  sendInvite?: boolean;
  sendCompletionEmail?: boolean;
};

export type ZsignSendResult = {
  envelopeId: string;
  documentId: string;
  sessionId: string;
  signingUrls: unknown;
  replayed: boolean;
};

export type OnCompletedArgs = {
  callbackId: string;
  operationId: string;
  sessionId: string;
  documentId: string;
  completedDocumentId?: string;
  metadata?: Record<string, string>;
};

export class Zsign {
  constructor(public component: ComponentApi) {}

  send(ctx: ZsignActionCtx, args: ZsignSendArgs): Promise<ZsignSendResult> {
    return ctx.runAction(this.component.send.send, args);
  }

  status(ctx: ZsignQueryCtx, operationId: string) {
    return ctx.runQuery(this.component.lib.getByOperation, { operationId });
  }

  list(ctx: ZsignQueryCtx, opts?: { activeOnly?: boolean }) {
    return ctx.runQuery(this.component.lib.list, {
      activeOnly: opts?.activeOnly,
    });
  }

  // Force a canonical status pull from zSign for a live envelope.
  refresh(ctx: ZsignActionCtx, operationId: string) {
    return ctx.runAction(this.component.reconcile.refresh, { operationId });
  }

  getSignedPdf(ctx: ZsignActionCtx, completedDocumentId: string) {
    return ctx.runAction(this.component.send.getSignedPdf, {
      completedDocumentId,
    });
  }

  getCertificate(ctx: ZsignActionCtx, documentId: string) {
    return ctx.runAction(this.component.send.getCertificate, { documentId });
  }

  // Verify a delivery and return the normalized event, ready to pass to
  // `ctx.runMutation(components.zsign.lib.applyWebhookEvent, event)`.
  // Accepts [current, previous] secrets for rotation windows.
  async verifyWebhook(request: Request, secrets: (string | undefined)[]) {
    return verifyWebhookRequest(request, secrets);
  }

  // Drain persisted completion callbacks. `handler` must be an app mutation
  // (e.g. internal.myEnvelopeCompleted) — a component cannot invoke app code,
  // so draining always runs through the app's ctx. Handlers that need to run
  // fetches/actions should schedule one from inside their mutation. Each
  // callback is deduped by (envelope, kind); failures persist and are returned
  // by the next drain.
  async onCompleted(
    ctx: ZsignActionCtx,
    handler: FunctionReference<
      "mutation",
      "public" | "internal",
      OnCompletedArgs,
      unknown
    >,
    opts?: { limit?: number },
  ): Promise<{ processed: number; failed: number }> {
    const pending = await ctx.runQuery(
      this.component.lib.pendingCallbacks,
      { limit: opts?.limit },
    );
    let processed = 0;
    let failed = 0;
    for (const cb of pending) {
      const detail = await ctx.runQuery(
        this.component.lib.callbackEnvelope,
        { callbackId: cb._id },
      );
      if (!detail) {
        await ctx.runMutation(this.component.lib.finishCallback, {
          callbackId: cb._id,
          ok: false,
          error: "envelope missing",
        });
        continue;
      }
      try {
        await ctx.runMutation(handler, {
          callbackId: detail.callbackId,
          operationId: detail.operationId,
          sessionId: detail.sessionId,
          documentId: detail.documentId,
          completedDocumentId: detail.completedDocumentId,
          metadata: detail.metadata,
        });
        await ctx.runMutation(this.component.lib.finishCallback, {
          callbackId: cb._id,
          ok: true,
        });
        processed++;
      } catch (e) {
        await ctx.runMutation(this.component.lib.finishCallback, {
          callbackId: cb._id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        failed++;
      }
    }
    return { processed, failed };
  }
}

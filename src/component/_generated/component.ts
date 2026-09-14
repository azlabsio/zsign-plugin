/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      applyWebhookEvent: FunctionReference<
        "mutation",
        "internal",
        {
          completedAt?: string;
          documentId?: string;
          eventId: string;
          metadata?: any;
          sessionId?: string;
          signerEmail?: string;
          type: string;
        },
        any,
        Name
      >;
      callbackEnvelope: FunctionReference<
        "query",
        "internal",
        { callbackId: string },
        any,
        Name
      >;
      finishCallback: FunctionReference<
        "mutation",
        "internal",
        { callbackId: string; error?: string; ok: boolean },
        any,
        Name
      >;
      getByOperation: FunctionReference<
        "query",
        "internal",
        { operationId: string },
        any,
        Name
      >;
      getBySession: FunctionReference<
        "query",
        "internal",
        { sessionId: string },
        any,
        Name
      >;
      getOperation: FunctionReference<
        "query",
        "internal",
        { operationId: string },
        any,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { activeOnly?: boolean },
        any,
        Name
      >;
      pendingCallbacks: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        any,
        Name
      >;
    };
    reconcile: {
      refresh: FunctionReference<
        "action",
        "internal",
        { operationId: string },
        any,
        Name
      >;
    };
    send: {
      getCertificate: FunctionReference<
        "action",
        "internal",
        { documentId: string },
        any,
        Name
      >;
      getSignedPdf: FunctionReference<
        "action",
        "internal",
        { completedDocumentId: string },
        any,
        Name
      >;
      send: FunctionReference<
        "action",
        "internal",
        {
          file: ArrayBuffer;
          filename: string;
          metadata?: Record<string, string>;
          name?: string;
          operationId: string;
          recipients: Array<{ email: string; name: string; role?: string }>;
          sendCompletionEmail?: boolean;
          sendInvite?: boolean;
          sequential?: boolean;
        },
        any,
        Name
      >;
    };
  };

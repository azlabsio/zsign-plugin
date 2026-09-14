import { httpRouter } from "convex/server";
import { httpAction, env } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import { verifyWebhookRequest } from "./webhook.js";

const http = httpRouter();

http.route({
  path: "/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const verified = await verifyWebhookRequest(request, [
      env.ZSIGN_WEBHOOK_SECRET,
      env.ZSIGN_WEBHOOK_SECRET_PREVIOUS,
    ]);
    if (!verified.ok) {
      return new Response(verified.error, { status: verified.status });
    }
    try {
      const result = await ctx.runMutation(
        api.lib.applyWebhookEvent,
        verified.event,
      );
      // HTTP 200 is returned only after the durable receipt mutation commits.
      return Response.json(result);
    } catch {
      // zSign retries 5xx deliveries. Never acknowledge a receipt that wasn't
      // durably inserted.
      return new Response("webhook receipt unavailable", { status: 503 });
    }
  }),
});

export default http;

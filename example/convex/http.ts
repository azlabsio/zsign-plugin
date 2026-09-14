import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { verifyWebhookRequest } from "@zsign/convex";

const http = httpRouter();

http.route({
  path: "/zsign/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Accept both the current and previous secret so a rotation window keeps
    // in-flight deliveries valid.
    const verified = await verifyWebhookRequest(request, [
      process.env.ZSIGN_WEBHOOK_SECRET,
      process.env.ZSIGN_WEBHOOK_SECRET_PREVIOUS,
    ]);
    if (!verified.ok) {
      return new Response(verified.error, { status: verified.status });
    }
    try {
      const result = await ctx.runMutation(
        components.zsign.lib.applyWebhookEvent,
        verified.event,
      );
      // 200 only after the durable receipt mutation commits.
      return Response.json(result);
    } catch {
      return new Response("webhook receipt unavailable", { status: 503 });
    }
  }),
});

export default http;

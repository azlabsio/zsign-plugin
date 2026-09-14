import { defineApp } from "convex/server";
import { v } from "convex/values";
import zsign from "@zsign/convex/convex.config.js";

const app = defineApp({
  env: {
    ZSIGN_API_KEY: v.string(),
    ZSIGN_API_BASE_URL: v.optional(v.string()),
    ZSIGN_WEBHOOK_SECRET: v.optional(v.string()),
    ZSIGN_WEBHOOK_SECRET_PREVIOUS: v.optional(v.string()),
  },
});

app.use(zsign, {
  env: {
    ZSIGN_API_KEY: app.env.ZSIGN_API_KEY,
    ZSIGN_API_BASE_URL: app.env.ZSIGN_API_BASE_URL,
    ZSIGN_WEBHOOK_SECRET: app.env.ZSIGN_WEBHOOK_SECRET,
    ZSIGN_WEBHOOK_SECRET_PREVIOUS: app.env.ZSIGN_WEBHOOK_SECRET_PREVIOUS,
  },
});

export default app;

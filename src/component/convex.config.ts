import { defineComponent } from "convex/server";
import { v } from "convex/values";

const component = defineComponent("zsign", {
  env: {
      ZSIGN_API_KEY: v.string(),
      ZSIGN_API_BASE_URL: v.optional(v.string()),
      ZSIGN_WEBHOOK_SECRET: v.optional(v.string()),
      ZSIGN_WEBHOOK_SECRET_PREVIOUS: v.optional(v.string()),
  },
});

export default component;

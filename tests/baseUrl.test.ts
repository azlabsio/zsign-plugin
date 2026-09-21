import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../src/component/schema.js";
import { api, internal } from "../src/component/_generated/api.js";

const modules = import.meta.glob("../src/component/**/*.ts");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Every call site that talks to zSign, driven through the real action.
const callSites = {
  send: async (t: ReturnType<typeof convexTest>) => {
    await t
      .action(api.send.send, {
        file: new TextEncoder().encode("%PDF-1.4\n").buffer,
        filename: "x.pdf",
        recipients: [{ name: "A", email: "a@example.com" }],
        operationId: "op-url",
      })
      .catch(() => {});
  },
  refresh: async (t: ReturnType<typeof convexTest>) => {
    await t.mutation(internal.lib.allocateOperation, { operationId: "op-url" });
    const envelopeId = await t.mutation(internal.lib.insertEnvelope, {
      operationId: "op-url",
      documentId: "doc-1",
      sessionId: "sess-url",
      name: "x.pdf",
      recipients: [{ email: "a@example.com", name: "A", status: "sent" }],
    });
    // Attempt 5 is the last slot, so a failure doesn't schedule a retry.
    await t.action(internal.reconcile.refreshEnvelope, { envelopeId, attempt: 5 });
  },
  getSignedPdf: async (t: ReturnType<typeof convexTest>) => {
    await t.action(api.send.getSignedPdf, { completedDocumentId: "cdoc-1" }).catch(() => {});
  },
  getCertificate: async (t: ReturnType<typeof convexTest>) => {
    await t.action(api.send.getCertificate, { documentId: "doc-1" }).catch(() => {});
  },
};

async function requestedOrigin(
  baseUrl: string | undefined,
  run: (t: ReturnType<typeof convexTest>) => Promise<void>,
): Promise<string> {
  vi.stubEnv("ZSIGN_API_KEY", "zs_test_key");
  vi.stubEnv("ZSIGN_API_BASE_URL", baseUrl);
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response("{}", { status: 500 });
    }),
  );
  await run(convexTest(schema, modules));
  expect(urls).toHaveLength(1);
  // Everything before the API path, so a doubled /api/api/v1 shows up here.
  return urls[0].slice(0, urls[0].lastIndexOf("/api/v1/"));
}

describe("ZSIGN_API_BASE_URL resolution", () => {
  // The zSign API reference page gave the base URL as https://zsign.io/api;
  // the component appends /api/v1/... itself, so a base that already carries
  // /api or /api/v1 must not produce /api/api/v1/.
  const cases: [string | undefined, string][] = [
    [undefined, "https://zsign.io"],
    ["https://zsign.io/api", "https://zsign.io"],
    ["https://zsign.io/api/v1/", "https://zsign.io"],
    ["http://172.17.0.1:7101", "http://172.17.0.1:7101"],
  ];
  for (const [site, run] of Object.entries(callSites)) {
    for (const [baseUrl, origin] of cases) {
      test(`${site}: ${baseUrl ?? "unset"} → ${origin}`, async () => {
        expect(await requestedOrigin(baseUrl, run)).toBe(origin);
      });
    }
  }
});

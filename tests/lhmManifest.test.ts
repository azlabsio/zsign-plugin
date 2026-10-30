import { describe, expect, test } from "vitest";
import manifest from "../lhm.plugin.json";

// LobeHub PluginCategory values (@lobehub/market-sdk).
const categories = [
  "business",
  "developer",
  "gaming-entertainment",
  "health-wellness",
  "lifestyle",
  "media-generate",
  "news",
  "productivity",
  "science-education",
  "social",
  "stocks-finance",
  "tools",
  "travel-transport",
  "weather",
  "web-search",
];

describe("lhm.plugin.json", () => {
  test("has the fields lhm plugin publish requires", () => {
    for (const field of ["identifier", "name", "version", "description"] as const) {
      expect(typeof manifest[field]).toBe("string");
      expect(manifest[field].trim()).not.toBe("");
    }
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("describes the remote zsign MCP server", () => {
    expect(manifest.description).toBe(
      "Send documents for e-signature from AI assistants, track signers, and download sealed, signed PDFs.",
    );
    expect(manifest.description).toHaveLength(99);
    expect(manifest.cloudEndpoint).toBe("https://zsign.io/mcp");
    for (const url of [manifest.homepage, manifest.icon, manifest.authorUrl]) {
      expect(new URL(url).protocol).toBe("https:");
    }
    expect(categories).toContain(manifest.category);
  });

  test("lists each MCP tool once with an input schema", () => {
    expect(manifest.tools.length).toBeGreaterThan(0);
    const names = manifest.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of manifest.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("follows the public brand rules", () => {
    expect(JSON.stringify(manifest)).not.toMatch(/mihalyi/i);
  });
});

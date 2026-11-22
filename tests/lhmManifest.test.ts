import { describe, expect, test } from "vitest";
import cursorManifest from "../.cursor-plugin/plugin.json";
import manifest from "../lhm.plugin.json";
import agentManifest from "../plugin.json";

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

  test("shares a version with the Agent Plugins and Cursor manifests", () => {
    expect(agentManifest.version).toBe(manifest.version);
    expect(cursorManifest.version).toBe(manifest.version);
  });

  test("describes the remote zsign MCP server", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(100);
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

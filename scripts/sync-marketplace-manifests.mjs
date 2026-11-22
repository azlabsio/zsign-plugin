import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const serverName = "io.zsign/zsign";
const registryUrl = new URL("https://registry.modelcontextprotocol.io/v0/servers");
registryUrl.search = new URLSearchParams({ search: serverName, version: "latest" });
const openMcpUrl = "https://zsign.io/mcp/open";

async function request(url, options) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with HTTP ${response.status}`);
  }
  return response;
}

async function getRegistryServer() {
  const response = await request(registryUrl);
  const { servers } = await response.json();
  const latest = servers.filter(({ server, _meta }) =>
    server.name === serverName && _meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true,
  );
  if (latest.length !== 1 || latest[0]._meta["io.modelcontextprotocol.registry/official"].status !== "active") {
    throw new Error("Expected one active, latest official registry entry for io.zsign/zsign");
  }

  const { version, description } = latest[0].server;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) ||
      typeof description !== "string" || !description.trim() || description.length > 100) {
    throw new Error("The latest official registry entry has an invalid version or description");
  }
  return { version, description };
}

async function getLiveTools() {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  let nextId = 1;
  async function send(method, params, notification = false) {
    const id = notification ? undefined : nextId++;
    const response = await request(openMcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (notification) return;

    // /mcp/open serves JSON responses over Streamable HTTP.
    const reply = await response.json();
    if (reply.jsonrpc !== "2.0" || reply.id !== id || reply.error || !reply.result) {
      throw new Error(`Invalid MCP response to ${method}`);
    }
    return { result: reply.result, sessionId: response.headers.get("Mcp-Session-Id") };
  }

  const { result: initialization, sessionId } = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "zsign-plugin-marketplace-sync", version: "1.0.0" },
  });
  if (!initialization.capabilities?.tools || !initialization.protocolVersion) {
    throw new Error("The MCP server did not negotiate a protocol version with tool support");
  }
  headers["MCP-Protocol-Version"] = initialization.protocolVersion;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  await send("notifications/initialized", undefined, true);

  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const { result } = await send("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(result.tools) || (result.nextCursor !== undefined &&
        (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)))) {
      throw new Error("Invalid MCP tools/list page");
    }
    tools.push(...result.tools);
    cursor = result.nextCursor;
    cursors.add(cursor);
  } while (cursor);

  if (!tools.length ||
      tools.some((tool) => typeof tool?.name !== "string" || !tool.name.trim() || tool.inputSchema?.type !== "object") ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("The live MCP tool catalog is empty or invalid");
  }
  return tools;
}

const [{ version, description }, tools] = await Promise.all([getRegistryServer(), getLiveTools()]);
const updates = {
  "lhm.plugin.json": { version, description, tools },
  "plugin.json": { version },
  ".cursor-plugin/plugin.json": { version },
};
for (const [file, fields] of Object.entries(updates)) {
  const path = new URL(`../${file}`, import.meta.url);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const updated = { ...manifest, ...fields };
  if (fields.tools) {
    // Keep the CLI's property order for any tool whose definition hasn't changed.
    const existingTools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    updated.tools = tools.map((tool) => {
      const existing = existingTools.get(tool.name);
      return isDeepStrictEqual(existing, tool) ? existing : tool;
    });
  }
  if (!isDeepStrictEqual(manifest, updated)) {
    await writeFile(path, JSON.stringify(updated, null, 2) + "\n");
    console.log(`Updated ${file}`);
  }
}
console.log(`Official registry version ${version} with ${tools.length} live MCP tools`);

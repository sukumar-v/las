import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "@las/store";
import { LasContext } from "../src/context.js";
import { createMcpServer } from "../src/mcp/server.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An MCP client connected to a fresh in-memory LAS server. */
export async function connect(opts: { widgets?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "las-test-"));
  const ctx = new LasContext({ dataDir, dbPath: ":memory:", mediaDir: join(dataDir, "media"), modelsDir: join(dataDir, "models"), fontsDir: join(dataDir, "fonts") }, new Store(":memory:"));
  const server = createMcpServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: opts.widgets ? ({ extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } as any) : {} });
  await server.connect(serverT);
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { text: r.content?.map((c: any) => c.text).join("\n") as string, data: r.structuredContent as any, isError: !!r.isError, meta: r._meta };
  };
  return { ctx, server, client, call, close: async () => { await client.close(); await server.close(); ctx.close(); } };
}

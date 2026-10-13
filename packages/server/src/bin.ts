#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LasContext } from "./context.js";
import { createMcpServer } from "./mcp/server.js";
import { startHttp } from "./http/app.js";
import { installLoop } from "./loop.js";

function findStudioDist(): string | undefined {
  if (process.env.LAS_STUDIO_DIST) return process.env.LAS_STUDIO_DIST;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "../../studio/dist"), join(here, "../studio-dist"), join(here, "studio-dist"), join(here, "../../../studio/dist")]) if (existsSync(join(c, "index.html"))) return c;
  return undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const noStudio = argv.includes("--no-studio");
  const ctx = new LasContext({ studioDist: findStudioDist() });
  const sink = installLoop(ctx);
  if (!noStudio) {
    try {
      await startHttp(ctx, sink);
      process.stderr.write(`[las] studio at ${ctx.config.studioUrl}\n`);
    } catch (e) {
      process.stderr.write(`[las] studio not started: ${(e as Error).message}\n`);
    }
  }
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[las] MCP server ready (stdio)\n`);
}

if (process.argv[1] && /las-server|bin\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`[las] fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}

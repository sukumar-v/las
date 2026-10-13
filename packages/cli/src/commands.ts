import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The thin subcommands. Heavy packages (@las/server, @las/schema) are imported only when a command needs them. */

export interface Out {
  out(line: string): void;
  err(line: string): void;
}

/** Finds the repo root (a folder with pnpm-workspace.yaml) above `from`. */
export function findRepoRoot(from: string): string | undefined {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, "pnpm-workspace.yaml")) && existsSync(join(d, "packages", "cli"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** Runs the MCP server on stdio. The server's bin.ts also auto-starts when argv[1] looks like a bin file, so hide that. */
export async function serve(argv: string[]): Promise<void> {
  let mod: any = await import("@las/server");
  if (typeof mod.main !== "function") {
    // @las/server exports no `main`; load its bin module sitting next to the package entry
    const entry = createRequire(import.meta.url).resolve("@las/server");
    const found = ["bin.js", "bin.ts"].map((f) => join(dirname(entry), f)).find(existsSync);
    if (!found) throw new Error("@las/server has no bin module to run");
    const argv1 = process.argv[1];
    process.argv[1] = "las-agents";
    try {
      mod = await import(pathToFileURL(found).href);
    } finally {
      process.argv[1] = argv1;
    }
  }
  await mod.main(argv);
}

export async function doctor(o: Out, json: boolean): Promise<number> {
  const { LasContext } = await import("@las/server");
  const ctx = new LasContext();
  try {
    const caps = await ctx.capabilities(true);
    if (json) {
      o.out(JSON.stringify(caps, null, 2));
      return 0;
    }
    o.out(`LAS ${caps.version} on ${caps.platform.os}/${caps.platform.arch}, node ${caps.platform.node}`);
    o.out("\nEngines");
    for (const e of caps.engines) o.out(`  ${e.available ? "ready      " : "unavailable"} ${e.id}${e.available ? ` (${e.backend})` : e.reason ? `: ${e.reason}` : ""}`);
    o.out("\nCode runners");
    o.out(`  browser:   ${caps.runners.browser.join(", ") || "none"}`);
    o.out(`  local:     ${caps.runners.local.map((l) => `${l.language} (${l.tool}${l.version ? " " + l.version : ""})`).join(", ") || "none"}`);
    o.out(`  container: ${caps.runners.container.available ? (caps.runners.container.runtime ?? "yes") : "none"}`);
    o.out("\nDevices");
    o.out(`  ${Object.entries(caps.devices).map(([k, v]) => `${k}: ${v ? "yes" : "no"}`).join("  ")}`);
    if (caps.external.length) o.out(`\nExternal tools\n${caps.external.map((x) => `  ${x.name} (${x.protocol}) ${x.path}`).join("\n")}`);
    o.out(`\nStudio: ${caps.studioUrl}`);
    return 0;
  } finally {
    ctx.close();
  }
}

export async function studio(o: Out): Promise<number> {
  const { LasContext, startHttp } = await import("@las/server");
  const root = findRepoRoot(dirname(new URL(import.meta.url).pathname));
  const dist = process.env.LAS_STUDIO_DIST ?? (root && existsSync(join(root, "packages", "studio", "dist", "index.html")) ? join(root, "packages", "studio", "dist") : undefined);
  const ctx = new LasContext({ studioDist: dist });
  const http = await startHttp(ctx);
  o.out(`Studio: ${http.url}`);
  if (!dist) o.err("The studio isn't built yet, so only the API is served (pnpm --filter @las/studio build).");
  o.out("Press Ctrl+C to stop.");
  await new Promise<void>((done) => {
    for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => done());
  });
  await http.close();
  ctx.close();
  return 0;
}

export async function checkin(o: Out): Promise<number> {
  const { LasContext, ...rest } = (await import("@las/server")) as Record<string, any>;
  if (typeof rest.runCheckins !== "function") {
    o.out("The learning loop isn't installed yet: @las/server has no runCheckins. Nothing to check in on.");
    return 0;
  }
  const ctx = new LasContext();
  try {
    const result = await rest.runCheckins(ctx);
    o.out(typeof result === "string" ? result : JSON.stringify(result ?? "done", null, 2));
    return 0;
  } finally {
    ctx.close();
  }
}

export function enginesTest(o: Out, extra: string[], from: string): number {
  const root = findRepoRoot(from);
  if (!root) {
    o.err("`engines test` runs the repository's test projects, so it only works from a checkout of the LAS repo.");
    return 2;
  }
  const r = spawnSync("pnpm", ["vitest", "run", "--project", "engines", "--project", "runners", ...extra], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) {
    o.err(`Could not run pnpm: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

export async function modelValidate(o: Out, file: string | undefined): Promise<number> {
  if (!file) {
    o.err("Usage: las-agents model validate <file.json>");
    return 2;
  }
  const ext = extname(file).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    o.err("YAML isn't supported here: this command reads JSON only. Convert the file to JSON and try again.");
    return 2;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    o.err(`Can't read ${file} as JSON: ${(e as Error).message}`);
    return 2;
  }
  const { validateSkillModel } = await import("@las/schema");
  const v = validateSkillModel(data);
  for (const w of v.warnings) o.out(`warning  ${w.path || "(model)"}  [${w.check}] ${w.message}`);
  for (const e of v.errors) o.err(`error    ${e.path || "(model)"}  [${e.check}] ${e.message}`);
  if (v.ok) {
    const s = v.summary;
    o.out(`Valid skill model${s ? `: ${s.nodes} nodes, ${s.lessons} lessons, ${s.drills} drills, ${s.specs} specs` : ""}.`);
    return 0;
  }
  o.err(`${v.errors.length} error(s).`);
  return 1;
}

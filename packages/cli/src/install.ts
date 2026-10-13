import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerEntry } from "./configs.js";

/** How this CLI was installed, which decides what the MCP server entry looks like and where the skill is copied from. */
export interface InstallInfo {
  mode: "package" | "repo";
  entry: ServerEntry;
  /** the skill folder to copy, if found */
  skillSource?: string;
  /** repo root when running from a checkout */
  repoRoot?: string;
}

export const PACKAGE_NAME = "las-agents";

/** `npx -y las-agents serve`; Windows needs cmd /c to launch npx from an MCP config. */
export function packageEntry(platform: NodeJS.Platform): ServerEntry {
  const args = ["-y", PACKAGE_NAME, "serve"];
  return platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
}

/** The tsx loader to run TypeScript sources with: an absolute file URL when it can be resolved from the server package. */
function tsxLoader(serverDir: string): string {
  try {
    return pathToFileURL(createRequire(join(serverDir, "package.json")).resolve("tsx")).href;
  } catch {
    return "tsx";
  }
}

/**
 * @param here the directory of this file (packages/cli/src or packages/cli/dist, or the installed package's dist)
 */
export function locateInstall(here: string, platform: NodeJS.Platform = process.platform): InstallInfo {
  const repoRoot = resolve(here, "..", "..", "..");
  const serverBin = join(repoRoot, "packages", "server", "src", "bin.ts");
  const bundledSkill = resolve(here, "..", "skill");
  const repoSkill = join(repoRoot, "skill");
  if (existsSync(serverBin)) {
    return {
      mode: "repo",
      repoRoot,
      entry: { command: process.execPath, args: ["--import", tsxLoader(dirname(dirname(serverBin))), serverBin] },
      skillSource: existsSync(join(repoSkill, "SKILL.md")) ? repoSkill : undefined
    };
  }
  return { mode: "package", entry: packageEntry(platform), skillSource: existsSync(join(bundledSkill, "SKILL.md")) ? bundledSkill : undefined };
}

export function cliVersion(here: string): string {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

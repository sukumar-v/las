import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { unifiedDiff } from "./diff.js";

export interface SkillFilePlan {
  rel: string;
  from: string;
  to: string;
  state: "new" | "changed" | "same";
  /** unified diff for a changed text file */
  diff?: string;
  lines?: number;
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(relative(base, p));
  }
  return out.sort();
}

const isText = (b: Buffer) => !b.includes(0);

/** Compares every file of the skill folder with what is installed at `dest`. */
export function planSkill(source: string, dest: string): SkillFilePlan[] {
  return walk(source).map((rel) => {
    const from = join(source, rel);
    const to = join(dest, rel);
    const next = readFileSync(from);
    if (!existsSync(to)) return { rel, from, to, state: "new" as const, lines: isText(next) ? next.toString("utf8").split("\n").length : undefined };
    const cur = readFileSync(to);
    if (cur.equals(next)) return { rel, from, to, state: "same" as const };
    return { rel, from, to, state: "changed" as const, diff: isText(cur) && isText(next) ? unifiedDiff(cur.toString("utf8"), next.toString("utf8"), to) : undefined };
  });
}

export const skillChanged = (plan: SkillFilePlan[]) => plan.some((f) => f.state !== "same");

/** Copies the new and changed files. Files already installed that the skill no longer has are left alone. */
export function applySkill(plan: SkillFilePlan[], dest: string, backupDir: string): { backup?: string; written: number } {
  let backup: string | undefined;
  if (existsSync(dest) && plan.some((f) => f.state === "changed")) {
    mkdirSync(dirname(backupDir), { recursive: true });
    cpSync(dest, backupDir, { recursive: true });
    backup = backupDir;
  }
  let written = 0;
  for (const f of plan) {
    if (f.state === "same") continue;
    mkdirSync(dirname(f.to), { recursive: true });
    writeFileSync(f.to, readFileSync(f.from));
    written++;
  }
  return { backup, written };
}

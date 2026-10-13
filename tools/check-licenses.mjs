#!/usr/bin/env node
/**
 * Open-source policy check (docs/DESIGN.md section 11, CLAUDE.md "Open source only").
 * Lists every installed dependency's license via `pnpm licenses list --json`, falling back to reading each
 * package.json under node_modules/.pnpm, and fails on anything outside tools/licenses-allowlist.json.
 *   node tools/check-licenses.mjs            all installed dependencies
 *   node tools/check-licenses.mjs --prod     production dependencies only
 * Also requires every workspace package to declare "license": "MIT".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackages, flattenPnpmLicenses, licenseOfManifest } from "./licenses-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prodOnly = process.argv.includes("--prod");
const policy = JSON.parse(readFileSync(join(root, "tools/licenses-allowlist.json"), "utf8"));

function fromPnpm() {
  const args = ["licenses", "list", "--json", ...(prodOnly ? ["--prod"] : [])];
  const out = execFileSync("pnpm", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 27, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  return flattenPnpmLicenses(JSON.parse(out));
}

/** Fallback: read every package.json in the pnpm virtual store (all deps, since prod/dev is not recorded there). */
function fromNodeModules() {
  const store = join(root, "node_modules/.pnpm");
  const out = [];
  if (!existsSync(store)) return out;
  const scan = (dir, scope) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("@") && !scope) {
        scan(join(dir, name), name);
        continue;
      }
      const manifest = join(dir, name, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        out.push({ name: pkg.name ?? (scope ? `${scope}/${name}` : name), version: pkg.version ?? "?", license: licenseOfManifest(pkg) });
      } catch {
        /* unreadable manifest: reported as undeclared below */
      }
    }
  };
  for (const entry of readdirSync(store)) {
    const nm = join(store, entry, "node_modules");
    if (existsSync(nm)) scan(nm, undefined);
  }
  return out;
}

let packages;
let source = "pnpm licenses list";
try {
  packages = fromPnpm();
  if (!packages.length) throw new Error("pnpm reported no packages");
} catch (e) {
  source = "node_modules/.pnpm package.json files";
  console.warn(`pnpm licenses unavailable (${String(e.message).split("\n")[0]}); reading package.json files instead${prodOnly ? " (--prod ignored)" : ""}`);
  packages = fromNodeModules();
}

const { offenders, warnings, excepted } = checkPackages(packages, policy);

// Workspace packages must declare MIT themselves.
const workspaceProblems = [];
for (const dir of ["packages", "evals"]) {
  const base = join(root, dir);
  const manifests = dir === "evals" ? [join(base, "package.json")] : existsSync(base) ? readdirSync(base).map((d) => join(base, d, "package.json")) : [];
  for (const m of manifests) {
    if (!existsSync(m)) continue;
    const pkg = JSON.parse(readFileSync(m, "utf8"));
    if (pkg.license !== "MIT") workspaceProblems.push(`${m.slice(root.length + 1)}: license is ${JSON.stringify(pkg.license)}, expected "MIT"`);
  }
}

console.log(`License check: ${new Set(packages.map((p) => `${p.name}@${p.version}`)).size} packages from ${source}${prodOnly ? " (production only)" : ""}`);
for (const w of warnings) console.log(`warn  ${w.name}@${w.version}: ${w.license} (allowed with care: use unmodified or publish changes)`);
for (const x of excepted) console.log(`note  ${x.name}@${x.version}: ${x.license} accepted by exception: ${x.reason}`);
for (const o of offenders) console.error(`FAIL  ${o.name}@${o.version}: ${o.license ?? "no license declared"} (not allowed: ${o.bad.join(", ")})`);
for (const p of workspaceProblems) console.error(`FAIL  ${p}`);

if (offenders.length || workspaceProblems.length) {
  console.error(`\n${offenders.length + workspaceProblems.length} problem(s). See docs/DESIGN.md section 11; do not silence a real violation.`);
  process.exit(1);
}
console.log("OK");

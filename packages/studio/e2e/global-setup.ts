import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Fixture evidence comes from the engines' own synthetic generators, made once before the suite. */
export default function globalSetup(): void {
  const dir = join(import.meta.dirname, "..");
  execFileSync(process.execPath, ["--import", "tsx", join(dir, "e2e/make-fixtures.ts")], { cwd: dir, stdio: "inherit" });
}

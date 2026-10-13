/** Writes the journeys' fixture evidence as JSON (run by global-setup with tsx; the engines make it). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE } from "./fixtures/evidence.js";

const out = join(import.meta.dirname, ".fixtures");
mkdirSync(out, { recursive: true });
const all = Object.fromEntries(Object.entries(EVIDENCE).map(([k, f]) => [k, f()]));
writeFileSync(join(out, "evidence.json"), JSON.stringify(all));
console.log(`fixture evidence: ${Object.keys(all).join(", ")}`);

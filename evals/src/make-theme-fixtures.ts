import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTheme } from "@las/schema";
import { draftTheme } from "@las/server";
import { THEME_DESCRIPTIONS } from "./theme-descriptions.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../fixtures/themes");
mkdirSync(out, { recursive: true });
for (const d of THEME_DESCRIPTIONS) {
  const draft = draftTheme({ description: d.description, name: d.name });
  const v = validateTheme(draft.theme);
  const theme = v.ok ? draft.theme : v.fixedOk && v.fixed ? v.fixed : null;
  if (!theme) throw new Error(`${d.id} never passed validation: ${v.errors.map((e) => e.message).join("; ")}`);
  const final = { ...theme, id: d.id, source: { kind: "description" as const, note: d.description } };
  writeFileSync(join(out, `${d.id}.json`), JSON.stringify(final, null, 2) + "\n");
  console.log(`${d.id}: ${draft.notes.join("; ")}${v.ok ? "" : ` (+${v.fixes.length} fixes)`}`);
}

#!/usr/bin/env node
/**
 * Fails the build on any hard-coded color, font, radius or shadow in component stylesheets.
 * Component CSS may only use theme tokens (var(--las-*)), structural values and variant selectors.
 * The token-to-CSS generator is the only file here allowed to carry raw values (the base theme lives in @las/schema).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["packages/ui/src", "packages/studio/src"];
const ALLOW = new Set(["packages/ui/src/theme/css.ts"]);
const TOKEN = String.raw`var\(--las-`;
const COLOR_OK = String.raw`(?:${TOKEN}|transparent|currentColor|inherit|none|0\b|color-mix\(|(?:repeating-)?(?:linear|radial)-gradient\(|url\(#)`;
const CHECKS = [
  [/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/, "hex color"],
  [/\b(?:rgba?|hsla?|oklch|oklab)\s*\(/, "color function"],
  [new RegExp(String.raw`(?:^|[^-\w])(?:color|background(?:-color)?|border-color|fill|stroke|outline-color)\s*:(?!\s*${COLOR_OK})`), "literal color role"],
  [new RegExp(String.raw`font-family\s*:(?!\s*${TOKEN})`), "literal font-family"],
  [new RegExp(String.raw`border-radius\s*:(?!\s*(?:${TOKEN}|0\b|50%|inherit))`), "literal border-radius"],
  [new RegExp(String.raw`box-shadow\s*:(?!\s*(?:${TOKEN}|none|(?:inset\s+)?0 0 0 ${TOKEN}))`), "literal box-shadow"],
  [/font-size\s*:\s*\d/, "literal font-size"],
  [new RegExp(String.raw`font-weight\s*:(?!\s*(?:${TOKEN}|inherit))`), "literal font-weight"],
  [/transition(?:-duration)?\s*:\s*[^;]*\d+m?s/, "literal motion duration"],
  [/animation(?:-duration)?\s*:\s*[^;]*\d+m?s/, "literal motion duration"]
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(css|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

let failures = 0;
for (const root of ROOTS) {
  let files = [];
  try { files = walk(root); } catch { continue; }
  for (const file of files) {
    const rel = relative(process.cwd(), file).replace(/\\/g, "/");
    if (ALLOW.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    // Only stylesheet text is checked here: .css files whole, and css`...`/style="" strings in TS are covered by eslint.
    if (!file.endsWith(".css")) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/las-style-allow/.test(line)) return;
      if (/prefers-reduced-motion/.test(line)) return; // reduced motion always wins: zero durations are structural
      for (const [re, why] of CHECKS) {
        if (re.test(line)) {
          failures++;
          console.error(`${rel}:${i + 1}: ${why}: ${line.trim()}`);
        }
      }
    });
  }
}
if (failures) {
  console.error(`\n${failures} hard-coded style value(s). Every color, font, radius, shadow and motion value must come from the theme.`);
  process.exit(1);
}
console.log("check-style: no hard-coded style values in component code");

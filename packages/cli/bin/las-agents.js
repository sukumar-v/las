#!/usr/bin/env node
// Runs the built CLI when it exists (published package), else the TypeScript source through tsx (repository checkout).
const missingBuild = (e) => e?.code === "ERR_MODULE_NOT_FOUND" && /dist[\\/]bin\.js/.test(String(e.url ?? e.message));
import("../dist/bin.js").catch((e) => {
  if (!missingBuild(e)) throw e;
  return import("tsx/esm/api").then(({ tsImport }) => tsImport("../src/bin.ts", import.meta.url));
});

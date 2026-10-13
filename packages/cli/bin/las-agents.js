#!/usr/bin/env node
// Runs the built CLI when it exists (published package), else the TypeScript source through tsx (repository checkout).
import("../dist/bin.js").catch((e) => {
  if (e?.code !== "ERR_MODULE_NOT_FOUND" || !String(e.message).includes("dist/bin.js")) throw e;
  return import("tsx/esm/api").then(({ tsImport }) => tsImport("../src/bin.ts", import.meta.url));
});

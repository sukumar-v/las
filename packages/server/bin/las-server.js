#!/usr/bin/env node
import("../dist/bin.js").catch(() => import("tsx/esm/api").then(({ tsImport }) => tsImport("../src/bin.ts", import.meta.url)));

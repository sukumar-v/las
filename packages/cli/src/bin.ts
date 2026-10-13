#!/usr/bin/env node
import { run } from "./index.js";

run(process.argv.slice(2)).then((code) => {
  // `serve` returns -1: leave the process running on stdio
  if (code >= 0) process.exit(code);
});

/** Picks the first runner in the spec's preference order that can run it here. Browser-safe. */
import type { TestSpec } from "@las/schema";
import { LANGUAGE_TABLE } from "./languages.js";
import type { RunnerCaps, RunnerChoice } from "./types.js";

export function selectRunner(spec: TestSpec, caps: RunnerCaps): RunnerChoice {
  const def = LANGUAGE_TABLE[spec.language];
  const native = spec.tests.some((t) => "native" in t);
  const stdin = spec.tests.some((t) => "stdin" in t);
  const why: string[] = [];
  for (const runner of spec.runner) {
    if (runner === "browser") {
      if (!def.browser) why.push(`${def.label} has no browser runtime`);
      else if (!caps.browser.includes(spec.language)) why.push(`the ${def.label} browser runtime is not loaded`);
      else if (native) why.push("native test files need a local toolchain or a container");
      else if (stdin && !def.browserProgram) why.push(`input/output tests in ${def.label} need a local toolchain or a container`);
      // the browser runtime is sandboxed by the page, so it needs no separate consent
      else return { runner, needsConsent: false, reason: `runs in the browser with the ${def.label} runtime` };
    } else if (runner === "local") {
      const tool = caps.local.find((l) => l.language === spec.language);
      if (!tool) why.push(`no ${def.label} toolchain is installed on this computer`);
      else return { runner, needsConsent: !tool.consented, reason: `runs on this computer with ${tool.tool}, without network access` };
    } else {
      if (!caps.container.available) why.push("no container runtime (Podman or Docker Engine) is available");
      else if (!def.image) why.push(`no container image is known for ${def.label}`);
      else return { runner, needsConsent: !caps.container.consented, reason: `runs in a container (${def.image}) with no network and a read-only copy of the files` };
    }
  }
  return { runner: null, reason: why.join("; ") || "no runner is allowed by the spec" };
}

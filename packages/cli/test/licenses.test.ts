import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPackages, evaluateLicense, flattenPnpmLicenses, licenseOfManifest, parseExpression, type Policy } from "../../../tools/licenses-lib.mjs";

const policy = JSON.parse(readFileSync(new URL("../../../tools/licenses-allowlist.json", import.meta.url), "utf8")) as Policy;
const status = (e: string | undefined) => evaluateLicense(e, policy).status;

describe("license expressions", () => {
  it("accepts the allowed single licenses", () => {
    for (const l of ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "Unlicense", "CC0-1.0", "Python-2.0", "BlueOak-1.0.0"]) expect(status(l)).toBe("ok");
    expect(status("mit")).toBe("ok");
  });
  it("rejects licenses outside the allowlist", () => {
    for (const l of ["GPL-3.0", "AGPL-3.0-only", "CC-BY-NC-4.0", "BUSL-1.1", "FSL-1.1-MIT", "SEE LICENSE IN LICENSE.md", "UNLICENSED"]) expect(status(l)).toBe("fail");
  });
  it("flags missing licenses", () => {
    expect(status(undefined)).toBe("fail");
    expect(status("")).toBe("fail");
  });
  it("warns on MPL-2.0 (allowed with care)", () => {
    const r = evaluateLicense("MPL-2.0", policy);
    expect(r.status).toBe("warn");
    expect(r.care).toEqual(["MPL-2.0"]);
  });
  it("OR: any allowed alternative is enough", () => {
    expect(status("(MIT OR GPL-3.0)")).toBe("ok");
    expect(status("GPL-3.0 OR Apache-2.0")).toBe("ok");
    expect(status("(GPL-2.0 OR LGPL-3.0)")).toBe("fail");
    expect(status("(MPL-2.0 OR MIT)")).toBe("ok");
    expect(status("(MPL-2.0 OR GPL-3.0)")).toBe("warn");
  });
  it("AND: every part must be allowed", () => {
    expect(status("(MIT AND BSD-3-Clause)")).toBe("ok");
    expect(status("(MIT AND GPL-3.0)")).toBe("fail");
    expect(evaluateLicense("(MIT AND GPL-3.0)", policy).bad).toEqual(["GPL-3.0"]);
    expect(status("MIT AND MPL-2.0")).toBe("warn");
  });
  it("AND binds tighter than OR, and parentheses nest", () => {
    expect(parseExpression("A OR B AND C")).toEqual({ op: "OR", args: [{ id: "A" }, { op: "AND", args: [{ id: "B" }, { id: "C" }] }] });
    expect(status("MIT OR GPL-3.0 AND GPL-2.0")).toBe("ok");
    expect(status("(MIT OR GPL-3.0) AND GPL-2.0")).toBe("fail");
    expect(status("((MIT))")).toBe("ok");
  });
  it("ignores WITH exceptions and a trailing +", () => {
    expect(status("Apache-2.0 WITH LLVM-exception")).toBe("ok");
    expect(status("GPL-2.0-or-later WITH Classpath-exception-2.0")).toBe("fail");
    expect(status("ISC+")).toBe("ok");
  });
  it("treats malformed expressions as failures", () => {
    for (const l of ["(MIT", "MIT OR", "AND MIT", "MIT MIT", "()"]) expect(status(l)).toBe("fail");
  });
});

describe("package lists", () => {
  it("reads the license from a manifest in every npm shape", () => {
    expect(licenseOfManifest({ license: "MIT" })).toBe("MIT");
    expect(licenseOfManifest({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseOfManifest({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("(MIT OR Apache-2.0)");
    expect(licenseOfManifest({})).toBeUndefined();
  });
  it("flattens pnpm's license-keyed object and a plain array", () => {
    const keyed = { MIT: [{ name: "a", versions: ["1.0.0", "2.0.0"] }], "GPL-3.0": [{ name: "b", versions: ["3.0.0"] }] };
    expect(flattenPnpmLicenses(keyed)).toEqual([
      { name: "a", version: "1.0.0", license: "MIT" },
      { name: "a", version: "2.0.0", license: "MIT" },
      { name: "b", version: "3.0.0", license: "GPL-3.0" }
    ]);
    expect(flattenPnpmLicenses([{ name: "c", version: "1.0.0", license: "ISC" }, { name: "d", versions: ["1.0.0"], license: "MIT" }])).toEqual([
      { name: "c", version: "1.0.0", license: "ISC" },
      { name: "d", version: "1.0.0", license: "MIT" }
    ]);
    expect(flattenPnpmLicenses({})).toEqual([]);
  });
  it("sorts packages into offenders, warnings and exceptions", () => {
    const pkgs = [
      { name: "ok", version: "1.0.0", license: "MIT" },
      { name: "care", version: "1.0.0", license: "MPL-2.0" },
      { name: "bad", version: "1.0.0", license: "GPL-3.0" },
      { name: "none", version: "1.0.0", license: undefined },
      { name: "known", version: "2.0.0", license: "GPL-3.0" },
      { name: "ok", version: "1.0.0", license: "MIT" }
    ];
    const r = checkPackages(pkgs, { ...policy, exceptions: { "known@2.0.0": "separate process, optional" } });
    expect(r.offenders.map((p) => p.name)).toEqual(["bad", "none"]);
    expect(r.warnings.map((p) => p.name)).toEqual(["care"]);
    expect(r.excepted).toEqual([{ name: "known", version: "2.0.0", license: "GPL-3.0", reason: "separate process, optional" }]);
  });
  it("an exception covers only the version it names", () => {
    const r = checkPackages([{ name: "known", version: "3.0.0", license: "GPL-3.0" }], { ...policy, exceptions: { "known@2.0.0": "x" } });
    expect(r.offenders).toHaveLength(1);
  });
});

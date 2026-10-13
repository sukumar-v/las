import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/diff.js";

describe("unifiedDiff", () => {
  it("is empty for identical text", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "f")).toBe("");
  });
  it("shows an added file against /dev/null", () => {
    expect(unifiedDiff(undefined, "x\ny\n", "f")).toBe("--- /dev/null\n+++ f\n@@ -0,0 +1,2 @@\n+x\n+y\n");
  });
  it("shows a change with context", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n") + "\n";
    const b = a.replace("5\n", "five\n");
    expect(unifiedDiff(a, b, "f")).toBe("--- f\n+++ f\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n");
  });
  it("splits distant changes into hunks and merges close ones", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const far = lines.slice();
    far[2] = "A";
    far[25] = "B";
    expect(unifiedDiff(lines.join("\n"), far.join("\n"), "f").match(/^@@/gm)).toHaveLength(2);
    const near = lines.slice();
    near[10] = "A";
    near[13] = "B";
    expect(unifiedDiff(lines.join("\n"), near.join("\n"), "f").match(/^@@/gm)).toHaveLength(1);
  });
  it("handles inserts, deletes and CRLF input", () => {
    const d = unifiedDiff("a\r\nb\r\nc\r\n", "a\r\nc\r\nd\r\n", "f");
    expect(d).toContain("-b");
    expect(d).toContain("+d");
    expect(d).not.toContain("\r");
  });
});

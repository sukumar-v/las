import { readFileSync } from "node:fs";

export function add(a: number, b: number): number {
  return a + b;
}

export function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new RangeError("division by zero");
  return Math.trunc(a / b);
}

export function spin(): number {
  for (;;) {
    // never returns: used by the timeout test
  }
}

if (process.argv[1]?.endsWith("solution.ts")) {
  const name: string = readFileSync(0, "utf8").trim();
  console.log(`Hello, ${name}!`);
}

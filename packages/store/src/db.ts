import "./quiet.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";

export type Row = Record<string, any>;

/** Thin wrapper over node:sqlite with migrations. */
export class Db {
  readonly sqlite: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  migrate(): void {
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const current = (this.sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as Row | undefined)?.v ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.sqlite.exec("BEGIN");
      try {
        this.sqlite.exec(m.sql);
        this.sqlite.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(m.version, new Date().toISOString());
        this.sqlite.exec("COMMIT");
      } catch (e) {
        this.sqlite.exec("ROLLBACK");
        throw e;
      }
    }
  }

  get version(): number {
    return (this.sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as Row).v ?? 0;
  }

  run(sql: string, ...params: any[]): void {
    this.sqlite.prepare(sql).run(...params.map(norm));
  }
  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params.map(norm)) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.sqlite.prepare(sql).all(...params.map(norm)) as T[];
  }
  transaction<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const out = fn();
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  close(): void {
    this.sqlite.close();
  }
}

function norm(v: any): any {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return v;
}

export const now = (): string => new Date().toISOString();

export function newId(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}_${s}`;
}

export function json<T = any>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

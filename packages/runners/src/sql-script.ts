/**
 * Runs a LAS SQL harness (SQL plus the sqlite3 shell's .read/.print/.mode/.headers/.separator/.bail)
 * against any engine that can execute one statement, such as sql.js in the browser. Output matches
 * the sqlite3 shell's list mode. Browser-safe.
 *
 * One known difference: sql.js returns REAL 2.0 as the number 2, so it prints "2" where the sqlite3
 * shell prints "2.0".
 */
export type SqlExec = (sql: string) => { columns: string[]; values: unknown[][] }[];

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return String(v);
}

/** Splits SQL into whole statements, respecting quotes, comments and trigger bodies. */
export function splitSql(text: string): { sql: string; line: number }[] {
  const out: { sql: string; line: number }[] = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") line++;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      i++;
      while (i < n && text[i] !== close) {
        if (text[i] === "\n") line++;
        i++;
      }
    } else if (text.startsWith("--", i)) {
      while (i < n && text[i] !== "\n") i++;
      continue;
    } else if (text.startsWith("/*", i)) {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      line += (text.slice(i, end).match(/\n/g) ?? []).length;
      i = end;
      continue;
    } else if (c === ";") {
      const sql = text.slice(start, i + 1);
      // a trigger body holds statements of its own; it ends at END;
      const bare = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      if (!/^\s*CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(bare) || /\bEND\s*;$/i.test(bare)) {
        if (sql.trim() !== ";") out.push({ sql, line: startLine });
        start = i + 1;
        startLine = line;
      }
    }
    i++;
  }
  const rest = text.slice(start);
  if (rest.replace(/--[^\n]*/g, "").trim()) out.push({ sql: rest, line: startLine });
  return out;
}

/** Runs the script and returns what the sqlite3 shell would print. */
export function runSqlScript(script: string, files: Record<string, string>, execSql: SqlExec): string {
  const out: string[] = [];
  let headers = false;
  let sep = "|";
  let bail = false;
  let stop = false;

  const statement = (sql: string, line: number) => {
    try {
      for (const r of execSql(sql)) {
        if (headers && r.values.length) out.push(r.columns.join(sep));
        for (const row of r.values) out.push(row.map(fmt).join(sep));
      }
    } catch (e) {
      out.push(`Error: near line ${line}: ${(e as Error).message ?? e}`);
      if (bail) stop = true;
    }
  };

  const run = (text: string) => {
    let buf: string[] = [];
    let bufLine = 1;
    const flush = () => {
      const chunk = buf.join("\n");
      for (const s of splitSql(chunk)) {
        if (stop) return;
        statement(s.sql, bufLine + s.line - 1);
      }
      buf = [];
    };
    text.split("\n").forEach((raw, k) => {
      if (stop) return;
      const lineText = raw.replace(/\r$/, "");
      const pending = buf.join("\n").replace(/--[^\n]*/g, "").trim();
      if (!pending && lineText.trimStart().startsWith(".")) {
        const cmd = lineText.trim().split(/\s+/)[0];
        const arg = lineText.trim().slice(cmd.length).trim();
        const val = arg.replace(/^['"]|['"]$/g, "");
        if (cmd === ".read") {
          if (files[val] === undefined) out.push(`Error: cannot open "${val}"`);
          else run(files[val]);
        } else if (cmd === ".print") out.push(arg);
        else if (cmd === ".headers") headers = /^(on|1|yes|true)$/i.test(val);
        else if (cmd === ".mode") sep = val === "csv" ? "," : val === "tabs" ? "\t" : "|";
        else if (cmd === ".separator") sep = val;
        else if (cmd === ".bail") bail = /^(on|1|yes|true)$/i.test(val);
        else out.push(`Error: unknown command or invalid arguments: "${cmd.slice(1)}"`);
        return;
      }
      if (!pending) bufLine = k + 1;
      buf.push(lineText);
      // run whole statements as soon as they are complete, so output keeps its order with .print lines
      const joined = buf.join("\n");
      const parts = splitSql(joined);
      const last = parts[parts.length - 1];
      if (parts.length && /;\s*$/.test(joined.replace(/--[^\n]*$/, "")) && last && /;\s*$/.test(last.sql)) flush();
    });
    if (!stop && buf.join("\n").trim()) flush();
  };

  run(script);
  return out.join("\n") + (out.length ? "\n" : "");
}

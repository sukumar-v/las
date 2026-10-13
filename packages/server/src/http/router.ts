import type { IncomingMessage, ServerResponse } from "node:http";

export interface Req {
  raw: IncomingMessage;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  json<T = any>(): Promise<T>;
  body(): Promise<Buffer>;
}
export interface Res {
  raw: ServerResponse;
  json(data: unknown, status?: number): void;
  text(data: string, status?: number, type?: string): void;
  html(data: string, status?: number): void;
  status(code: number): void;
}
export type Handler = (req: Req, res: Res) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) {
    return this.add("GET", p, h);
  }
  post(p: string, h: Handler) {
    return this.add("POST", p, h);
  }
  put(p: string, h: Handler) {
    return this.add("PUT", p, h);
  }
  delete(p: string, h: Handler) {
    return this.add("DELETE", p, h);
  }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = path.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method && r.method !== "*") continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p === "*") {
          params["*"] = parts.slice(i).join("/");
          ok = true;
          break;
        }
        if (parts[i] === undefined) {
          ok = false;
          break;
        }
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
        else if (p !== parts[i]) {
          ok = false;
          break;
        }
        if (i === r.parts.length - 1 && parts.length > r.parts.length) ok = false;
      }
      if (ok && (r.parts.length === parts.length || r.parts.includes("*"))) return { handler: r.handler, params };
    }
    return undefined;
  }
}

export function wrap(raw: IncomingMessage, res: ServerResponse, params: Record<string, string>): { req: Req; out: Res } {
  const url = new URL(raw.url ?? "/", "http://localhost");
  let cached: Promise<Buffer> | undefined;
  const body = () => (cached ??= new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    raw.on("data", (c) => chunks.push(c));
    raw.on("end", () => resolve(Buffer.concat(chunks)));
    raw.on("error", reject);
  }));
  const req: Req = { raw, method: raw.method ?? "GET", path: url.pathname, query: url.searchParams, params, body, json: async () => JSON.parse((await body()).toString("utf8") || "{}") };
  const out: Res = {
    raw: res,
    status: (c) => {
      res.statusCode = c;
    },
    json: (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    },
    text: (data, status = 200, type = "text/plain; charset=utf-8") => {
      res.writeHead(status, { "content-type": type });
      res.end(data);
    },
    html: (data, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(data);
    }
  };
  return { req, out };
}

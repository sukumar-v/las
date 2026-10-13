import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A tool result that carries structured data, a short text summary, and (when the client supports it) a widget. */
export function ok(text: string, data?: Record<string, unknown>, extra: Partial<CallToolResult> = {}): CallToolResult {
  const r: CallToolResult = { content: [{ type: "text", text }], ...extra };
  if (data) r.structuredContent = data;
  return r;
}

export function fail(message: string, data?: Record<string, unknown>): CallToolResult {
  const r: CallToolResult = { content: [{ type: "text", text: message }], isError: true };
  if (data) r.structuredContent = data;
  return r;
}

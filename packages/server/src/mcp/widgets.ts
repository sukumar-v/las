import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Theme } from "@las/schema";
import type { LasContext } from "../context.js";
import { activeTheme } from "../core/theme.js";

/** One widget renders every view: the tool result carries `{view, theme, data}` and the widget draws it in the learner's theme. */
export const WIDGET_URI = "ui://las/view.html";

export type ViewName =
  | "onboarding"
  | "today"
  | "session"
  | "lesson"
  | "sim"
  | "diagram"
  | "mechanism"
  | "drill"
  | "review"
  | "capture"
  | "analysis"
  | "feedback"
  | "mistake"
  | "progress"
  | "summary"
  | "proof"
  | "theme-preview"
  | "capabilities"
  | "plan"
  | "route";

/**
 * MCP Apps protocol constants the fallback widget speaks (from @modelcontextprotocol/ext-apps spec.types:
 * LATEST_PROTOCOL_VERSION, INITIALIZE_METHOD, INITIALIZED_METHOD, TOOL_RESULT_METHOD). A test keeps them in step.
 */
export const MCP_APPS = { protocolVersion: "2026-01-26", initialize: "ui/initialize", initialized: "ui/notifications/initialized", toolResult: "ui/notifications/tool-result" } as const;

/** How long the fallback widget waits for a host to answer ui/initialize before pointing at the studio. */
export const WIDGET_HOST_TIMEOUT_MS = 2000;

export function fallbackWidgetHtml(): string {
  // A minimal widget used when the studio hasn't been built. Colors and fonts come from the theme in the tool result.
  // No network: the MCP Apps handshake is a few JSON-RPC messages over window.parent.postMessage, written inline.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LAS</title>
<style>:root{color-scheme:light dark}body{margin:0;font-family:var(--las-font-body);background:var(--las-color-bg);color:var(--las-color-ink);padding:var(--las-space-3)}a{color:var(--las-color-accent)}pre{white-space:pre-wrap;font-family:var(--las-font-mono);font-size:var(--las-text-0)}.card{background:var(--las-color-surface);border:var(--las-border-width) solid var(--las-color-line);border-radius:var(--las-radius-lg);padding:var(--las-space-3)}</style></head>
<body><div id="root" class="card">Loading…</div>
<script>
(function(){
var P=${JSON.stringify(MCP_APPS)}, TIMEOUT=${WIDGET_HOST_TIMEOUT_MS};
var root=document.getElementById("root"), host=window.parent, nextId=1, pending={}, connected=false, rendered=false;
function esc(s){ return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
function applyTheme(t){ if(!t||!t.tokens) return; var c=t.tokens.color||{}, ty=t.tokens.type||{}, s=document.documentElement.style;
  Object.keys(c).forEach(function(k){ if(typeof c[k]==="string") s.setProperty("--las-color-"+k.replace("_","-"), c[k]); });
  if(ty.body) s.setProperty("--las-font-body", ty.body.family+", "+ty.body.fallback); if(ty.mono) s.setProperty("--las-font-mono", ty.mono.family+", "+ty.mono.fallback);
  (t.tokens.space||[]).forEach(function(v,i){ s.setProperty("--las-space-"+i, v+"px"); }); (ty.scale||[]).forEach(function(v,i){ s.setProperty("--las-text-"+i, v+"px"); });
  if(t.tokens.radius) s.setProperty("--las-radius-lg", t.tokens.radius.lg+"px"); if(t.tokens.border) s.setProperty("--las-border-width", t.tokens.border.width+"px"); }
function render(sc){ rendered=true; applyTheme(sc.theme); var link = sc.studioLink ? '<p><a href="'+esc(sc.studioLink)+'" target="_blank" rel="noopener">Open in the studio</a></p>' : "";
  root.innerHTML = "<strong>"+esc(sc.title||sc.view||"LAS")+"</strong>"+link+"<pre>"+esc(JSON.stringify(sc.data==null?{}:sc.data,null,1).slice(0,4000))+"</pre>"; }
function post(m){ m.jsonrpc="2.0"; try { host.postMessage(m,"*"); } catch(e) {} }
function request(method, params, cb){ var id=nextId++; pending[id]=cb; post({ id:id, method:method, params:params }); }
window.addEventListener("message", function(ev){
  if(ev.source && ev.source!==host) return; var m=ev.data; if(!m||m.jsonrpc!=="2.0") return;
  if(m.id!=null && !m.method){ var cb=pending[m.id]; delete pending[m.id]; if(cb) cb(m.error, m.result); return; }
  if(m.method===P.toolResult){ if(m.params&&m.params.structuredContent) render(m.params.structuredContent); return; }
  // any other host request (ping, teardown): answer so the host isn't left waiting
  if(m.id!=null && m.method) post({ id:m.id, result:{} });
});
var timer=setTimeout(function(){ if(!connected&&!rendered) root.textContent="Open this in the studio."; }, TIMEOUT);
if(!host||host===window){ clearTimeout(timer); root.textContent="Open this in the studio."; return; }
request(P.initialize, { appInfo:{ name:"las-view", version:"0.1.0" }, appCapabilities:{}, protocolVersion:P.protocolVersion }, function(err){
  if(err){ if(!rendered) root.textContent="Open this in the studio."; return; }
  connected=true; clearTimeout(timer); post({ method:P.initialized, params:{} });
});
})();
</script></body></html>`;
}

export function widgetHtml(ctx: LasContext): string {
  const p = ctx.config.studioDist ? join(ctx.config.studioDist, "widget.html") : undefined;
  if (p && existsSync(p)) return readFileSync(p, "utf8");
  return fallbackWidgetHtml();
}

export function registerWidgets(server: McpServer, ctx: LasContext): void {
  registerAppResource(server, "LAS view", WIDGET_URI, { description: "Renders any LAS view in the learner's theme", _meta: { ui: { prefersBorder: false } } }, async () => ({
    contents: [{ uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml(ctx) }]
  }));
}

export interface ViewPayload {
  view: ViewName;
  title: string;
  data: Record<string, unknown>;
  /** path in the studio that shows the same thing */
  studioPath?: string;
  /** enrollment id, for the per-skill theme */
  sk?: string | null;
  /** short text for clients without widgets and for the model */
  text: string;
  theme?: Theme;
}

/** Builds a tool result that renders as a widget when the client supports MCP Apps, and as text plus a studio link otherwise. */
export function view(ctx: LasContext, p: ViewPayload): CallToolResult {
  const t = p.theme ? { theme: p.theme, id: p.theme.id ?? "draft", scope: "all" as const } : activeTheme(ctx, p.sk ?? undefined);
  const studioLink = p.studioPath ? ctx.studioLink(p.studioPath) : undefined;
  const text = ctx.widgetsSupported ? p.text : studioLink ? `${p.text}\n\nOpen in the studio: ${studioLink}` : p.text;
  return {
    content: [{ type: "text", text }],
    structuredContent: { view: p.view, title: p.title, data: p.data, theme: t.theme, themeId: t.id, studioLink, sk: p.sk ?? null },
    _meta: { ui: { resourceUri: WIDGET_URI } }
  };
}

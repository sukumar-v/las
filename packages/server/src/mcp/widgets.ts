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

function fallbackWidgetHtml(): string {
  // A minimal widget used when the studio hasn't been built. Colors and fonts come from the theme in the tool result.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LAS</title>
<style>:root{color-scheme:light dark}body{margin:0;font-family:var(--las-font-body);background:var(--las-color-bg);color:var(--las-color-ink);padding:var(--las-space-3)}a{color:var(--las-color-accent)}pre{white-space:pre-wrap;font-family:var(--las-font-mono);font-size:var(--las-text-0)}.card{background:var(--las-color-surface);border:var(--las-border-width) solid var(--las-color-line);border-radius:var(--las-radius-lg);padding:var(--las-space-3)}</style></head>
<body><div id="root" class="card">Loading…</div>
<script type="module">
import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.5";
const root = document.getElementById("root");
function applyTheme(t){ if(!t) return; const c=t.tokens.color, ty=t.tokens.type, s=document.documentElement.style;
  for (const [k,v] of Object.entries(c)) if (typeof v==="string") s.setProperty("--las-color-"+k.replace("_","-"), v);
  s.setProperty("--las-font-body", ty.body.family+", "+ty.body.fallback); s.setProperty("--las-font-mono", ty.mono.family+", "+ty.mono.fallback);
  t.tokens.space.forEach((v,i)=>s.setProperty("--las-space-"+i, v+"px")); ty.scale.forEach((v,i)=>s.setProperty("--las-text-"+i, v+"px"));
  s.setProperty("--las-radius-lg", t.tokens.radius.lg+"px"); s.setProperty("--las-border-width", t.tokens.border.width+"px"); }
function render(sc){ applyTheme(sc.theme); const link = sc.studioLink ? '<p><a href="'+sc.studioLink+'" target="_blank" rel="noopener">Open in the studio</a></p>' : "";
  root.innerHTML = "<strong>"+(sc.title||sc.view||"LAS")+"</strong>"+link+"<pre>"+JSON.stringify(sc.data??{},null,1).slice(0,4000)+"</pre>"; }
const app = new App({ name: "las-view", version: "0.1.0" });
app.ontoolresult = (r) => { if (r.structuredContent) render(r.structuredContent); };
app.connect().catch(()=>{ root.textContent = "Open this in the studio."; });
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

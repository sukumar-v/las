/**
 * The MCP Apps widget (dist/widget.html, one self-contained file): renders a tool result's view with the shared
 * Widget in the learner's theme. Nothing is fetched inside the host's sandbox: fonts fall back to their stacks,
 * and anything that needs a device or the server opens the studio.
 */
import { render } from "preact";
import "@las/ui/base.css";
import { App } from "@modelcontextprotocol/ext-apps";
import { Widget, applyTheme, BASE_THEME, type WidgetPayload } from "@las/ui";
import type { Theme, ThemeMode } from "@las/schema";
import { withoutFontSources } from "./theme.js";

const root = document.getElementById("app")!;
let payload: WidgetPayload | undefined;
let hostMode: ThemeMode | undefined;

const app = new App({ name: "las-view", version: "0.1.0" });

/** Follows the host's light or dark mode when the theme has both (theming §5). */
function modeFor(theme: Theme): ThemeMode | undefined {
  return hostMode && theme.modes.includes(hostMode) && theme.modes.length > 1 ? hostMode : undefined;
}

function draw(): void {
  const theme = withoutFontSources((payload?.theme as Theme | undefined) ?? BASE_THEME);
  applyTheme(theme, document.documentElement, modeFor(theme));
  if (!payload) return;
  const open = () => {
    if (payload?.studioLink) void (app as unknown as { openLink?: (p: { url: string }) => Promise<unknown> }).openLink?.({ url: payload.studioLink });
  };
  render(<Widget payload={{ ...payload, theme }} handlers={{ onStart: open, onReview: open, onProgress: open, onProof: open, onTry: open, onReRecord: open, onCheckin: open, onNext: open, onRetry: open, onChoose: open, onCapture: open }} />, root);
}

app.ontoolresult = (r) => {
  const sc = (r as { structuredContent?: unknown }).structuredContent as WidgetPayload | undefined;
  if (sc && typeof sc === "object" && "view" in sc) {
    payload = sc;
    draw();
  }
};
app.onhostcontextchanged = (ctx) => {
  const m = (ctx as { theme?: ThemeMode }).theme;
  if (m && m !== hostMode) {
    hostMode = m;
    draw();
  }
};

applyTheme(withoutFontSources(BASE_THEME), document.documentElement);
app
  .connect()
  .then(() => {
    hostMode = (app.getHostContext() as { theme?: ThemeMode } | undefined)?.theme;
    draw();
  })
  .catch(() => {
    render(<p class="las-hint">Open this in the studio.</p>, root);
  });

/**
 * The learner's theme on the live document (theming §5): tokens become CSS custom properties on the root,
 * variants become data attributes, and switching is instant. The server's event stream says when it changes.
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { applyTheme, copy, type Voice } from "@las/ui";
import type { Theme, ThemeMode } from "@las/schema";
import { api } from "./api.js";

export const VoiceContext = createContext<Voice | undefined>(undefined);

export function useVoice(): Voice | undefined {
  return useContext(VoiceContext);
}

/** All learner-facing copy goes through the theme's voice; text that has no variant passes through. */
export function useT(): (key: string) => string {
  const voice = useVoice();
  return (key: string) => copy(voice, key);
}

/** The browser chrome color follows the theme's background (read back from the applied tokens). */
export function syncThemeColor(doc: Document = document): void {
  const meta = doc.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(doc.documentElement).getPropertyValue("--las-color-bg").trim();
  if (meta && bg) meta.setAttribute("content", bg);
}

/** A theme without font sources: used where nothing may be fetched (the widget), so the fallback stacks apply. */
export function withoutFontSources(theme: Theme): Theme {
  const t = structuredClone(theme);
  for (const role of ["display", "body", "mono"] as const) delete (t.tokens.type[role] as { source?: unknown }).source;
  return t;
}

export interface ThemeState {
  theme: Theme;
  themeId: string;
}

let current: ThemeState | undefined;
const listeners = new Set<(s: ThemeState) => void>();

export function onThemeChange(fn: (s: ThemeState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentTheme(): ThemeState | undefined {
  return current;
}

/** Applies a theme now. A host or system dark mode is honored by the generated CSS when the theme has both modes. */
export function setActiveTheme(theme: Theme, themeId: string, mode?: ThemeMode): void {
  applyTheme(theme, document.documentElement, mode);
  current = { theme, themeId };
  syncThemeColor();
  for (const l of listeners) l(current);
}

/** Loads the active theme for a skill (or everything) from the server and applies it. */
export async function loadTheme(sk?: string | null): Promise<ThemeState | undefined> {
  try {
    const r = await api.theme(sk);
    setActiveTheme(r.theme, r.themeId);
    return current;
  } catch {
    return current;
  }
}

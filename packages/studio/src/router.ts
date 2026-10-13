/** A tiny history router: patterns with :params, a query string, and navigation without a dependency. */
export interface RouteMatch {
  name: string;
  pattern: string;
  params: Record<string, string>;
  query: URLSearchParams;
  path: string;
}

/** Every studio route, in match order. */
export const ROUTES: [pattern: string, name: string][] = [
  ["/", "home"],
  ["/app/onboard/new", "onboard-new"],
  ["/app/onboard/:intakeId", "onboard"],
  ["/app/today", "today"],
  ["/app/session/:id", "session"],
  ["/app/capture/:attemptId", "capture"],
  ["/app/replay/:attemptId", "replay"],
  ["/app/progress", "progress"],
  ["/app/summary/:sessionId", "summary"],
  ["/app/proof/:milestoneId", "proof"],
  ["/app/review", "review"],
  ["/app/drill/:id", "drill"],
  ["/theme/:id", "theme"],
  ["/settings", "settings"],
  ["/pair/:token", "pair"],
  ["/snapshots", "snapshots"],
  // links the server's tools hand out
  ["/s/:id", "session"],
  ["/app/today/:sk", "today"],
  ["/app/progress/:sk", "progress"],
  ["/app/review/:sk", "review"],
  ["/app/onboarding/:intakeId", "onboard"],
  ["/app/feedback/:attemptId", "replay"],
  ["/app/lesson", "home"],
  ["/app/sim", "home"],
  ["/app/diagram", "home"],
  ["/app/mechanism", "home"],
  ["/app/code", "home"]
];

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Matches a pathname and search string against the routes; unknown paths match nothing. */
export function matchRoute(pathname: string, search = "", routes = ROUTES): RouteMatch | undefined {
  const parts = split(pathname.replace(/\/+$/, "") || "/");
  for (const [pattern, name] of routes) {
    const pp = split(pattern);
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(":")) {
        try {
          params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
          break;
        }
      } else if (pp[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { name, pattern, params, query: new URLSearchParams(search), path: pathname };
  }
  return undefined;
}

/** Builds a path from a pattern, params and an optional query; undefined query values are left out. */
export function buildPath(pattern: string, params: Record<string, string> = {}, query: Record<string, string | number | undefined | null> = {}): string {
  const path = "/" + split(pattern).map((p) => (p.startsWith(":") ? encodeURIComponent(params[p.slice(1)] ?? "") : p)).join("/");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function onNavigate(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Moves to a path inside the studio without a reload. */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (typeof history === "undefined") return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  for (const l of listeners) l();
  window.scrollTo?.(0, 0);
}

export function currentRoute(): RouteMatch | undefined {
  return matchRoute(location.pathname, location.search);
}

if (typeof window !== "undefined") window.addEventListener("popstate", () => listeners.forEach((l) => l()));

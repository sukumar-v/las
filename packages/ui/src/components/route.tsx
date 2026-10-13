import type { RouteView } from "@las/schema";

/** The route to the milestone: ladder, path, map or timeline (the theme's `route` variant picks). */
export function Route({ route, window, onPick }: { route: RouteView; window?: [number, number]; onPick?: (step: number) => void }) {
  const steps = window ? route.steps.filter((s) => s.step >= window[0] && s.step <= window[1]) : route.steps;
  const rows = [...steps].reverse();
  return (
    <div class="las-route" role="list" aria-label="Route">
      {rows.map((s) => (
        <button key={s.step} type="button" role="listitem" class={["las-rung", s.state, s.target && "target"].filter(Boolean).join(" ")} onClick={() => onPick?.(s.step)} disabled={!onPick}>
          <span class="h" aria-hidden="true" />
          <span class="t">{s.label}</span>
          <span class="m">{s.state === "here" ? <span class="you">You</span> : s.state === "ahead" && s.weeks ? `~${s.weeks} wk` : s.target ? "goal" : ""}</span>
        </button>
      ))}
    </div>
  );
}

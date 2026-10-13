import type { ComponentChildren } from "preact";
import type { RibbonItem } from "@las/schema";
import { Icon } from "../icons.js";
import { Progress, Button } from "./primitives.js";

/**
 * Every screen has the same frame: a progress bar with one segment per section,
 * a row of answer chips (tap to edit), one question and one answer component,
 * and one sticky main button with a secondary action under it.
 */
export function Frame({ sections, sectionIndex, sectionFill, ribbon, onRibbon, onBack, canBack, exit, onExit, cta, children, entering, status, aside, liveKind, liveScreen }: { sections?: string[]; sectionIndex?: number; sectionFill?: number; ribbon?: RibbonItem[]; onRibbon?: (id: string) => void; onBack?: () => void; canBack?: boolean; exit?: string; onExit?: () => void; cta?: { label: string; enabled?: boolean; onClick?: () => void; secondary?: ComponentChildren; hidden?: boolean }; children?: ComponentChildren; entering?: boolean; /** a row under the bar that stays in view (the live session's presence, pause and coach message) */ status?: ComponentChildren; /** after the screen's content (the ask-the-coach box) */ aside?: ComponentChildren; /** the live screen's kind and id, for tests */ liveKind?: string; liveScreen?: string }) {
  const segments = sections ? sections.map((_, i) => (sectionIndex === undefined ? 0 : i < sectionIndex ? 1 : i === sectionIndex ? Math.max(0.15, sectionFill ?? 0.5) : 0)) : undefined;
  return (
    <div class="las-app" data-live-kind={liveKind} data-live-screen={liveScreen}>
      <header class="las-top">
        <div class="las-bar">
          <button type="button" class="las-iconbtn" aria-label="Back" onClick={onBack} disabled={!canBack}>
            <Icon name="back" />
          </button>
          {segments ? <Progress segments={segments} /> : <span />}
          {exit ? (
            <Button link onClick={onExit}>
              {exit}
            </Button>
          ) : sections && sectionIndex !== undefined ? (
            <span class="las-secname">{sections[sectionIndex]}</span>
          ) : (
            <span />
          )}
        </div>
        {ribbon && ribbon.length ? (
          <div class="las-ribbon" aria-label="Your answers so far">
            {ribbon.map((r) => (
              <button key={r.id} type="button" class="las-rib" onClick={() => onRibbon?.(r.id)}>
                <Icon name={r.icon ?? "check"} size="sm" />
                {r.label}
              </button>
            ))}
          </div>
        ) : null}
        {status}
      </header>
      <main class={["las-main", entering && "las-enter"].filter(Boolean).join(" ")}>
        {children}
        {aside}
      </main>
      {cta && !cta.hidden ? (
        <footer class="las-cta">
          <Button primary big disabled={cta.enabled === false} onClick={cta.onClick}>
            {cta.label}
          </Button>
          {cta.secondary ? <div class="las-alt">{cta.secondary}</div> : null}
        </footer>
      ) : null}
    </div>
  );
}

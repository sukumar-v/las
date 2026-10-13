import type { OptionView } from "@las/schema";
import { Chip, Chips, Tile, Tiles } from "./primitives.js";
import { Figure } from "../figures/figure.js";

export function Single({ options, value, onPick, list = true }: { options: OptionView[]; value?: unknown; onPick?: (v: string | number) => void; list?: boolean }) {
  return (
    <Tiles list={list}>
      {options.map((o) => (
        <Tile key={String(o.value)} title={o.label} detail={o.detail} badge={o.badge} icon={o.icon} on={value === o.value} onClick={() => onPick?.(o.value)} figure={o.figure ? <Figure figure={o.figure} /> : undefined} />
      ))}
    </Tiles>
  );
}

export function Multi({ options, value, onToggle, max, big }: { options: OptionView[]; value?: (string | number)[]; onToggle?: (v: string | number) => void; max?: number; big?: boolean }) {
  const picked = value ?? [];
  return (
    <Chips big={big}>
      {options.map((o) => (
        <Chip key={String(o.value)} label={o.label} icon={o.icon} on={picked.includes(o.value)} onClick={() => onToggle?.(o.value)} value={String(o.value)} />
      ))}
      {max ? <span class="las-sr">Pick up to {max}</span> : null}
    </Chips>
  );
}

/** Grades, belts, levels drawn in the skill's own terms. */
export function Scale({ options, value, onPick }: { options: OptionView[]; value?: unknown; onPick?: (v: string | number) => void }) {
  return (
    <div class="las-scale" role="group" aria-label="Level">
      {options.map((o, i) => (
        <button key={String(o.value)} type="button" class={i === 0 || o.label.length > 4 ? "word" : ""} aria-pressed={value === o.value ? "true" : "false"} onClick={() => onPick?.(o.value)} title={o.detail}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function VisualMulti({ options, value, onToggle }: { options: OptionView[]; value?: (string | number)[]; onToggle?: (v: string | number) => void }) {
  const picked = value ?? [];
  return (
    <div class="las-visuals" role="group" aria-label="Pick what you know">
      {options.map((o) => (
        <button key={String(o.value)} type="button" class="las-visual" aria-pressed={picked.includes(o.value) ? "true" : "false"} aria-label={o.label} onClick={() => onToggle?.(o.value)}>
          {o.figure ? <Figure figure={o.figure} /> : null}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export interface ChoiceState {
  picked?: number;
  revealed?: boolean;
}

/** A multiple-choice item with reveal. Used by quizzes, predict cards and choice drills. */
export function Choice({ prompt, options, answer, state, onPick, code, figures, reveal }: { prompt?: string; options: string[]; answer?: number; state?: ChoiceState; onPick?: (i: number) => void; code?: string; figures?: any[]; reveal?: string }) {
  const picked = state?.picked;
  const revealed = state?.revealed && answer !== undefined;
  return (
    <div class="las-stack">
      {prompt ? <div class="las-prompt">{prompt}</div> : null}
      {code ? <pre class="las-code">{code}</pre> : null}
      <div class={["las-opts", figures && "grid"].filter(Boolean).join(" ")} role="group" aria-label={prompt ?? "Options"}>
        {options.map((o, i) => {
          const cls = ["las-opt"];
          if (revealed && i === answer) cls.push("right");
          else if (revealed && i === picked) cls.push("wrong");
          return (
            <button key={i} type="button" class={cls.join(" ")} aria-pressed={picked === i ? "true" : "false"} disabled={revealed} onClick={() => onPick?.(i)}>
              {figures?.[i] ? <figure>{<Figure figure={figures[i]} />}</figure> : null}
              <span>{o}</span>
            </button>
          );
        })}
      </div>
      {revealed && reveal ? <p class="las-hint">{reveal}</p> : null}
    </div>
  );
}

export function Slider({ id, label, min, max, step, value, onInput, format, hints }: { id: string; label: string; min: number; max: number; step?: number; value: number; onInput?: (v: number) => void; format?: (v: number) => string; hints?: [string, string] }) {
  return (
    <div class="las-stack">
      <div class="las-bignum">
        <span id={`${id}-value`}>{format ? format(value) : value}</span>
      </div>
      <input type="range" id={id} min={min} max={max} step={step ?? 1} value={value} aria-label={label} aria-describedby={`${id}-value`} onInput={(e) => onInput?.(Number((e.currentTarget as HTMLInputElement).value))} />
      {hints ? (
        <div class="las-rangehint">
          <span>{hints[0]}</span>
          <span>{hints[1]}</span>
        </div>
      ) : null}
    </div>
  );
}

export function WeekPlan({ days, minutes, sessions, labels = ["M", "T", "W", "T", "F", "S", "S"] }: { days: number[]; minutes: number; sessions: number; labels?: string[] }) {
  const h = Math.min(100, Math.max(18, minutes / sessions));
  return (
    <div class="las-week" role="img" aria-label={`${sessions} sessions a week on ${days.map((d) => labels[d]).join(", ")}`}>
      {labels.map((l, i) => (
        <div key={i} class="las-day">
          <i class={days.includes(i) ? "" : "off"} style={days.includes(i) ? { height: `${h}%` } : undefined} />
          <span>{l}</span>
        </div>
      ))}
    </div>
  );
}

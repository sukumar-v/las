import type { ComponentChildren, JSX } from "preact";
import { Icon } from "../icons.js";

type Btn = JSX.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; link?: boolean; big?: boolean; icon?: string; children?: ComponentChildren };
export function Button({ primary, link, big, icon, children, class: cls, type, ...rest }: Btn) {
  return (
    <button type={(type as any) ?? "button"} class={["las-btn", primary && "primary", link && "link", big && "big", cls].filter(Boolean).join(" ")} {...rest}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}

export function Card({ children, sunk, class: cls, role, label }: { children?: ComponentChildren; sunk?: boolean; class?: string; role?: JSX.AriaRole; label?: string }) {
  return (
    <section class={["las-card", sunk && "sunk", cls].filter(Boolean).join(" ")} role={role} aria-label={label}>
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children?: ComponentChildren }) {
  return <span class="las-eyebrow">{children}</span>;
}
export function H1({ children }: { children?: ComponentChildren }) {
  return (
    <h1 class="las-h1" tabIndex={-1}>
      {children}
    </h1>
  );
}
export function H2({ children, small }: { children?: ComponentChildren; small?: string }) {
  return (
    <h2 class="las-h2">
      {children}
      {small ? <small> · {small}</small> : null}
    </h2>
  );
}
export function Question({ q, sub }: { q: string; sub?: ComponentChildren }) {
  return (
    <div class="las-q">
      <H1>{q}</H1>
      {sub ? <p class="las-sub">{sub}</p> : null}
    </div>
  );
}
export function Hint({ children }: { children?: ComponentChildren }) {
  return <p class="las-hint">{children}</p>;
}
export function Note({ children, kind, icon }: { children?: ComponentChildren; kind?: "warn" | "bad"; icon?: string }) {
  return (
    <div class={["las-note", kind].filter(Boolean).join(" ")} role={kind ? "alert" : undefined}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </div>
  );
}
export function Badge({ children }: { children?: ComponentChildren }) {
  return <span class="las-badge">{children}</span>;
}
export function Tag({ children }: { children?: ComponentChildren }) {
  return <span class="las-tag">{children}</span>;
}
export function Pill({ children, kind, icon }: { children?: ComponentChildren; kind: "good" | "warn" | "bad" | "info"; icon?: string }) {
  return (
    <span class={`las-pill ${kind}`}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </span>
  );
}

export function Chip({ label, on, onClick, icon, value }: { label: string; on?: boolean; onClick?: (value: string) => void; icon?: string; value?: string }) {
  return (
    <button type="button" class="las-chip" aria-pressed={on ? "true" : "false"} onClick={() => onClick?.(value ?? label)}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {label}
    </button>
  );
}
export function Chips({ children, big }: { children?: ComponentChildren; big?: boolean }) {
  return <div class={["las-chips", big && "big"].filter(Boolean).join(" ")}>{children}</div>;
}

export function Tile({ title, detail, on, onClick, icon, badge, figure }: { title: string; detail?: string; on?: boolean; onClick?: () => void; icon?: string; badge?: string; figure?: ComponentChildren }) {
  return (
    <button type="button" class="las-tile" aria-pressed={on ? "true" : "false"} onClick={onClick}>
      {badge ? <Badge>{badge}</Badge> : null}
      {figure ? <figure>{figure}</figure> : icon ? <span class="ti"><Icon name={icon} /></span> : null}
      <span class="tt">
        <b>{title}</b>
        {detail ? <small>{detail}</small> : null}
      </span>
    </button>
  );
}
export function Tiles({ children, list }: { children?: ComponentChildren; list?: boolean }) {
  return <div class={["las-tiles", list && "list"].filter(Boolean).join(" ")}>{children}</div>;
}

/** One segment per section; fill in [0,1] per segment. */
export function Progress({ segments, label = "Progress" }: { segments: number[]; label?: string }) {
  return (
    <div class="las-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={segments.length} aria-valuenow={segments.filter((s) => s >= 1).length}>
      {segments.map((f, i) => (
        <span key={i} class={f >= 1 ? "done" : f > 0 ? "on" : ""}>
          <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, f))})` }} />
        </span>
      ))}
    </div>
  );
}

/** A meter drawn as a bar, a ring or ticks (the theme's `meter` variant picks). */
export function Meter({ value, label, good, size = 48 }: { value: number; label?: string; good?: boolean; size?: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <div class="las-meterwrap" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div class={["las-meter", "ringed", good && "good"].filter(Boolean).join(" ")}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <span class="las-ring" style={{ width: `${size}px` }}>
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <circle class="track" cx="20" cy="20" r={r} stroke-width="4" />
          <circle class="fill" cx="20" cy="20" r={r} stroke-width="4" stroke-dasharray={c} stroke-dashoffset={c * (1 - pct / 100)} transform="rotate(-90 20 20)" />
          <text x="20" y="23" text-anchor="middle" font-size="9">
            {pct}
          </text>
        </svg>
      </span>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange?: (id: string) => void }) {
  return (
    <div class="las-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value ? "true" : "false"} onClick={() => onChange?.(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function WeekDots({ week, labels = ["M", "T", "W", "T", "F", "S", "S"] }: { week: { day: number; state: "done" | "missed" | "plan" | "none"; today?: boolean }[]; labels?: string[] }) {
  return (
    <div class="las-weekdots" role="img" aria-label={`This week: ${week.filter((d) => d.state === "done").length} done, ${week.filter((d) => d.state === "missed").length} missed, ${week.filter((d) => d.state === "plan").length} planned`}>
      {week.map((d) => (
        <div key={d.day}>
          <i class={d.state === "none" ? "" : d.state} />
          <span>{labels[d.day]}</span>
        </div>
      ))}
    </div>
  );
}

export function Mix({ parts, label = "Practice mix" }: { parts: { category: string; share: number }[]; label?: string }) {
  return (
    <>
      <div class="las-mix" role="img" aria-label={`${label}: ${parts.map((p) => `${p.category} ${p.share}%`).join(", ")}`}>
        {parts.map((p, i) => (
          <i key={p.category} class={`las-d${i % 8}`} style={{ width: `${p.share}%` }} />
        ))}
      </div>
      <div class="las-legend">
        {parts.map((p, i) => (
          <span key={p.category}>
            <i class={`las-d${i % 8}`} />
            {p.category} <b>{p.share}%</b>
          </span>
        ))}
      </div>
    </>
  );
}

export function Steps({ steps, done }: { steps: string[]; done: number }) {
  return (
    <ul class="las-steps" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={i} class={i < done ? "done" : ""}>
          <i aria-hidden="true" />
          <span>{s}</span>
          {i < done ? <span class="las-sr">done</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function Field({ id, label, placeholder, value, onInput, onSubmit, button, enterkeyhint }: { id: string; label: string; placeholder?: string; value?: string; onInput?: (v: string) => void; onSubmit?: (v: string) => void; button?: string; enterkeyhint?: string }) {
  return (
    <form
      class="las-field"
      autocomplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const input = (e.currentTarget as HTMLFormElement).querySelector("input") as HTMLInputElement | null;
        onSubmit?.(input?.value ?? "");
      }}
    >
      <input id={id} aria-label={label} placeholder={placeholder} value={value ?? ""} enterkeyhint={enterkeyhint as any} onInput={(e) => onInput?.((e.currentTarget as HTMLInputElement).value)} />
      {button ? (
        <Button primary type="submit">
          {button}
        </Button>
      ) : null}
    </form>
  );
}

export function KeyValues({ items }: { items: [string, string | number][] }) {
  return (
    <dl class="las-kv">
      {items.map(([k, v]) => (
        <>
          <dt key={`k${k}`}>{k}</dt>
          <dd key={`v${k}`}>{v}</dd>
        </>
      ))}
    </dl>
  );
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div class="las-stat">
      <b class="las-mono">{value}</b>
      <span>{label}</span>
    </div>
  );
}

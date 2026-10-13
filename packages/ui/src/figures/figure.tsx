import type { Figure as FigureSpec } from "@las/schema";
import { Chart } from "./chart.js";

/** Draws any figure kind as SVG. Strokes, fills and corners come from the theme's `figures` tokens (CSS). */
export function Figure({ figure, label }: { figure: FigureSpec; label?: string }) {
  switch (figure.kind) {
    case "figure":
      return <StickFigure points={figure.points} segments={figure.segments} marks={figure.marks} label={label} />;
    case "graph":
      return <Graph nodes={figure.nodes} edges={figure.edges} direction={figure.direction} label={label} />;
    case "mermaid":
      return <Mermaid source={figure.source} label={label} />;
    case "rhythm":
      return <Rhythm pattern={figure.pattern} subdivisions={figure.subdivisions} highlight={figure.highlight} label={label} />;
    case "code":
      return <Code source={figure.source} trace={figure.trace} />;
    case "chart":
      return <Chart type={figure.type} series={figure.series} labels={figure.labels} />;
    case "contour":
      return <Contour values={figure.values} label={figure.label ?? label} />;
    case "space":
      return <Space axes={figure.axes} points={figure.points} />;
    case "notation":
      return <Notation abc={figure.abc} />;
    case "media":
      return <Media figure={figure} />;
    case "mechanism":
      return <Mechanism concept={figure.concept} />;
  }
}

export function Hatch() {
  return (
    <defs>
      <pattern id="las-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line class="hatch-line" x1="0" y1="0" x2="0" y2="6" />
      </pattern>
    </defs>
  );
}

export function StickFigure({ points, segments, marks = [], label }: { points: Record<string, [number, number]>; segments: [string, string][]; marks?: { at: string; label: string; role: "good" | "attention" | "reference" | "neutral" }[]; label?: string }) {
  return (
    <svg class="las-fig" viewBox="0 0 100 100" role="img" aria-label={label ?? "Figure"}>
      <Hatch />
      {segments.map(([a, b], i) => {
        const pa = points[a];
        const pb = points[b];
        if (!pa || !pb) return null;
        return <line key={i} class="stroke" x1={pa[0]} y1={pa[1]} x2={pb[0]} y2={pb[1]} />;
      })}
      {Object.entries(points).map(([id, [x, y]]) => (
        <circle key={id} class="dot" cx={x} cy={y} r="2.2" />
      ))}
      {marks.map((m, i) => {
        const p = points[m.at];
        if (!p) return null;
        return (
          <g key={i}>
            <circle class={`${m.role}`} cx={p[0]} cy={p[1]} r="6" />
            <text class="label" x={p[0] + 8} y={p[1] + 3}>
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function layoutGraph(nodes: { id: string; label: string }[], edges: [string, string][], direction: "LR" | "TB") {
  // simple layered layout: longest path from sources
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const [a, b] of edges) incoming.get(b)?.push(a);
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = Math.max(0, ...(incoming.get(id) ?? []).map((p) => d(p, seen) + 1));
    depth.set(id, v);
    return v;
  };
  nodes.forEach((n) => d(n.id));
  const layers = new Map<number, string[]>();
  for (const n of nodes) {
    const k = depth.get(n.id) ?? 0;
    layers.set(k, [...(layers.get(k) ?? []), n.id]);
  }
  const L = layers.size;
  const pos = new Map<string, [number, number]>();
  for (const [k, ids] of layers) {
    ids.forEach((id, i) => {
      const a = L === 1 ? 50 : 12 + (k * 76) / (L - 1);
      const b = ids.length === 1 ? 50 : 12 + (i * 76) / (ids.length - 1);
      pos.set(id, direction === "LR" ? [a, b] : [b, a]);
    });
  }
  return pos;
}

export function Graph({ nodes, edges, direction = "LR", label }: { nodes: { id: string; label: string }[]; edges: [string, string][]; direction?: "LR" | "TB"; label?: string }) {
  const pos = layoutGraph(nodes, edges, direction);
  return (
    <svg class="las-fig" viewBox="0 0 100 100" role="img" aria-label={label ?? `Diagram: ${nodes.map((n) => n.label).join(", ")}`}>
      <defs>
        <marker id="las-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="currentColor" />
        </marker>
      </defs>
      {edges.map(([a, b], i) => {
        const pa = pos.get(a);
        const pb = pos.get(b);
        if (!pa || !pb) return null;
        const dx = pb[0] - pa[0];
        const dy = pb[1] - pa[1];
        const len = Math.hypot(dx, dy) || 1;
        const r = 9;
        return <line key={i} class="muted" x1={pa[0] + (dx / len) * r} y1={pa[1] + (dy / len) * r} x2={pb[0] - (dx / len) * r} y2={pb[1] - (dy / len) * r} marker-end="url(#las-arrow)" />;
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id)!;
        return (
          <g key={n.id}>
            <rect class="node" x={p[0] - 11} y={p[1] - 6} width="22" height="12" rx="2" />
            <text class="label ink" x={p[0]} y={p[1] + 1.6} text-anchor="middle" font-size="4">
              {n.label.length > 11 ? n.label.slice(0, 10) + "…" : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Mermaid flowcharts: the common `graph LR; a[Label] --> b` subset is drawn natively; anything else shows as code. */
export function Mermaid({ source, label }: { source: string; label?: string }) {
  const m = /^\s*(?:graph|flowchart)\s+(LR|TB|TD|RL|BT)/i.exec(source);
  if (m) {
    const dir = /LR|RL/i.test(m[1]) ? "LR" : "TB";
    const nodes = new Map<string, string>();
    const edges: [string, string][] = [];
    const body = source.replace(/^\s*(?:graph|flowchart)\s+\w+\s*;?/i, "");
    for (const stmt of body.split(/[;\n]/)) {
      const parts = stmt.split(/-->|-\.->|==>/).map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      const ids: string[] = [];
      for (const p of parts) {
        const mm = /^([\w.-]+)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?/.exec(p);
        if (!mm) continue;
        const lbl = (mm[2] ?? mm[3] ?? mm[4] ?? mm[1]).replace(/<br\s*\/?>/gi, " ").replace(/"/g, "");
        if (!nodes.has(mm[1]) || mm[2] || mm[3] || mm[4]) nodes.set(mm[1], lbl);
        ids.push(mm[1]);
      }
      for (let i = 1; i < ids.length; i++) edges.push([ids[i - 1], ids[i]]);
    }
    if (nodes.size) return <Graph nodes={[...nodes].map(([id, l]) => ({ id, label: l }))} edges={edges} direction={dir} label={label} />;
  }
  return <pre class="las-code" aria-label={label ?? "Diagram source"}>{source}</pre>;
}

export function Rhythm({ pattern, subdivisions = 8, highlight = [], label }: { pattern: string; subdivisions?: number; highlight?: number[]; label?: string }) {
  const cells = pattern.split("").slice(0, subdivisions);
  const w = 100 / Math.max(cells.length, 1);
  return (
    <svg class="las-fig" viewBox="0 0 100 36" role="img" aria-label={label ?? `Rhythm ${pattern}`}>
      {cells.map((c, i) => {
        const on = c !== "_" && c !== "." && c !== " ";
        const up = /u/i.test(c);
        return (
          <g key={i}>
            <rect class={highlight.includes(i) ? "accent" : "faint"} x={i * w + 1} y="4" width={w - 2} height="24" rx="1.5" />
            {on ? <path class="fill" d={up ? `M${i * w + w / 2} 8 l4 8 h-8z` : `M${i * w + w / 2} 24 l4 -8 h-8z`} /> : null}
            <text class="label" x={i * w + w / 2} y="34" text-anchor="middle" font-size="4">
              {i % (subdivisions / 4) === 0 ? String(Math.floor(i / (subdivisions / 4)) + 1) : "&"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Code({ source, trace, line }: { source: string; trace?: { line: number; vars: Record<string, string> }[]; line?: number }) {
  const lines = source.split("\n");
  const on = line ?? trace?.[0]?.line;
  return (
    <div class="las-stack">
      <pre class="las-code" aria-label="Code">
        {lines.map((l, i) => (
          <span key={i} class={["las-line", on === i + 1 && "on"].filter(Boolean).join(" ")}>
            {l || " "}
          </span>
        ))}
      </pre>
      {trace && trace.length ? (
        <dl class="las-kv" aria-label="Variables">
          {Object.entries(trace.find((t) => t.line === on)?.vars ?? trace[0].vars).map(([k, v]) => (
            <>
              <dt key={`k${k}`}>{k}</dt>
              <dd key={`v${k}`}>{v}</dd>
            </>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function Contour({ values, label, reference }: { values: number[]; label?: string; reference?: number[] }) {
  const path = (v: number[]) => {
    const min = Math.min(...v, ...(reference ?? []));
    const max = Math.max(...v, ...(reference ?? []));
    const span = max - min || 1;
    return v.map((y, i) => `${i === 0 ? "M" : "L"}${(i / (v.length - 1)) * 100} ${50 - ((y - min) / span) * 40 + 0}`).join(" ");
  };
  return (
    <svg class="las-fig" viewBox="0 0 100 60" role="img" aria-label={label ?? "Pitch contour"}>
      <line class="faint" x1="0" y1="52" x2="100" y2="52" />
      {reference ? <path class="reference" d={path(reference)} /> : null}
      <path class="accent" d={path(values)} />
      {label ? (
        <text class="label" x="2" y="58" font-size="4">
          {label}
        </text>
      ) : null}
    </svg>
  );
}

export function Space({ axes, points }: { axes: [string, string]; points: { label: string; x: number; y: number; role: "good" | "attention" | "reference" | "neutral" }[] }) {
  return (
    <svg class="las-fig" viewBox="0 0 100 100" role="img" aria-label={`${axes[0]} by ${axes[1]}: ${points.map((p) => p.label).join(", ")}`}>
      <rect class="box" x="8" y="4" width="88" height="84" rx="2" />
      <text class="label" x="52" y="97" text-anchor="middle" font-size="4">{axes[0]}</text>
      <text class="label" x="4" y="46" text-anchor="middle" font-size="4" transform="rotate(-90 4 46)">{axes[1]}</text>
      {points.map((p, i) => (
        <g key={i}>
          <circle class={`dot ${p.role}`} cx={8 + p.x * 88} cy={88 - p.y * 84} r="2.5" />
          <text class="label ink" x={8 + p.x * 88 + 3.5} y={88 - p.y * 84 + 1.5} font-size="4">{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** ABC notation drawn as a simple staff with note heads; the studio upgrades it with abcjs when loaded. */
export function Notation({ abc }: { abc: string }) {
  const body = abc.split("\n").filter((l) => !/^[A-Z]:/.test(l)).join(" ");
  const notes = body.match(/[A-Ga-g][,']*\d*/g) ?? [];
  const pitch = (n: string) => {
    const base = "CDEFGAB".indexOf(n[0].toUpperCase());
    const octave = (n[0] === n[0].toLowerCase() ? 7 : 0) + (n.includes("'") ? 7 : 0) - (n.includes(",") ? 7 : 0);
    return base + octave;
  };
  const w = Math.max(100, notes.length * 9 + 10);
  return (
    <svg class="las-fig las-notation" viewBox={`0 0 ${w} 40`} role="img" aria-label={`Notation: ${notes.join(" ")}`} data-abc={abc}>
      {[0, 1, 2, 3, 4].map((i) => (
        <line key={i} class="faint" x1="2" y1={10 + i * 5} x2={w - 2} y2={10 + i * 5} />
      ))}
      {notes.slice(0, 48).map((n, i) => {
        const y = 32 - (pitch(n) - 2) * 2.5;
        return <ellipse key={i} class="fill" cx={8 + i * 9} cy={y} rx="2.6" ry="1.8" transform={`rotate(-20 ${8 + i * 9} ${y})`} />;
      })}
    </svg>
  );
}

export function Media({ figure }: { figure: { ref: string; type: "video" | "audio" | "image"; ghost?: boolean } }) {
  const src = figure.ref.startsWith("http") || figure.ref.startsWith("/") || figure.ref.startsWith("data:") || figure.ref.startsWith("blob:") ? figure.ref : `/api/media/${figure.ref}`;
  if (figure.type === "image") return <img src={src} alt="Reference image" class="las-fig" />;
  if (figure.type === "audio") return <audio src={src} controls aria-label="Reference recording" />;
  return <video src={src} controls playsInline muted class="las-fig" aria-label="Reference clip" data-ghost={figure.ghost ? "true" : undefined} />;
}

/** A mechanism figure placeholder: the agent supplies a real figure (anatomy skill) when one exists; otherwise a labeled diagram. */
export function Mechanism({ concept }: { concept: string }) {
  return (
    <svg class="las-fig" viewBox="0 0 100 50" role="img" aria-label={`How it works: ${concept}`}>
      <rect class="box" x="2" y="4" width="96" height="42" rx="3" />
      <circle class="accent" cx="30" cy="25" r="12" />
      <path class="stroke" d="M42 25h16 M58 25l-4-4 M58 25l-4 4" />
      <rect class="node" x="62" y="15" width="30" height="20" rx="2" />
      <text class="label ink" x="50" y="44" text-anchor="middle" font-size="4.5">{concept}</text>
    </svg>
  );
}

import { useMemo, useState } from "preact/hooks";
import { parseExpr, evalWith, toNumber, type SimSpec, type Expr, type ExprFn, type Value } from "@las/schema";
import { Slider } from "./answers.js";

/** Functions a sim may use beyond the standard library. */
const SIM_FNS: Record<string, ExprFn> = {
  pi: () => Math.PI,
  tan: (a) => Math.tan(toNumber(a[0])),
  atan: (a) => Math.atan(toNumber(a[0])),
  atan2: (a) => Math.atan2(toNumber(a[0]), toNumber(a[1])),
  asin: (a) => Math.asin(toNumber(a[0])),
  acos: (a) => Math.acos(toNumber(a[0])),
  deg: (a) => (toNumber(a[0]) * 180) / Math.PI,
  rad: (a) => (toNumber(a[0]) * Math.PI) / 180,
  lerp: (a) => toNumber(a[0]) + (toNumber(a[1]) - toNumber(a[0])) * toNumber(a[2]),
  seq: (a) => {
    const n = Math.max(0, Math.min(256, Math.floor(toNumber(a[0]))));
    return Array.from({ length: n }, (_, i) => i);
  },
  range_list: (a) => {
    const lo = toNumber(a[0]);
    const hi = toNumber(a[1]);
    const n = Math.max(2, Math.min(256, Math.floor(toNumber(a[2] ?? 32))));
    return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  }
};

export interface SimModel {
  compiled: Record<string, Expr>;
  evaluate(params: Record<string, number>, extra?: Record<string, Value>): Record<string, number>;
}

export function compileSim(spec: SimSpec): SimModel {
  const compiled: Record<string, Expr> = {};
  for (const [k, src] of Object.entries(spec.formulas)) compiled[k] = parseExpr(src);
  return {
    compiled,
    evaluate(params, extra = {}) {
      const vars: Record<string, Value> = { ...params, ...extra };
      const out: Record<string, number> = { ...params };
      for (const [k, e] of Object.entries(compiled)) {
        try {
          const v = evalWith(e, vars, SIM_FNS);
          vars[k] = v;
          out[k] = toNumber(v);
        } catch {
          out[k] = NaN;
        }
      }
      return out;
    }
  };
}

function fmt(v: number, d = 0): string {
  return Number.isFinite(v) ? v.toFixed(d) : "–";
}

/** A declarative simulation: sliders, formulas, a figure and a live readout. Nothing in the spec runs as code. */
export function Sim({ spec, onInteract }: { spec: SimSpec; onInteract?: () => void }) {
  const model = useMemo(() => compileSim(spec), [spec]);
  const [params, setParams] = useState<Record<string, number>>(() => Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, p.default ?? (p.min + p.max) / 2])));
  const values = model.evaluate(params);
  return (
    <div class="las-sim" data-sim={spec.title}>
      {spec.prompt ? <p class="las-sub">{spec.prompt}</p> : null}
      <SimFigure spec={spec} model={model} params={params} values={values} />
      {Object.entries(spec.params).map(([k, p]) => (
        <label key={k}>
          <span>
            {p.label}: <b>{fmt(params[k], p.step && p.step < 1 ? 1 : 0)}{p.unit ? ` ${p.unit}` : ""}</b>
          </span>
          <Slider
            id={`sim-${k}`}
            label={p.label}
            min={p.min}
            max={p.max}
            step={p.step ?? (p.max - p.min) / 50}
            value={params[k]}
            format={() => ""}
            onInput={(v) => {
              setParams({ ...params, [k]: v });
              onInteract?.();
            }}
          />
        </label>
      ))}
      {spec.readout.length ? (
        <div class="las-readout" aria-live="polite">
          {spec.readout.map((r) => (
            <div key={r.value}>
              <b>
                {fmt(values[r.value], r.decimals)}
                {r.unit ? <small> {r.unit}</small> : null}
              </b>
              <span>{r.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SimFigure({ spec, model, params, values }: { spec: SimSpec; model: SimModel; params: Record<string, number>; values: Record<string, number> }) {
  const f = spec.figure;
  if (f.kind === "plot") {
    const p = spec.params[f.x];
    const xs = Array.from({ length: 40 }, (_, i) => p.min + ((p.max - p.min) * i) / 39);
    const series = f.series.map((name) => xs.map((x) => model.evaluate({ ...params, [f.x]: x })[name]));
    const all = series.flat().filter(Number.isFinite);
    const lo = Math.min(...all, 0);
    const hi = Math.max(...all, 1);
    const Y = (v: number) => 46 - ((v - lo) / (hi - lo || 1)) * 40;
    const X = (x: number) => 6 + ((x - p.min) / (p.max - p.min || 1)) * 90;
    return (
      <svg class="las-fig las-chart" viewBox="0 0 100 52" role="img" aria-label={`${f.series.join(", ")} against ${p.label}`}>
        <line class="axis" x1="6" y1="46" x2="96" y2="46" />
        <line class="axis" x1="6" y1="6" x2="6" y2="46" />
        {series.map((s, si) => (
          <path key={si} class={`line s${si % 5}`} d={xs.map((x, i) => `${i === 0 ? "M" : "L"}${X(x)} ${Y(s[i])}`).join(" ")} />
        ))}
        <line class="attention" x1={X(params[f.x])} y1="6" x2={X(params[f.x])} y2="46" />
        {f.series.map((name, si) => (
          <circle key={name} class={`s${si % 5}`} cx={X(params[f.x])} cy={Y(values[name])} r="2" />
        ))}
        <text class="label" x="96" y="51" text-anchor="end" font-size="3.5">{p.label}</text>
      </svg>
    );
  }
  if (f.kind === "bars") {
    const vals = f.values.map((v) => values[v] ?? params[v] ?? 0);
    const max = Math.max(1, ...vals.map(Math.abs));
    const w = 90 / vals.length;
    return (
      <svg class="las-fig las-chart" viewBox="0 0 100 52" role="img" aria-label={f.values.map((v, i) => `${v}: ${fmt(vals[i], 1)}`).join(", ")}>
        <line class="axis" x1="5" y1="44" x2="95" y2="44" />
        {vals.map((v, i) => (
          <g key={i}>
            <rect class={`bar s${i % 5}`} x={5 + i * w + 2} y={44 - (Math.abs(v) / max) * 36} width={w - 4} height={(Math.abs(v) / max) * 36} rx="0.8" />
            <text class="label" x={5 + i * w + w / 2} y="50" text-anchor="middle" font-size="3.5">{spec.params[f.values[i]]?.label ?? f.values[i]}</text>
          </g>
        ))}
      </svg>
    );
  }
  if (f.kind === "gauge") {
    const v = values[f.value] ?? params[f.value] ?? 0;
    const t = Math.max(0, Math.min(1, (v - f.min) / (f.max - f.min || 1)));
    const ang = Math.PI * (1 - t);
    const cx = 50;
    const cy = 48;
    const r = 38;
    const good = f.good ? [f.good[0], f.good[1]].map((g) => Math.PI * (1 - (g - f.min) / (f.max - f.min || 1))) : null;
    const arc = (a1: number, a2: number) => `M${cx + r * Math.cos(a1)} ${cy - r * Math.sin(a1)} A${r} ${r} 0 0 1 ${cx + r * Math.cos(a2)} ${cy - r * Math.sin(a2)}`;
    return (
      <svg class="las-fig" viewBox="0 0 100 56" role="img" aria-label={`${f.value}: ${fmt(v, 1)}`}>
        <path class="faint" d={arc(Math.PI, 0)} />
        {good ? <path class="good" d={arc(good[0], good[1])} /> : null}
        <line class="attention" x1={cx} y1={cy} x2={cx + (r - 4) * Math.cos(ang)} y2={cy - (r - 4) * Math.sin(ang)} />
        <circle class="dot" cx={cx} cy={cy} r="2" />
        <text class="label ink" x={cx} y="55" text-anchor="middle" font-size="5">{fmt(v, 1)}</text>
      </svg>
    );
  }
  if (f.kind === "linkage") {
    const pts: Record<string, [number, number]> = {};
    for (const [name, [xs, ys]] of Object.entries(f.points)) {
      const ex = model.compiled[`__x_${name}`] ?? parseExpr(xs);
      const ey = model.compiled[`__y_${name}`] ?? parseExpr(ys);
      const vars = { ...params, ...values };
      try {
        pts[name] = [toNumber(evalWith(ex, vars, SIM_FNS)), toNumber(evalWith(ey, vars, SIM_FNS))];
      } catch {
        pts[name] = [50, 50];
      }
    }
    return (
      <svg class="las-fig" viewBox="0 0 100 100" role="img" aria-label={`Figure: ${Object.keys(f.points).join(", ")}`}>
        {f.segments.map(([a, b], i) => (pts[a] && pts[b] ? <line key={i} class="stroke" x1={pts[a][0]} y1={pts[a][1]} x2={pts[b][0]} y2={pts[b][1]} /> : null))}
        {Object.entries(pts).map(([n, p]) => (
          <g key={n}>
            <circle class="dot" cx={p[0]} cy={p[1]} r="2" />
            {f.labels?.[n] ? <text class="label" x={p[0] + 3} y={p[1] - 2} font-size="4">{f.labels[n]}</text> : null}
          </g>
        ))}
      </svg>
    );
  }
  if (f.kind === "timeline") {
    let events: number[] = [];
    let length = 1;
    let ref: number[] = [];
    try {
      const vars = { ...params, ...values };
      events = (evalWith(parseExpr(f.events), vars, SIM_FNS) as any[]).map(toNumber);
      length = toNumber(evalWith(parseExpr(f.length), vars, SIM_FNS));
      if (f.reference) ref = (evalWith(parseExpr(f.reference), vars, SIM_FNS) as any[]).map(toNumber);
    } catch {
      /* shown empty */
    }
    return (
      <svg class="las-fig las-chart" viewBox="0 0 100 20" role="img" aria-label={`Timeline with ${events.length} events`}>
        <line class="axis" x1="4" y1="10" x2="96" y2="10" />
        {ref.map((t, i) => (
          <line key={`r${i}`} class="reference" x1={4 + (t / length) * 92} y1="4" x2={4 + (t / length) * 92} y2="16" />
        ))}
        {events.map((t, i) => (
          <circle key={i} class="ok" cx={4 + (t / length) * 92} cy="10" r="2.2" />
        ))}
      </svg>
    );
  }
  if (f.kind === "grid") {
    const e = parseExpr(f.cell);
    const cells: number[][] = [];
    let max = 1;
    for (let r = 0; r < f.rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < f.cols; c++) {
        let v = 0;
        try {
          v = toNumber(evalWith(e, { ...params, ...values, row: r, col: c }, SIM_FNS));
        } catch {
          v = 0;
        }
        row.push(v);
        max = Math.max(max, Math.abs(v));
      }
      cells.push(row);
    }
    const cw = 100 / f.cols;
    const ch = 100 / f.rows;
    return (
      <svg class="las-fig" viewBox="0 0 100 100" role="img" aria-label={`${f.rows} by ${f.cols} grid`}>
        {cells.map((row, r) => row.map((v, c) => <rect key={`${r}-${c}`} class="area" x={c * cw} y={r * ch} width={cw} height={ch} opacity={0.15 + 0.85 * (Math.abs(v) / max)} />))}
      </svg>
    );
  }
  return null;
}

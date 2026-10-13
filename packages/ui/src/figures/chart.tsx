/** Small charts drawn from the theme's data series. */
export function Chart({ type, series, labels, height = 50, label }: { type: "bar" | "line" | "dots"; series: { label: string; values: number[] }[]; labels?: string[]; height?: number; label?: string }) {
  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const y = (v: number) => height - 6 - ((v - min) / span) * (height - 12);
  return (
    <svg class="las-fig las-chart" viewBox={`0 0 100 ${height}`} role="img" aria-label={label ?? series.map((s) => `${s.label}: ${s.values.join(", ")}`).join("; ")}>
      <line class="axis" x1="4" y1={height - 6} x2="96" y2={height - 6} />
      {series.map((s, si) =>
        type === "line" ? (
          <path key={si} class={`line s${si % 5}`} d={s.values.map((v, i) => `${i === 0 ? "M" : "L"}${4 + (i / Math.max(n - 1, 1)) * 92} ${y(v)}`).join(" ")} />
        ) : type === "dots" ? (
          <g key={si}>
            {s.values.map((v, i) => (
              <circle key={i} class={`s${si % 5}`} cx={4 + (i / Math.max(n - 1, 1)) * 92} cy={y(v)} r="1.8" />
            ))}
          </g>
        ) : (
          <g key={si}>
            {s.values.map((v, i) => {
              const bw = 92 / n;
              const w = bw / series.length - 1;
              return <rect key={i} class={`bar s${si % 5}`} x={4 + i * bw + si * (w + 1)} y={y(v)} width={Math.max(w, 1)} height={Math.max(0, height - 6 - y(v))} rx="0.6" />;
            })}
          </g>
        )
      )}
      {labels?.map((l, i) => (
        <text key={i} class="label" x={4 + (i / Math.max(n - 1, 1)) * 92} y={height - 1} text-anchor="middle" font-size="3.5">
          {l}
        </text>
      ))}
    </svg>
  );
}

/** Events against a beat grid: offsets in ms per beat, colored by tolerance. */
export function BeatTimeline({ beats, offsetsMs, toleranceMs = 60, label }: { beats: number; offsetsMs: (number | null)[]; toleranceMs?: number; label?: string }) {
  const w = 100;
  const step = (w - 8) / Math.max(beats - 1, 1);
  const scale = 0.5 * step / Math.max(toleranceMs * 2, 1);
  return (
    <svg class="las-fig las-chart" viewBox="0 0 100 24" role="img" aria-label={label ?? `Timing: ${offsetsMs.map((o) => (o === null ? "miss" : `${Math.round(o)} ms`)).join(", ")}`}>
      <line class="axis" x1="4" y1="12" x2="96" y2="12" />
      {Array.from({ length: beats }, (_, i) => (
        <line key={i} class="axis" x1={4 + i * step} y1="6" x2={4 + i * step} y2="18" />
      ))}
      {offsetsMs.map((o, i) => {
        const x = 4 + i * step;
        if (o === null) return <circle key={i} class="bad" cx={x} cy="12" r="2" fill="none" />;
        const cls = Math.abs(o) <= toleranceMs / 2 ? "good" : Math.abs(o) <= toleranceMs ? "ok" : "bad";
        return <circle key={i} class={cls} cx={x + Math.max(-step / 2, Math.min(step / 2, o * scale))} cy="12" r="2.4" />;
      })}
      <text class="label" x="4" y="23" font-size="3.5">early</text>
      <text class="label" x="96" y="23" font-size="3.5" text-anchor="end">late</text>
    </svg>
  );
}

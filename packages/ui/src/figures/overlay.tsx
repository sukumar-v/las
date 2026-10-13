import { POSE_LANDMARKS } from "@las/schema";

/** Pose connections (MediaPipe body topology) by landmark name. */
export const POSE_CONNECTIONS: [string, string][] = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
  ["left_ankle", "left_heel"],
  ["left_heel", "left_foot_index"],
  ["right_ankle", "right_heel"],
  ["right_heel", "right_foot_index"],
  ["nose", "left_eye"],
  ["nose", "right_eye"],
  ["left_eye", "left_ear"],
  ["right_eye", "right_ear"]
];

export interface OverlayMark {
  kind: "line" | "arc" | "label" | "ghost" | "dot";
  role: "good" | "attention" | "reference" | "neutral";
  points?: [number, number][];
  at?: [number, number];
  text?: string;
  /** for arcs: the angle in degrees at the middle point */
  degrees?: number;
}

/** A skeleton and marks over a video frame; coordinates are normalized 0..1. */
export function PoseOverlay({ landmarks, marks = [], reference, label }: { landmarks?: Record<string, [number, number, number?]>; marks?: OverlayMark[]; reference?: Record<string, [number, number, number?]>; label?: string }) {
  const seg = (pts: Record<string, [number, number, number?]>, cls: string) =>
    POSE_CONNECTIONS.map(([a, b], i) => {
      const pa = pts[a];
      const pb = pts[b];
      if (!pa || !pb || (pa[2] ?? 1) < 0.3 || (pb[2] ?? 1) < 0.3) return null;
      return <line key={`${cls}${i}`} class={cls} x1={pa[0] * 100} y1={pa[1] * 100} x2={pb[0] * 100} y2={pb[1] * 100} />;
    });
  return (
    <svg class="las-fig las-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label ?? "Pose overlay"}>
      {reference ? seg(reference, "reference") : null}
      {landmarks ? seg(landmarks, "neutral") : null}
      {landmarks
        ? (POSE_LANDMARKS as readonly string[]).map((n) => {
            const p = landmarks[n];
            return p && (p[2] ?? 1) >= 0.3 ? <circle key={n} class="dot neutral" cx={p[0] * 100} cy={p[1] * 100} r="1.2" /> : null;
          })
        : null}
      {marks.map((m, i) => {
        if (m.kind === "line" && m.points) return <polyline key={i} class={m.role} points={m.points.map((p) => `${p[0] * 100},${p[1] * 100}`).join(" ")} />;
        if (m.kind === "arc" && m.points && m.points.length === 3) {
          const [a, b, c] = m.points.map((p) => [p[0] * 100, p[1] * 100]);
          const r = 7;
          const ang = (p: number[]) => Math.atan2(p[1] - b[1], p[0] - b[0]);
          const a1 = ang(a);
          const a2 = ang(c);
          const sweep = ((a2 - a1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          const large = Math.abs(sweep) > Math.PI ? 1 : 0;
          const p1 = [b[0] + r * Math.cos(a1), b[1] + r * Math.sin(a1)];
          const p2 = [b[0] + r * Math.cos(a2), b[1] + r * Math.sin(a2)];
          return (
            <g key={i}>
              <path class={m.role} d={`M${p1[0]} ${p1[1]} A${r} ${r} 0 ${large} ${sweep > 0 ? 1 : 0} ${p2[0]} ${p2[1]}`} />
              {m.degrees !== undefined ? (
                <text class="label ink" x={b[0] + r + 2} y={b[1] + 2} font-size="4">
                  {Math.round(m.degrees)}°
                </text>
              ) : null}
            </g>
          );
        }
        if (m.kind === "dot" && m.at) return <circle key={i} class={`dot ${m.role}`} cx={m.at[0] * 100} cy={m.at[1] * 100} r="2.2" />;
        if (m.kind === "label" && m.at)
          return (
            <text key={i} class="label ink" x={m.at[0] * 100} y={m.at[1] * 100} font-size="4">
              {m.text}
            </text>
          );
        return null;
      })}
    </svg>
  );
}

/**
 * Replay (evaluation §4.3): the learner's clip with the skeleton from the stored body points at the scrub time,
 * the engine's marks, markers that slow playback to 0.25× around a mistake, and compare toggles (the reference
 * ghost, or the learner's own earlier attempt side by side). Then one fix and one thing done well.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Replay, Card, Eyebrow, Hint, type OverlayMark } from "@las/ui";
import type { Analysis, FeedbackView } from "@las/schema";
import type { PoseFrame } from "@las/engines";
import { api } from "../api.js";
import { useT, useVoice } from "../theme.js";

type Landmarks = Record<string, [number, number, number?]>;

export interface ReplayData {
  analysis: Analysis;
  feedback?: FeedbackView;
  evidence?: any;
  mediaUrl?: string;
}

/** The body points nearest to time t. */
export function frameAt(frames: PoseFrame[] | undefined, t: number): PoseFrame | undefined {
  if (!frames?.length) return undefined;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const a = frames[Math.max(0, lo - 1)];
  const b = frames[lo];
  return Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
}

export function landmarksOf(f?: PoseFrame | { pose?: Record<string, number[]> }): Landmarks | undefined {
  const pose = (f as PoseFrame | undefined)?.pose;
  return pose ? Object.fromEntries(Object.entries(pose).map(([k, p]) => [k, [p[0], p[1], p[3] ?? 1] as [number, number, number]])) : undefined;
}

interface EngineMark {
  mistake: string;
  t: number;
  draw: string;
  coords: [number, number][];
  value?: number;
  ghost?: Record<string, [number, number, number]>;
}

/** The movement engine's drawing instructions near time t, as overlay marks in the theme's roles. */
export function overlayMarks(overlay: unknown, t: number, window = 0.6): { marks: OverlayMark[]; ghost?: Landmarks } {
  const o = overlay as { kind?: string; marks?: EngineMark[] } | undefined;
  const out: OverlayMark[] = [];
  let ghost: Landmarks | undefined;
  for (const m of o?.marks ?? []) {
    if (Math.abs(m.t - t) > window) continue;
    if (m.draw === "arc" && m.coords.length === 3) out.push({ kind: "arc", role: "attention", points: m.coords, degrees: m.value });
    else if (m.draw === "line" && m.coords.length >= 2) out.push({ kind: "line", role: "attention", points: m.coords });
    else if (m.coords.length) for (const c of m.coords) out.push({ kind: "dot", role: "attention", at: c });
    if (m.ghost) ghost = m.ghost;
  }
  return { marks: out, ghost };
}

/** A replay for an attempt; whatever isn't passed in (analysis, evidence, media) is loaded from the server. */
export function ReplayView({ attemptId, data, onTry, onReRecord }: { attemptId: string; data?: ReplayData; onTry?: (fb: FeedbackView) => void; onReRecord?: () => void }) {
  const voice = useVoice();
  const t = useT();
  const [d, setD] = useState<ReplayData | undefined>(data);
  const [time, setTime] = useState(0);
  const [compare, setCompare] = useState<"none" | "reference" | "previous">("none");
  const [prevMedia, setPrevMedia] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const video = useRef<HTMLVideoElement | null>(null);
  const prevVideo = useRef<HTMLVideoElement | null>(null);
  const slowUntil = useRef(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let cur = data;
        if (!cur?.feedback || !cur.analysis) {
          const fb = await api.feedback(attemptId);
          if (!fb.analysis) throw new Error(t("This attempt hasn't been analyzed yet."));
          cur = { ...(cur ?? {}), analysis: fb.analysis, feedback: fb.feedback } as ReplayData;
        }
        if (!cur.evidence && (cur.analysis.engine === "movement")) cur = { ...cur, evidence: (await api.attemptEvidence(attemptId).catch(() => ({ evidence: null }))).evidence ?? undefined };
        if (!cur.mediaUrl) cur = { ...cur, mediaUrl: api.mediaUrl(attemptId) };
        if (alive) setD(cur);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [attemptId]);

  const frames: PoseFrame[] | undefined = d?.evidence?.frames;
  const landmarks = useMemo(() => landmarksOf(frameAt(frames, time)), [frames, time]);
  const { marks, ghost } = useMemo(() => overlayMarks(d?.analysis.overlay, time), [d?.analysis.overlay, time]);

  if (error) return <Hint>{error}</Hint>;
  if (!d?.feedback) return <Hint>{t("Loading the replay…")}</Hint>;
  const visual = d.analysis.engine === "movement" || d.analysis.engine === "visual";

  const seek = (s: number) => {
    setTime(s);
    if (video.current) video.current.currentTime = s;
    if (prevVideo.current) prevVideo.current.currentTime = s;
  };
  const onMarker = (at: number) => {
    // slow to 0.25× around the marker so the moment is easy to see
    seek(Math.max(0, at - 0.75));
    slowUntil.current = at + 0.75;
    if (video.current) {
      video.current.playbackRate = 0.25;
      void video.current.play().catch(() => undefined);
    }
  };
  const media =
    d.analysis.engine === "movement" ? (
      <video
        ref={video}
        src={d.mediaUrl}
        muted
        playsInline
        preload="metadata"
        aria-label={t("Your clip")}
        onTimeUpdate={(e) => {
          const v = e.currentTarget as HTMLVideoElement;
          setTime(v.currentTime);
          if (slowUntil.current && v.currentTime > slowUntil.current) {
            v.playbackRate = 1;
            slowUntil.current = 0;
          }
          if (prevVideo.current && Math.abs(prevVideo.current.currentTime - v.currentTime) > 0.2) prevVideo.current.currentTime = v.currentTime;
        }}
        onClick={(e) => {
          const v = e.currentTarget as HTMLVideoElement;
          if (v.paused) void v.play().catch(() => undefined);
          else v.pause();
        }}
      />
    ) : d.analysis.engine === "visual" ? (
      <img src={d.mediaUrl} alt={t("Your photo")} />
    ) : undefined;

  const prevId = d.feedback.compare?.previousAttemptId;
  return (
    <div class="las-stack">
      <Replay
        analysis={d.analysis}
        feedback={d.feedback}
        media={media}
        landmarks={landmarks}
        reference={ghost}
        marks={marks}
        t={time}
        onScrub={seek}
        onMarker={onMarker}
        compare={compare}
        onCompare={(c) => {
          setCompare(c);
          if (c === "previous" && prevId) setPrevMedia(api.mediaUrl(prevId));
        }}
        onTry={() => onTry?.(d.feedback!)}
        onDispute={() => {
          if (d.feedback?.mistakeId) void api.event({ type: "attempt.disputed", attemptId, mistakeId: d.feedback.mistakeId, consentToTune: false }).catch(() => undefined);
        }}
        onReRecord={onReRecord}
        voice={voice}
      />
      {compare === "previous" && prevMedia && visual ? (
        <Card label={t("Your last try")}>
          <Eyebrow>{t("Your last try, at the same moment")}</Eyebrow>
          {d.analysis.engine === "movement" ? <video ref={prevVideo} src={prevMedia} muted playsInline preload="metadata" aria-label={t("Your last try")} class="las-fig" /> : <img src={prevMedia} alt={t("Your last try")} class="las-fig" />}
        </Card>
      ) : null}
      {(d.analysis.engine === "audio" || d.analysis.engine === "speech") && d.mediaUrl ? <audio controls src={d.mediaUrl} aria-label={t("Your recording")} class="las-fig" /> : null}
    </div>
  );
}

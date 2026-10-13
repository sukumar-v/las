/**
 * Capture for every engine, all through the shared Recording screen: camera with the live framing guide
 * (movement, visual), microphone with live meters and a metronome (audio, speech), an editor with a live
 * test list (code), key timing (interaction), motion sensors, and a small form (self-report).
 * The screen only collects evidence; `processCapture` measures it on the device afterwards.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Button, Card, Chip, Chips, Eyebrow, Hint, Note, Recording, type FramingState } from "@las/ui";
import { trackersFor, type MetricSpec } from "@las/schema";
import { framingCheck, detectOnsets, type PoseFrame } from "@las/engines";
import type { AttemptInfo } from "../api.js";
import { api, ApiError } from "../api.js";
import { useT, useVoice } from "../theme.js";
import { fixtureEvidence } from "../capture/fixture.js";
import { frameDifference, LIGHT_MIN, meanLuminance, MotionWindow, neededPoints, ReadyGate, STILL_DIFF_MAX } from "../capture/framing.js";
import { createTracker, type FrameTracker } from "../capture/trackers.js";
import { livePitch, playClicks, startMic, storedOutputDelay, TapTest, type MicCapture } from "../capture/audio.js";
import { listenMotion, motionAvailable, requestMotion, type MotionSample } from "../capture/sensor.js";
import { photoFrom, photoFromPixels, type Photo } from "../capture/visual.js";
import { runHere, runsInBrowser, starterFiles, testRows } from "../capture/code.js";
import type { Captured } from "../capture/pipeline.js";

export interface CaptureProps {
  info: AttemptInfo;
  onCaptured: (c: Captured) => void;
  /** set once the learner may move on (evidence ready); the session's main button reads it */
  captured?: boolean;
}

type Landmarks = Record<string, [number, number, number?]>;

const toLandmarks = (f?: PoseFrame): Landmarks | undefined => (f?.pose ? Object.fromEntries(Object.entries(f.pose).map(([k, p]) => [k, [p[0], p[1], p[3]] as [number, number, number]])) : undefined);

/** Reports which devices this browser could open, once permissions are known. */
function reportDevices(d: { camera?: boolean; microphone?: boolean; motion?: boolean }): void {
  api.devices({ camera: !!d.camera, microphone: !!d.microphone, motion: d.motion ?? motionAvailable() }).catch(() => undefined);
}

function ErrorNote({ error }: { error?: string }) {
  return error ? (
    <Note kind="warn" icon="warn">
      {error}
    </Note>
  ) : null;
}

function FileInput({ accept, inputRef, onFile, label }: { accept: string; inputRef: { current: HTMLInputElement | null }; onFile: (f: File) => void; label: string }) {
  return <input ref={inputRef} type="file" accept={accept} hidden aria-label={label} onChange={(e) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (f) onFile(f);
  }} />;
}

export function CaptureView(props: CaptureProps) {
  const engine = props.info.attempt.engine;
  switch (engine) {
    case "movement":
      return <MovementCapture {...props} />;
    case "audio":
    case "speech":
      return <MicCaptureView {...props} />;
    case "visual":
      return <PhotoCapture {...props} />;
    case "code":
      return <CodeCapture {...props} />;
    case "interaction":
      return <InteractionCapture {...props} />;
    case "sensor":
      return <SensorCapture {...props} />;
    case "game":
      return <GameCapture {...props} />;
    default:
      return <SelfReportCapture {...props} />;
  }
}

// ---------------------------------------------------------------------------------------------
// Movement: camera, live framing guide, record, landmarks per frame

function MovementCapture({ info, onCaptured }: CaptureProps) {
  const voice = useVoice();
  const t = useT();
  const spec = (info.spec ?? {}) as MetricSpec;
  const needed = useMemo(() => neededPoints(spec), [info.attempt.id]);
  const kinds = useMemo(() => (spec.kind === "metric" ? trackersFor(spec) : ["pose" as const]), [info.attempt.id]);
  const durationS = info.capture?.duration_s ?? spec.capture?.duration_s;
  const fx = useMemo(() => fixtureEvidence<{ frames: PoseFrame[]; fps: number; width: number; height: number }>("movement"), [info.attempt.id]);
  const video = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [framing, setFraming] = useState<FramingState | undefined>(undefined);
  const [landmarks, setLandmarks] = useState<Landmarks | undefined>(undefined);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const live = useRef({ stream: undefined as MediaStream | undefined, tracker: undefined as FrameTracker | undefined, frames: [] as PoseFrame[], rec: undefined as MediaRecorder | undefined, chunks: [] as Blob[], start: 0, raf: 0, recording: false, stopping: false });

  useEffect(() => {
    let alive = true;
    const L = live.current;
    const gate = new ReadyGate();
    const motion = new MotionWindow();
    const small = document.createElement("canvas");
    small.width = 48;
    small.height = 36;
    const g = small.getContext("2d", { willReadFrequently: true });
    let prev: Uint8ClampedArray | undefined;
    let light = true;
    let steadyByFrames = true;
    let n = 0;
    let lastUi = 0;
    const listener = motionAvailable() ? listenMotion((s) => motion.push(s.t * 1000, s.ax, s.ay, s.az)) : undefined;
    (async () => {
      try {
        setStatus("Starting the camera…");
        const wantAudio = spec.segment?.by === "phrases" || spec.segment?.beat_source === "audio_track";
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: wantAudio });
        if (!alive) return stream.getTracks().forEach((tr) => tr.stop());
        L.stream = stream;
        reportDevices({ camera: true, microphone: wantAudio });
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => undefined);
        }
        if (!fx) {
          setStatus("Loading body tracking (downloads once)…");
          L.tracker = await createTracker(kinds, (label, share) => setStatus(`Loading ${label} tracking: ${Math.round(share * 100)}%`));
        }
        setStatus(undefined);
      } catch (e) {
        reportDevices({ camera: false });
        setStatus(undefined);
        setError(`The camera didn't open (${(e as Error).message}). You can use a video file instead.`);
      }
    })();
    const tick = () => {
      if (!alive) return;
      const now = performance.now();
      const v = video.current;
      let frame: PoseFrame | undefined;
      if (fx?.frames.length) {
        const i = Math.floor(((now / 1000) * fx.fps) % fx.frames.length);
        frame = fx.frames[i];
      } else if (L.tracker && v && v.readyState >= 2) {
        try {
          frame = L.tracker.detect(v, now);
        } catch {
          frame = undefined;
        }
      }
      if (v && v.readyState >= 2 && g && n++ % 6 === 0) {
        g.drawImage(v, 0, 0, small.width, small.height);
        const px = g.getImageData(0, 0, small.width, small.height).data;
        light = meanLuminance(px, 1) >= LIGHT_MIN;
        steadyByFrames = prev ? frameDifference(px, prev, 1) <= STILL_DIFF_MAX : true;
        prev = new Uint8ClampedArray(px);
      }
      const fc = framingCheck(frame, needed);
      const total = fc.pointsVisible + fc.missing.length;
      // the fixture stands in for the camera, so its light and steadiness count as fine
      const steady = fx ? true : motion.has ? motion.steady() : steadyByFrames;
      const st = gate.update(now, { share: total ? fc.pointsVisible / total : 0, allVisible: fc.ready, light: fx ? true : light, steady });
      if (L.recording && frame) {
        const tt = (now - L.start) / 1000;
        L.frames.push({ ...frame, t: tt });
      }
      if (now - lastUi > 100) {
        lastUi = now;
        setFraming(st);
        setLandmarks(toLandmarks(frame));
        if (L.recording) {
          const el = (now - L.start) / 1000;
          setElapsed(el);
          if (durationS && el >= durationS) void stop();
        }
      }
      L.raf = requestAnimationFrame(tick);
    };
    L.raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(L.raf);
      listener?.stop();
      L.tracker?.close();
      L.stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [info.attempt.id]);

  const record = () => {
    const L = live.current;
    L.frames = [];
    L.chunks = [];
    L.start = performance.now();
    L.recording = true;
    L.stopping = false;
    if (L.stream) {
      try {
        L.rec = new MediaRecorder(L.stream);
        L.rec.ondataavailable = (e) => e.data.size && L.chunks.push(e.data);
        L.rec.start(500);
      } catch {
        L.rec = undefined;
      }
    }
    setElapsed(0);
    setRecording(true);
  };

  const stop = async () => {
    const L = live.current;
    if (!L.recording || L.stopping) return;
    L.stopping = true;
    L.recording = false;
    const blob = L.rec
      ? await new Promise<Blob>((resolve) => {
          L.rec!.onstop = () => resolve(new Blob(L.chunks, { type: L.rec!.mimeType || "video/webm" }));
          L.rec!.stop();
        })
      : undefined;
    setRecording(false);
    const v = video.current;
    const secs = Math.max(0.001, (performance.now() - L.start) / 1000);
    const evidence = fx ?? { frames: L.frames, fps: Math.max(1, Math.round(L.frames.length / secs)), width: v?.videoWidth || 640, height: v?.videoHeight || 480 };
    setDone(true);
    onCaptured({ engine: "movement", evidence, media: blob });
  };

  const fromFile = async (file: File) => {
    setError(undefined);
    if (fx) {
      setDone(true);
      return onCaptured({ engine: "movement", evidence: fx, media: file });
    }
    try {
      setStatus("Tracking the clip on this device…");
      const tracker = live.current.tracker ?? (await createTracker(kinds));
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.src = URL.createObjectURL(file);
      await v.play();
      const frames: PoseFrame[] = [];
      await new Promise<void>((resolve) => {
        const step = () => {
          if (v.ended || v.paused) return resolve();
          frames.push({ ...tracker.detect(v, v.currentTime * 1000), t: v.currentTime });
          requestAnimationFrame(step);
        };
        v.onended = () => resolve();
        requestAnimationFrame(step);
      });
      setStatus(undefined);
      setDone(true);
      onCaptured({ engine: "movement", evidence: { frames, fps: Math.max(1, Math.round(frames.length / Math.max(0.001, v.duration || 1))), width: v.videoWidth, height: v.videoHeight }, media: file });
    } catch (e) {
      setStatus(undefined);
      setError(`That clip couldn't be tracked: ${(e as Error).message}`);
    }
  };

  return (
    <Recording
      engine="movement"
      prompt={info.prompt ?? info.attempt.prompt ?? ""}
      how={info.how}
      angle={info.capture?.angle ?? spec.capture?.angle}
      durationS={durationS}
      framing={framing}
      recording={recording}
      elapsed={elapsed}
      onRecord={record}
      onStop={() => void stop()}
      onUpload={() => fileRef.current?.click()}
      landmarks={landmarks}
      media={<video ref={video} muted playsInline autoPlay aria-label={t("Camera preview")} />}
      voice={voice}
    >
      {status ? <Hint>{status}</Hint> : null}
      {done ? <Note icon="check">{t("Recorded. Check it when you're ready.")}</Note> : null}
      <ErrorNote error={error} />
      <FileInput accept="video/*" inputRef={fileRef} onFile={(f) => void fromFile(f)} label={t("Video file")} />
    </Recording>
  );
}

// ---------------------------------------------------------------------------------------------
// Audio and speech: microphone, metronome, live pitch needle and beat dots, the tap test

function referenceBeats(spec: any): number | undefined {
  const ref = spec?.reference;
  if (ref?.notes) return (ref.notes as [string, number][]).reduce((s, n) => s + n[1], 0);
  if (ref?.pattern) return (ref.bars ?? 4) * (ref.beats_per_bar ?? 4);
  return undefined;
}

function MicCaptureView({ info, onCaptured }: CaptureProps) {
  const voice = useVoice();
  const t = useT();
  const engine = info.attempt.engine as "audio" | "speech";
  const spec = info.spec ?? {};
  const fx = useMemo(() => fixtureEvidence(engine), [info.attempt.id]);
  const bpm: number | undefined = engine === "audio" && spec.playback !== "none" ? (spec.tempo ?? undefined) : undefined;
  const countIn = bpm ? 4 : 0;
  const refBeats = referenceBeats(spec);
  const durationS = info.capture?.duration_s ?? (bpm && refBeats ? Math.ceil(((countIn + refBeats) * 60) / bpm + 2) : engine === "speech" ? 15 : 30);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [meters, setMeters] = useState<{ level?: number; pitch?: { cents: number; note?: string }; beats?: { offsetsMs: (number | null)[]; beats: number } }>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const live = useRef({ mic: undefined as MicCapture | undefined, timer: 0 as unknown as ReturnType<typeof setInterval>, firstBeatS: 0, stopClicks: undefined as (() => void) | undefined, stopping: false });

  useEffect(() => () => {
    clearInterval(live.current.timer);
    live.current.stopClicks?.();
    void live.current.mic?.stop();
  }, []);

  const record = async () => {
    setError(undefined);
    const L = live.current;
    try {
      const mic = await startMic();
      reportDevices({ microphone: true });
      L.mic = mic;
      L.stopping = false;
      if (bpm) {
        const at = mic.ctx.currentTime + 0.3;
        const beats = countIn + Math.ceil(((durationS - 0.3) * bpm) / 60);
        L.stopClicks = playClicks(mic.ctx, bpm, at, beats);
        L.firstBeatS = at - mic.startTime + (countIn * 60) / bpm;
      }
      setRecording(true);
      setElapsed(0);
      const t0 = performance.now();
      let tick = 0;
      L.timer = setInterval(() => {
        const el = (performance.now() - t0) / 1000;
        setElapsed(el);
        const sr = mic.sampleRate;
        const m: typeof meters = { level: mic.level() };
        if (engine === "audio" || engine === "speech") m.pitch = livePitch(mic.tail(4096), sr);
        if (bpm && tick++ % 5 === 0) {
          const win = mic.tail(sr * 4);
          const winStart = el - win.length / sr;
          const onsets = detectOnsets(win, sr).map((o) => winStart + o);
          const period = 60 / bpm;
          const delay = (storedOutputDelay() ?? 0) / 1000;
          const offsets: (number | null)[] = [];
          for (let b = 0; b < 8; b++) {
            const bt = L.firstBeatS + b * period + delay;
            if (bt > el) break;
            const near = onsets.filter((o) => Math.abs(o - bt) <= period / 2).sort((a, c) => Math.abs(a - bt) - Math.abs(c - bt))[0];
            offsets.push(near === undefined ? null : Math.round((near - bt) * 1000));
          }
          m.beats = { beats: 8, offsetsMs: offsets };
        } else if (bpm) m.beats = meters.beats;
        setMeters(m);
        if (el >= durationS) void stop();
      }, 100);
    } catch (e) {
      reportDevices({ microphone: false });
      setError(`The microphone didn't open (${(e as Error).message}). You can use a recording instead.`);
    }
  };

  const stop = async () => {
    const L = live.current;
    if (!L.mic || L.stopping) return;
    L.stopping = true;
    clearInterval(L.timer);
    L.stopClicks?.();
    const r = await L.mic.stop();
    L.mic = undefined;
    setRecording(false);
    setDone(true);
    const click = bpm ? { bpm, firstBeatS: L.firstBeatS } : undefined;
    const evidence = fx ?? (engine === "audio" ? { sampleRate: r.sampleRate, samples: r.samples, outputDelayMs: storedOutputDelay(), click } : { samples: r.samples, sampleRate: r.sampleRate, durationS: r.samples.length / r.sampleRate });
    onCaptured({ engine, evidence, media: r.blob });
  };

  const fromFile = async (file: File) => {
    setError(undefined);
    try {
      if (fx) {
        setDone(true);
        return onCaptured({ engine, evidence: fx, media: file });
      }
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const samples = new Float32Array(buf.getChannelData(0));
      setDone(true);
      onCaptured({ engine, evidence: engine === "audio" ? { sampleRate: buf.sampleRate, samples, outputDelayMs: storedOutputDelay() } : { samples, sampleRate: buf.sampleRate, durationS: buf.duration }, media: file });
    } catch (e) {
      setError(`That recording couldn't be read: ${(e as Error).message}`);
    }
  };

  return (
    <Recording engine={engine} prompt={info.prompt ?? info.attempt.prompt ?? ""} how={info.how} durationS={durationS} recording={recording} elapsed={elapsed} onRecord={() => void record()} onStop={() => void stop()} onUpload={() => fileRef.current?.click()} meters={recording ? meters : undefined} voice={voice}>
      {engine === "speech" && spec.target ? (
        <Card label={t("Say this")}>
          <Eyebrow>{t("Say this")}</Eyebrow>
          <div class="las-prompt">{spec.target}</div>
        </Card>
      ) : null}
      {engine === "audio" && bpm ? <TapCalibration /> : null}
      {done ? <Note icon="check">{t("Recorded. Check it when you're ready.")}</Note> : null}
      <ErrorNote error={error} />
      <FileInput accept="audio/*,video/*" inputRef={fileRef} onFile={(f) => void fromFile(f)} label={t("Audio file")} />
    </Recording>
  );
}

/** The 10-second tap test, once per device: how late this device's speakers or headphones are. */
function TapCalibration() {
  const t = useT();
  const [delay, setDelay] = useState<number | undefined>(() => storedOutputDelay());
  const [running, setRunning] = useState(false);
  const [taps, setTaps] = useState(0);
  const test = useRef<TapTest | undefined>(undefined);
  const start = async () => {
    const tt = new TapTest();
    test.current = tt;
    setTaps(0);
    setRunning(true);
    await tt.start();
    setTimeout(async () => {
      const r = await tt.finish();
      setRunning(false);
      if (r) setDelay(Math.round(r.delayMs));
    }, tt.durationMs);
  };
  return (
    <Card label={t("Output delay")}>
      <div class="las-row">
        <Eyebrow>{t("Headphone delay")}</Eyebrow>
        <span class="las-mono">{delay === undefined ? t("not measured") : `${delay} ms`}</span>
      </div>
      {running ? (
        <button type="button" class="las-pad-btn" aria-label={t("Tap with each click")} onPointerDown={() => setTaps(test.current?.tap() ?? 0)}>
          {taps || t("TAP")}
        </button>
      ) : (
        <Button icon="music" onClick={() => void start()}>
          {delay === undefined ? t("Measure it (10 s)") : t("Measure again")}
        </Button>
      )}
      <Hint>{t("Tap along with the clicks. Timing results subtract this delay.")}</Hint>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Visual: a photo (camera or file), downscaled; the points the rubric asks the learner to tap

function PhotoCapture({ info, onCaptured }: CaptureProps) {
  const voice = useVoice();
  const t = useT();
  const spec = info.spec ?? {};
  const taps: { id: string; prompt: string }[] = spec.taps ?? [];
  const fx = useMemo(() => fixtureEvidence<{ width: number; height: number; pixels: { width: number; height: number; data: Uint8ClampedArray } }>("visual"), [info.attempt.id]);
  const video = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [photo, setPhoto] = useState<Photo | undefined>(undefined);
  const [tapped, setTapped] = useState<Record<string, [number, number]>>({});
  const [framing, setFraming] = useState<FramingState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let raf = 0;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false });
        if (!alive) return s.getTracks().forEach((tr) => tr.stop());
        stream.current = s;
        reportDevices({ camera: true });
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => undefined);
        }
      } catch (e) {
        reportDevices({ camera: false });
        setError(`The camera didn't open (${(e as Error).message}). You can choose a photo instead.`);
      }
    })();
    const small = document.createElement("canvas");
    small.width = 48;
    small.height = 36;
    const g = small.getContext("2d", { willReadFrequently: true });
    let prev: Uint8ClampedArray | undefined;
    let last = 0;
    const tick = (now: number) => {
      if (!alive) return;
      const v = video.current;
      if (now - last > 200 && v && v.readyState >= 2 && g) {
        last = now;
        g.drawImage(v, 0, 0, small.width, small.height);
        const px = g.getImageData(0, 0, small.width, small.height).data;
        const light = fx ? true : meanLuminance(px, 1) >= LIGHT_MIN;
        const steady = fx ? true : prev ? frameDifference(px, prev, 1) <= STILL_DIFF_MAX : false;
        prev = new Uint8ClampedArray(px);
        setFraming({ pointsVisible: 1, light, steady, ready: light && steady, seconds: 0 });
      } else if (fx && !v?.readyState) setFraming({ pointsVisible: 1, light: true, steady: true, ready: true, seconds: 0 });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, [info.attempt.id]);

  const take = async (file?: File) => {
    setError(undefined);
    try {
      const p = fx ? await photoFromPixels({ width: fx.pixels.width, height: fx.pixels.height, data: fx.pixels.data }) : file ? await photoFrom(file) : video.current ? await photoFrom(video.current) : undefined;
      if (!p) return;
      setPhoto(p);
      setTapped({});
      if (!taps.length) onCaptured({ engine: "visual", evidence: { width: p.width, height: p.height, pixels: p.pixels }, media: p.blob });
    } catch (e) {
      setError(`That photo couldn't be read: ${(e as Error).message}`);
    }
  };

  const nextTap = taps.find((tp) => !tapped[tp.id]);
  const onTapImage = (e: MouseEvent) => {
    if (!nextTap || !photo) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pt: [number, number] = [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    const all = { ...tapped, [nextTap.id]: pt };
    setTapped(all);
    if (taps.every((tp) => all[tp.id])) onCaptured({ engine: "visual", evidence: { width: photo.width, height: photo.height, pixels: photo.pixels, taps: all }, media: photo.blob });
  };
  const skipTaps = () => photo && onCaptured({ engine: "visual", evidence: { width: photo.width, height: photo.height, pixels: photo.pixels, taps: tapped }, media: photo.blob });

  return (
    <Recording engine="visual" prompt={info.prompt ?? info.attempt.prompt ?? ""} how={info.how} framing={framing} onRecord={() => void take()} onUpload={() => fileRef.current?.click()} media={photo ? <img src={photo.url} alt={t("Your photo")} /> : <video ref={video} muted playsInline autoPlay aria-label={t("Camera preview")} />} voice={voice}>
      {photo && taps.length ? (
        <Card label={t("Tap points")}>
          <Eyebrow>{nextTap ? nextTap.prompt : t("All points tapped")}</Eyebrow>
          <button type="button" class="las-tapimg" aria-label={nextTap ? nextTap.prompt : t("Your photo")} onClick={onTapImage as any}>
            <img src={photo.url} alt="" />
            {Object.entries(tapped).map(([id, [x, y]]) => (
              <i key={id} class="las-tapdot" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} />
            ))}
          </button>
          {nextTap ? (
            <Button link onClick={skipTaps}>
              {t("Skip the taps")}
            </Button>
          ) : null}
        </Card>
      ) : null}
      {photo && !nextTap ? <Note icon="check">{t("Photo ready. Grading from the rubric arrives after the measurements.")}</Note> : null}
      <ErrorNote error={error} />
      <FileInput accept="image/*" inputRef={fileRef} onFile={(f) => void take(f)} label={t("Photo file")} />
    </Recording>
  );
}

// ---------------------------------------------------------------------------------------------
// Code: an editor, the browser sandbox or the server's runners, a live test list

function CodeCapture({ info, onCaptured }: CaptureProps) {
  const voice = useVoice();
  const t = useT();
  const spec = info.spec;
  const fx = useMemo(() => fixtureEvidence<{ files: Record<string, string> }>("code"), [info.attempt.id]);
  const [files, setFiles] = useState<Record<string, string>>(() => fx?.files ?? (spec ? starterFiles(spec) : {}));
  const [result, setResult] = useState<any>(undefined);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [consent, setConsent] = useState<{ runner: "local" | "container"; message: string } | undefined>(undefined);
  if (!spec) return <Note kind="warn">{t("This attempt has no test spec.")}</Note>;
  const browser = runsInBrowser(spec);

  const run = async (withConsent = false) => {
    setRunning(true);
    setError(undefined);
    try {
      let r: any;
      if (browser) r = await runHere(spec, files);
      else {
        const out = await api.codeRun({ spec, files, specId: info.attempt.specId, consent: withConsent || undefined });
        r = out.result;
      }
      setResult(r);
      setConsent(undefined);
      if (r?.error) setError(r.error);
      onCaptured({ engine: "code", evidence: { files, result: r } });
    } catch (e) {
      const data = (e as ApiError).data as { needsConsent?: boolean; runner?: "local" | "container" } | undefined;
      if (data?.needsConsent && data.runner) setConsent({ runner: data.runner, message: (e as Error).message });
      else setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Recording engine="code" prompt={info.prompt ?? info.attempt.prompt ?? ""} how={info.how} meters={{ tests: testRows(spec, result) }} voice={voice}>
      {Object.entries(files).map(([name, src]) => (
        <label key={name} class="las-stack">
          <span class="las-eyebrow">{name}</span>
          <textarea class="las-textarea" aria-label={name} spellcheck={false} autocapitalize="off" value={src} onInput={(e) => setFiles({ ...files, [name]: (e.currentTarget as HTMLTextAreaElement).value })} />
        </label>
      ))}
      <div class="las-inline">
        <Button primary icon="code" disabled={running} onClick={() => void run()}>
          {running ? t("checking") : t("runTests")}
        </Button>
        <span class="las-hint">{browser ? t(`Runs in this browser (${spec.language}).`) : t(`Runs with your ${spec.language} toolchain on this computer.`)}</span>
      </div>
      {consent ? (
        <Card label={t("Allow the runner")} role="alertdialog">
          <Eyebrow>{t("First run")}</Eyebrow>
          <p class="las-sub">{consent.message.split(".")[0]}.</p>
          <Hint>{consent.runner === "local" ? t("It runs on this computer without network access, in a temporary folder.") : t("It runs in a container with no network and a read-only copy of your files.")}</Hint>
          <div class="las-inline">
            <Button
              primary
              onClick={async () => {
                await api.consent(consent.runner, true).catch(() => undefined);
                await run(true);
              }}
            >
              {t("Allow and run")}
            </Button>
            <Button link onClick={() => setConsent(undefined)}>
              {t("Not now")}
            </Button>
          </div>
        </Card>
      ) : null}
      <ErrorNote error={error} />
    </Recording>
  );
}

// ---------------------------------------------------------------------------------------------
// Interaction: keystrokes against the task's content, with timestamps

function InteractionCapture({ info, onCaptured }: CaptureProps) {
  const voice = useVoice();
  const t = useT();
  const spec = info.spec ?? { content: [""] };
  const target: string = (spec.content ?? [""]).join("\n");
  const fx = useMemo(() => fixtureEvidence("interaction"), [info.attempt.id]);
  const [typed, setTyped] = useState("");
  const events = useRef<{ t: number; key?: string; expected?: string; correct?: boolean }[]>([]);
  const start = useRef<number | undefined>(undefined);
  const finish = () => {
    if (fx) return onCaptured({ engine: "interaction", evidence: fx });
    const dur = start.current ? (performance.now() - start.current) / 1000 : 0;
    onCaptured({ engine: "interaction", evidence: { events: events.current, durationS: Math.max(0.1, dur) } });
  };
  return (
    <Recording engine="interaction" prompt={info.prompt ?? info.attempt.prompt ?? ""} how={info.how} onRecord={finish} voice={voice}>
      <pre class="las-code">{target}</pre>
      <textarea
        class="las-textarea"
        aria-label={t("Type here")}
        spellcheck={false}
        autocapitalize="off"
        value={typed}
        onKeyDown={(e) => {
          const now = performance.now();
          start.current ??= now;
          const k = (e as KeyboardEvent).key;
          if (k.length !== 1 && k !== "Enter") return;
          const ch = k === "Enter" ? "\n" : k;
          const expected = target[typed.length];
          events.current.push({ t: (now - start.current) / 1000, key: ch, expected, correct: ch === expected });
        }}
        onInput={(e) => setTyped((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <Hint>{t("Press Record when you've finished typing.")}</Hint>
    </Recording>
  );
}

// ---------------------------------------------------------------------------------------------
// Sensor: motion samples from the phone

function SensorCapture({ info, onCaptured }: CaptureProps) {
  const voice = useVoice();
  const t = useT();
  const durationS = info.spec?.duration_s ?? 30;
  const fx = useMemo(() => fixtureEvidence("sensor"), [info.attempt.id]);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const live = useRef<{ stop(): MotionSample[] } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);
  const stop = () => {
    clearInterval(timer.current);
    const samples = live.current?.stop() ?? [];
    live.current = undefined;
    setRecording(false);
    onCaptured({ engine: "sensor", evidence: fx ?? { samples } });
  };
  const record = async () => {
    if (!fx && !(await requestMotion())) {
      reportDevices({ motion: false });
      return setError(t("Motion sensors aren't available here. Open this on your phone (Settings, pair a phone)."));
    }
    reportDevices({ motion: true });
    live.current = listenMotion();
    const t0 = performance.now();
    setRecording(true);
    timer.current = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      setElapsed(el);
      if (el >= durationS) stop();
    }, 200);
  };
  return (
    <Recording engine="sensor" prompt={info.prompt ?? info.attempt.prompt ?? ""} how={info.how ?? (info.spec?.placement ? t(`Phone: ${info.spec.placement}`) : undefined)} durationS={durationS} recording={recording} elapsed={elapsed} onRecord={() => void record()} onStop={stop} voice={voice}>
      <ErrorNote error={error} />
    </Recording>
  );
}

// ---------------------------------------------------------------------------------------------
// Game: the moves played; self-report: a short form

function GameCapture({ info, onCaptured }: CaptureProps) {
  const voice = useVoice();
  const t = useT();
  const [moves, setMoves] = useState("");
  return (
    <Recording engine="game" prompt={info.prompt ?? info.attempt.prompt ?? ""} how={info.how} onRecord={() => onCaptured({ engine: "game", evidence: fixtureEvidence("game") ?? { moves: moves.split(/[\s,]+/).filter(Boolean) } })} voice={voice}>
      <textarea class="las-textarea" aria-label={t("Moves")} value={moves} onInput={(e) => setMoves((e.currentTarget as HTMLTextAreaElement).value)} />
    </Recording>
  );
}

const FELT = ["Easy", "About right", "Hard"];

function SelfReportCapture({ info, onCaptured }: CaptureProps) {
  const t = useT();
  const fields: string[] = info.spec?.fields ?? ["minutes", "effort", "felt"];
  const [v, setV] = useState<Record<string, number | string | boolean>>({});
  const set = (k: string, val: number | string | boolean) => {
    const next = { ...v, [k]: val };
    setV(next);
    onCaptured({ engine: "self-report", evidence: fixtureEvidence("self-report") ?? { fields: next } });
  };
  const field = (k: string): ComponentChildren => {
    switch (k) {
      case "minutes":
      case "count":
        return (
          <label class="las-stack" key={k}>
            <span class="las-eyebrow">{t(k === "minutes" ? "Minutes" : "How many")}</span>
            <input class="las-textarea" type="number" min={0} inputMode="numeric" aria-label={t(k)} value={(v[k] as number) ?? ""} onInput={(e) => set(k, Number((e.currentTarget as HTMLInputElement).value))} />
          </label>
        );
      case "effort":
      case "pain":
        return (
          <div class="las-stack" key={k}>
            <span class="las-eyebrow">{t(k === "effort" ? "Effort, 1 to 10" : "Pain, 0 to 5")}</span>
            <Chips>
              {Array.from({ length: k === "effort" ? 10 : 6 }, (_, i) => (k === "effort" ? i + 1 : i)).map((n) => (
                <Chip key={n} label={String(n)} on={v[k] === n} onClick={() => set(k, n)} />
              ))}
            </Chips>
          </div>
        );
      case "felt":
        return (
          <div class="las-stack" key={k}>
            <span class="las-eyebrow">{t("How did it feel?")}</span>
            <Chips>
              {FELT.map((f) => (
                <Chip key={f} label={t(f)} on={v.felt === f} onClick={() => set("felt", f)} />
              ))}
            </Chips>
          </div>
        );
      case "done":
        return <Chip key={k} label={t("Done")} on={v.done === true} onClick={() => set("done", !(v.done === true))} />;
      case "note":
        return <textarea key={k} class="las-textarea" aria-label={t("Note")} value={(v.note as string) ?? ""} onInput={(e) => set("note", (e.currentTarget as HTMLTextAreaElement).value)} />;
      default:
        return null;
    }
  };
  return (
    <div class="las-stack">
      <div class="las-q">
        <h1 class="las-h1" tabIndex={-1}>
          {info.prompt ?? info.attempt.prompt}
        </h1>
        {info.spec?.criterion ? <p class="las-sub">{info.spec.criterion}</p> : null}
      </div>
      {fields.map(field)}
    </div>
  );
}

/**
 * Microphone capture on the device: an AudioWorklet (ScriptProcessor where worklets are missing) collects
 * Float32 samples at the context's rate while MediaRecorder keeps a compressed copy for replay. A WebAudio
 * metronome plays the spec's click; the 10-second tap test measures this device's output delay once.
 */
import { calibrateOutputDelay, detectPitchTrack, noteName } from "@las/engines";

const WORKLET = `class LasCapture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("las-capture", LasCapture);`;

export interface MicCapture {
  ctx: AudioContext;
  stream: MediaStream;
  sampleRate: number;
  /** context time when sample 0 was taken */
  startTime: number;
  /** root-mean-square level of the latest chunk, 0..1 */
  level(): number;
  /** the latest `n` samples */
  tail(n: number): Float32Array;
  stop(): Promise<{ samples: Float32Array; sampleRate: number; blob?: Blob }>;
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
}

/** Starts collecting samples from a microphone stream (opened here when not given). */
export async function startMic(existing?: MediaStream): Promise<MicCapture> {
  const stream = existing ?? (await openMic());
  const ctx = new AudioContext();
  await ctx.resume().catch(() => undefined);
  const src = ctx.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  let total = 0;
  let lvl = 0;
  const onChunk = (c: Float32Array) => {
    chunks.push(c);
    total += c.length;
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    lvl = Math.min(1, Math.sqrt(s / Math.max(1, c.length)) * 4);
  };
  let node: AudioNode;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const w = new AudioWorkletNode(ctx, "las-capture");
    w.port.onmessage = (e) => onChunk(e.data as Float32Array);
    node = w;
  } catch {
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    node = sp;
  }
  // a muted sink keeps the graph pulling without sending the microphone to the speakers
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  const startTime = ctx.currentTime;
  let rec: MediaRecorder | undefined;
  const blobs: Blob[] = [];
  try {
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && blobs.push(e.data);
    rec.start(500);
  } catch {
    rec = undefined;
  }
  return {
    ctx,
    stream,
    sampleRate: ctx.sampleRate,
    startTime,
    level: () => lvl,
    tail(n) {
      const out = new Float32Array(Math.min(n, total));
      let need = out.length;
      for (let i = chunks.length - 1; i >= 0 && need > 0; i--) {
        const c = chunks[i];
        const take = Math.min(need, c.length);
        out.set(c.subarray(c.length - take), need - take);
        need -= take;
      }
      return out;
    },
    async stop() {
      const blob = rec
        ? await new Promise<Blob>((resolve) => {
            rec!.onstop = () => resolve(new Blob(blobs, { type: rec!.mimeType || "audio/webm" }));
            rec!.stop();
          })
        : undefined;
      src.disconnect();
      node.disconnect();
      if (!existing) stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => undefined);
      return { samples: concat(chunks, total), sampleRate: ctx.sampleRate, blob };
    }
  };
}

/** Schedules metronome clicks on a context from `startAt` (context seconds); returns a stop function. */
export function playClicks(ctx: BaseAudioContext, bpm: number, startAt: number, beats: number, accentEvery = 4): () => void {
  const nodes: OscillatorNode[] = [];
  const period = 60 / bpm;
  for (let i = 0; i < beats; i++) {
    const t = startAt + i * period;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = i % accentEvery === 0 ? 1760 : 1320;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
    nodes.push(osc);
  }
  return () => nodes.forEach((n) => n.stop());
}

/** The live pitch needle: the newest stable pitch in the last chunk, as a note and cents off. */
export function livePitch(samples: Float32Array, sampleRate: number, tuning = 440): { note: string; cents: number } | undefined {
  if (samples.length < 2048) return undefined;
  const track = detectPitchTrack(samples, sampleRate);
  const last = [...track].reverse().find((p) => p.hz > 0);
  if (!last) return undefined;
  const n = noteName(last.hz, tuning);
  return { note: n.name, cents: n.cents };
}

const DELAY_KEY = "las.outputDelayMs";

/** The output delay measured on this device, if the tap test ran. */
export function storedOutputDelay(): number | undefined {
  try {
    const v = localStorage.getItem(DELAY_KEY);
    return v === null ? undefined : Number(v);
  } catch {
    return undefined;
  }
}

export function storeOutputDelay(ms: number): void {
  try {
    localStorage.setItem(DELAY_KEY, String(Math.round(ms)));
  } catch {
    /* private mode: measured again next time */
  }
}

/**
 * The 10-second tap test: plays a click and records when the learner taps along. Returns the device's
 * output delay (headphones, Bluetooth) to subtract from every timing result.
 */
export class TapTest {
  readonly bpm = 100;
  readonly beats = 16;
  private ctx?: AudioContext;
  private clickTimes: number[] = [];
  private taps: number[] = [];
  private stopClicks?: () => void;
  async start(): Promise<void> {
    this.ctx = new AudioContext();
    await this.ctx.resume().catch(() => undefined);
    const t0 = this.ctx.currentTime + 0.5;
    this.clickTimes = Array.from({ length: this.beats }, (_, i) => t0 + (i * 60) / this.bpm);
    this.taps = [];
    this.stopClicks = playClicks(this.ctx, this.bpm, t0, this.beats);
  }
  tap(): number {
    if (this.ctx) this.taps.push(this.ctx.currentTime);
    return this.taps.length;
  }
  get durationMs(): number {
    return ((this.beats * 60) / this.bpm) * 1000 + 800;
  }
  async finish(): Promise<{ delayMs: number; jitterMs: number } | undefined> {
    this.stopClicks?.();
    await this.ctx?.close().catch(() => undefined);
    if (this.taps.length < 4) return undefined;
    const r = calibrateOutputDelay(this.taps, this.clickTimes);
    if (!Number.isFinite(r.delayMs)) return undefined;
    storeOutputDelay(r.delayMs);
    return r;
  }
}

/**
 * Node-only adapter for whisper.cpp's command-line program (MIT), run as a separate process.
 * It is never required: the caller checks that a binary and a model exist and falls back to
 * another transcriber (or a typed transcript) when they don't.
 *
 * Flow: resample to 16 kHz mono, write a 16-bit WAV to a temp folder, run
 * `whisper-cli -m model -f file -l lang -of out -ojf` (full JSON with per-token times and
 * probabilities), read out.json, rebuild words from tokens, delete the folder. Older builds
 * (the `main` program) that lack `-ojf` or `-np` are retried with `-oj -ml 1`, which gives one
 * segment per word without probabilities.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resampleLinear } from "../audio/dsp.js";
import { isNoSpaceScript } from "./text.js";
import type { Transcriber, Transcript } from "./transcriber.js";

export interface WhisperCliOptions {
  /** path to whisper-cli (or the older `main`) */
  binary: string;
  /** path to a ggml model file */
  modelPath: string;
  /** default language code; "auto" detects */
  language?: string;
  threads?: number;
  timeoutMs?: number;
}

/** 16-bit PCM mono WAV at 16 kHz, the input whisper.cpp expects. */
export function encodeWav16k(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = resampleLinear(samples, sampleRate, 16000);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), true);
  return new Uint8Array(buf);
}

interface WhisperToken {
  text: string;
  offsets?: { from: number; to: number };
  p?: number;
}
interface WhisperSegment {
  text: string;
  offsets?: { from: number; to: number };
  tokens?: WhisperToken[];
}

/** Special tokens ([_BEG_], [_TT_42], <|endoftext|>) carry no words. */
const SPECIAL = /^\s*(\[_[A-Z]+_?\d*\]|<\|[^|]*\|>)\s*$/;

/** Words from whisper.cpp JSON (`-ojf` tokens, or `-oj` segments). */
export function parseWhisperJson(json: unknown): Transcript {
  const j = json as { result?: { language?: string }; transcription?: WhisperSegment[] };
  const segs = j.transcription ?? [];
  const text = segs.map((s) => s.text).join("").replace(/\s+/g, " ").trim();
  const words: Transcript["words"] = [];
  const hasTokens = segs.some((s) => s.tokens?.length);
  if (hasTokens) {
    type Acc = { word: string; start: number; end: number; ps: number[] };
    const flush = (c: Acc | null) => {
      if (c && c.word.trim()) words.push({ word: c.word.trim(), start: c.start, end: c.end, confidence: c.ps.length ? c.ps.reduce((a, b) => a + b, 0) / c.ps.length : NaN });
    };
    for (const s of segs) {
      let cur: Acc | null = null;
      for (const tok of s.tokens ?? []) {
        if (!tok.text || SPECIAL.test(tok.text)) continue;
        const from = (tok.offsets?.from ?? 0) / 1000;
        const to = (tok.offsets?.to ?? 0) / 1000;
        const isWordy = /[\p{L}\p{N}]/u.test(tok.text);
        if (/^\s/.test(tok.text) && !isWordy) {
          // punctuation after a space (" ¿", " -") ends the word; the next letters start a new one
          flush(cur);
          cur = null;
          continue;
        }
        const firstCh = tok.text.trimStart()[0] ?? "";
        const lastCh = cur ? cur.word.slice(-1) : "";
        // a new word starts at a space, and at every character of a script written without spaces
        const startsWord = !cur || /^\s/.test(tok.text) || isNoSpaceScript(firstCh) || isNoSpaceScript(lastCh);
        if (startsWord && isWordy) {
          flush(cur);
          cur = { word: tok.text, start: from, end: to, ps: tok.p !== undefined ? [tok.p] : [] };
        } else if (cur) {
          // sub-word pieces and punctuation join the current word
          cur.word += tok.text;
          cur.end = Math.max(cur.end, to);
          if (tok.p !== undefined && isWordy) cur.ps.push(tok.p);
        }
      }
      flush(cur);
    }
  } else {
    for (const s of segs) {
      const from = (s.offsets?.from ?? 0) / 1000;
      const to = (s.offsets?.to ?? 0) / 1000;
      const pieces: string[] = [];
      for (const chunk of s.text.trim().split(/\s+/).filter(Boolean)) {
        if (Array.from(chunk).some(isNoSpaceScript)) pieces.push(...Array.from(chunk));
        else pieces.push(chunk);
      }
      const d = pieces.length ? (to - from) / pieces.length : 0;
      pieces.forEach((w, i) => words.push({ word: w, start: from + i * d, end: from + (i + 1) * d, confidence: NaN }));
    }
  }
  return { text, ...(j.result?.language ? { language: j.result.language } : {}), words };
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ENOENT") return reject(new Error(`whisper binary not found: ${binary}`));
      resolve({ code: !err ? 0 : typeof code === "number" ? code : 1, stderr: String(stderr ?? "") });
    });
  });
}

const ARG_ERROR = /unknown argument|unrecognized|invalid (option|argument)|usage:/i;

export function whisperCliTranscriber(opts: WhisperCliOptions): Transcriber {
  return {
    id: `whisper-cli:${basename(opts.modelPath)}`,
    async transcribe(samples, sampleRate, language) {
      const dir = mkdtempSync(join(tmpdir(), "las-whisper-"));
      try {
        const wav = join(dir, "input.wav");
        writeFileSync(wav, encodeWav16k(samples, sampleRate));
        const out = join(dir, "out");
        const lang = language ?? opts.language ?? "auto";
        const base = ["-m", opts.modelPath, "-f", wav, "-l", lang, "-of", out, ...(opts.threads ? ["-t", String(opts.threads)] : [])];
        // newest flags first; older builds reject unknown flags with a usage message
        const attempts = [
          [...base, "-np", "-ojf"],
          [...base, "-ojf"],
          [...base, "-np", "-oj", "-ml", "1"],
          [...base, "-oj", "-ml", "1"]
        ];
        let lastErr = "";
        for (const args of attempts) {
          const r = await run(opts.binary, args, opts.timeoutMs ?? 120_000);
          const file = [`${out}.json`, `${wav}.json`].find((f) => existsSync(f));
          if (r.code === 0 && file) return parseWhisperJson(JSON.parse(readFileSync(file, "utf8")));
          lastErr = r.stderr.trim() || `exit code ${r.code}`;
          if (r.code !== 0 && !ARG_ERROR.test(r.stderr)) break;
        }
        throw new Error(`whisper-cli failed: ${lastErr.slice(0, 400)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

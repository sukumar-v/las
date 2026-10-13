import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SpeechSpecSchema, type SpeechSpec } from "@las/schema";
import { analyzeSpeech, classifyToneContour, findFillers, segmentSyllables, speechTokens, textSimilarity, transcriptFromText } from "../src/speech/index.js";
import { encodeWav16k, parseWhisperJson, whisperCliTranscriber } from "../src/speech/whisper-cli.js";
import { silence, synthTone } from "../src/audio/synth.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/speech");
const spec = (s: Record<string, unknown>): SpeechSpec => SpeechSpecSchema.parse(s);
const words = (list: [string, number, number, number?][]) => list.map(([word, start, end, confidence]) => ({ word, start, end, confidence: confidence ?? 0.9 }));

/** A glide from one pitch to another through optional middle points, sampled every 10 ms. */
function contour(points: number[], seconds = 0.3): number[] {
  const n = Math.round(seconds / 0.01);
  return Array.from({ length: n }, (_, i) => {
    const x = (i / (n - 1)) * (points.length - 1);
    const k = Math.min(points.length - 2, Math.floor(x));
    const f = x - k;
    return points[k] * (points[k + 1] / points[k]) ** f;
  });
}

describe("text similarity, any language", () => {
  it("scores identical, partial and garbled text", () => {
    expect(textSimilarity("The quick brown fox.", "the QUICK brown fox")).toBe(1);
    expect(textSimilarity("the quick brown fox", "the quick fox")).toBeCloseTo(0.75, 6);
    expect(textSimilarity("the quick brown fox", "a slow red cat jumps")).toBeLessThan(0.25);
    expect(textSimilarity("", "")).toBe(1);
    expect(textSimilarity("¿Dónde está la estación?", "donde esta la estacion")).toBeGreaterThan(0.5);
    expect(textSimilarity("don't stop", "dont stop")).toBe(1);
  });

  it("compares scripts without spaces character by character", () => {
    expect(speechTokens("我想喝水。")).toEqual(["我", "想", "喝", "水"]);
    expect(textSimilarity("我想喝水", "我想喝茶")).toBeCloseTo(0.75, 6);
    expect(textSimilarity("わたしはがくせいです", "わたしは がくせい です")).toBe(1);
    expect(speechTokens("iPhone新款")).toEqual(["iphone", "新", "款"]);
    expect(speechTokens("สวัสดีครับ").length).toBe(Array.from("สวัสดีครับ").length);
    expect(textSimilarity("안녕하세요 반갑습니다", "안녕하세요 반갑습니다")).toBe(1);
  });
});

describe("pace, pauses and fillers", () => {
  const tr = {
    text: "so um I think uh we should ummm go",
    words: words([
      ["so", 0.5, 0.7],
      ["um", 0.8, 1.0],
      ["I", 1.1, 1.2],
      ["think", 1.25, 1.5],
      ["uh", 2.3, 2.5], // 0.8 s pause before
      ["we", 2.6, 2.75],
      ["should", 2.8, 3.1],
      ["ummm", 3.2, 3.6],
      ["go", 4.2, 4.5] // 0.6 s pause before
    ])
  };
  const a = analyzeSpeech(spec({ language: "en", prompt: "What should we do?", mistakes: [{ id: "fillers", when: "filler_count >= 2" }, { id: "slow", when: "words_per_minute < 60" }] }), { transcript: tr, durationS: 5 });

  it("measures pace, pauses and fillers from word times", () => {
    expect(a.metrics.words_per_minute.value).toBeCloseTo(9 / (4 / 60), 6);
    expect(a.metrics.pause_count.value).toBe(2);
    expect(a.metrics.pause_share.value).toBeCloseTo(1.4 / 4, 6);
    expect(a.metrics.filler_count.value).toBe(3);
    expect(a.metrics.duration_s.value).toBe(5);
    expect(a.metrics.mean_word_confidence.value).toBeCloseTo(0.9, 6);
    expect(a.mistakes.map((m) => m.id)).toEqual(["fillers"]);
    expect(a.mistakes[0].at).toEqual([0.8, 2.3, 3.2]);
  });

  it("counts fillers in other languages and accepts more from the context", () => {
    expect(findFillers(words([["那个", 0, 0.3], ["我", 0.4, 0.5], ["这个这个", 0.6, 1]]), "zh")).toHaveLength(3);
    expect(findFillers(words([["Pues", 0, 0.2], ["este", 0.3, 0.5], ["vale", 0.6, 0.8]]), "es")).toHaveLength(2);
    expect(findFillers(words([["like", 0, 0.2], ["you", 0.3, 0.4], ["know", 0.5, 0.6]]), "en", ["like"])).toHaveLength(1);
    const b = analyzeSpeech(spec({ language: "en", prompt: "Say something" }), { transcript: { text: "like like ok", words: words([["like", 0, 0.2], ["like", 0.3, 0.5], ["ok", 0.6, 0.8]]) } }, { fillers: ["like"] });
    expect(b.metrics.filler_count.value).toBe(2);
  });

  it("finds pauses in the audio when there are no word times", () => {
    const sr = 16000;
    const x = new Float32Array(sr * 3);
    x.set(synthTone({ hz: 180, seconds: 0.8, sampleRate: sr, amp: 0.3 }), 0);
    x.set(synthTone({ hz: 200, seconds: 0.8, sampleRate: sr, amp: 0.3 }), Math.round(1.6 * sr));
    const r = analyzeSpeech(spec({ language: "en", target: "hello there" }), { transcript: { text: "hello there", words: [] }, samples: x, sampleRate: sr });
    expect(r.metrics.pause_count.value).toBe(1);
    expect(r.metrics.intelligibility.value).toBe(1);
  });
});

describe("intelligibility against a target", () => {
  it("counts recognized words and points at the missing one", () => {
    const tr = transcriptFromText("quiero un café por favor", { start: 0.2 });
    const a = analyzeSpeech(spec({ language: "es", target: "Quiero un café con leche, por favor.", pass: "intelligibility >= 0.9", mistakes: [{ id: "unclear", when: "intelligibility < 0.9" }] }), { transcript: tr, durationS: 2.5 });
    expect(a.metrics.words_expected.value).toBe(7);
    expect(a.metrics.words_recognized.value).toBe(5);
    expect(a.metrics.intelligibility.value).toBeCloseTo(5 / 7, 6);
    expect(a.criteria.pass).toBe(false);
    expect(a.mistakes[0].id).toBe("unclear");
    expect(a.mistakes[0].at.length).toBeGreaterThan(0);
    expect(a.markers.some((m) => m.label === 'missed "con"')).toBe(true);
    const ov = a.overlay as { kind: string; target: { token: string; ok: boolean }[]; words: unknown[] };
    expect(ov.kind).toBe("contour");
    expect(ov.target.filter((t) => !t.ok).map((t) => t.token)).toEqual(["con", "leche"]);
    expect(ov.words).toHaveLength(5);
  });

  it("is reduced precision without a per-sound model, full with one", () => {
    const tr = transcriptFromText("pero para caro");
    const s = spec({ language: "es", target: "pero para caro", sounds: ["ɾ", "e"], mistakes: [{ id: "tap-r", when: "sound['ɾ'] < 0.5" }] });
    const reduced = analyzeSpeech(s, { transcript: tr });
    expect(reduced.precision).toBe("reduced");
    expect(reduced.metrics.sound_score).toBeUndefined();
    expect(reduced.quality.ok).toBe(true);
    expect(reduced.quality.issues.join(" ")).toMatch(/per-sound scoring isn't available/);
    const full = analyzeSpeech(s, { transcript: tr }, { soundScores: { "ɾ": 0.4, e: 0.9, a: 0.2 } });
    expect(full.precision).toBe("full");
    expect(full.metrics.sound_score.value).toBeCloseTo(0.65, 6);
    expect(full.metrics.sound_score.per).toEqual([0.4, 0.9]);
    expect(full.mistakes.map((m) => m.id)).toEqual(["tap-r"]);
  });

  it("takes rubric grades for open answers and evaluates criteria", () => {
    const rubric = { criteria: [{ id: "relevance", levels: { "1": "Off topic", "2": "Partly", "3": "On topic" } }], pass: "relevance >= 2" };
    const a = analyzeSpeech(
      spec({ language: "fr", prompt: "Présentez-vous", rubric }),
      { transcript: transcriptFromText("je m'appelle Ana et j'habite à Lyon") },
      { grades: [{ criterion: "relevance", level: 3, confidence: 0.8 }, { criterion: "other", level: 1, confidence: 1 }], criteria: { long_enough: "words_recognized >= 6" } }
    );
    expect(a.metrics.relevance.value).toBe(3);
    expect(a.metrics.other).toBeUndefined();
    expect(a.criteria).toEqual({ long_enough: true, rubric: true });
  });
});

describe("tones", () => {
  it("classifies synthesized contours", () => {
    expect(classifyToneContour(contour([220, 222])).shape).toBe("level");
    expect(classifyToneContour(contour([180, 260])).shape).toBe("rising");
    expect(classifyToneContour(contour([300, 170])).shape).toBe("falling");
    expect(classifyToneContour(contour([210, 170, 240], 0.4)).shape).toBe("falling-rising");
    expect(classifyToneContour(contour([200, 260, 190], 0.4)).shape).toBe("rising-falling");
    expect(classifyToneContour([220, 0, 221]).shape).toBe("neutral");
    expect(classifyToneContour(contour([180, 260])).slope).toBeGreaterThan(4);
    expect(classifyToneContour(contour([300, 170])).slope).toBeLessThan(-6);
  });

  /** a pitch track with one contour per syllable and short gaps between */
  function track(shapes: number[][]) {
    const out: { t: number; hz: number; clarity: number }[] = [];
    const ws: { word: string; start: number; end: number; confidence: number }[] = [];
    let t = 0.2;
    shapes.forEach((p, i) => {
      const c = contour(p, 0.3);
      ws.push({ word: `s${i}`, start: t, end: t + 0.3, confidence: 0.9 });
      c.forEach((hz) => {
        out.push({ t, hz, clarity: 0.95 });
        t += 0.01;
      });
      for (let k = 0; k < 8; k++) {
        out.push({ t, hz: 0, clarity: 0 });
        t += 0.01;
      }
    });
    return { out, ws };
  }

  it("grades each syllable against the tone pattern", () => {
    const shapes = [[230, 232], [180, 250], [210, 170, 235], [290, 170]];
    const { out, ws } = track(shapes);
    const s = spec({ language: "zh-CN", target: "s0 s1 s2 s3", tones: true, tone_pattern: [1, 2, 3, 4], mistakes: [{ id: "tones", when: "tone_accuracy < 1" }] });
    const ok = analyzeSpeech(s, { transcript: { text: "s0 s1 s2 s3", words: ws }, pitchTrack: out });
    expect(ok.metrics.tone_accuracy.value).toBe(1);
    expect(ok.metrics.pitch_range_st.value).toBeGreaterThan(5);
    expect(ok.mistakes).toEqual([]);
    const ov = ok.overlay as { syllables: { tone: string; expected: number; contour: number[] }[] };
    expect(ov.syllables.map((x) => x.tone)).toEqual(["level", "rising", "falling-rising", "falling"]);
    expect(ov.syllables[0].contour).toHaveLength(12);

    const wrong = analyzeSpeech({ ...s, tone_pattern: [1, 4, 3, 4] }, { transcript: { text: "s0 s1 s2 s3", words: ws }, pitchTrack: out });
    expect(wrong.metrics.tone_accuracy.value).toBe(0.75);
    expect(wrong.metrics.tone_accuracy.per).toEqual([1, 0, 1, 1]);
    expect(wrong.mistakes[0].at).toHaveLength(1);
    expect(wrong.mistakes[0].at[0]).toBeCloseTo(ws[1].start, 3);
  });

  it("splits syllables by characters or by voicing when words don't match the pattern", () => {
    expect(segmentSyllables({ count: 3, words: words([["你好", 0, 0.6], ["吗", 0.7, 1]]) }).map((x) => x.word)).toEqual(["你", "好", "吗"]);
    const { out } = track([[200, 200], [200, 260], [260, 200]]);
    const segs = segmentSyllables({ count: 3, words: words([["nihaoma", 0.2, 1.3]]), pitchTrack: out });
    expect(segs).toHaveLength(3);
    expect(segs[1].start).toBeGreaterThan(0.45);
    expect(segs[1].start).toBeLessThan(0.6);
    expect(segmentSyllables({ count: 2, words: [] })).toHaveLength(2);
  });

  it("follows tones from audio samples, with a tone map from the context", () => {
    const sr = 16000;
    const x = new Float32Array(Math.round(1.6 * sr));
    const glide = (f0: number, f1: number, at: number) => {
      const n = Math.round(0.35 * sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const f = f0 * (f1 / f0) ** (i / n);
        ph += (2 * Math.PI * f) / sr;
        x[Math.round(at * sr) + i] = 0.3 * Math.min(1, i / 160, (n - i) / 160) * (Math.sin(ph) + 0.4 * Math.sin(2 * ph));
      }
    };
    glide(170, 250, 0.2);
    glide(260, 160, 0.8);
    const ws = words([["ba", 0.2, 0.55], ["da", 0.8, 1.15]]);
    // a language whose tone 1 is rising and tone 2 falling
    const a = analyzeSpeech(spec({ language: "xx", target: "ba da", tones: true, tone_pattern: [1, 2] }), { transcript: { text: "ba da", words: ws }, samples: x, sampleRate: sr }, { toneShapes: { 1: "rising", 2: "falling" } });
    expect(a.metrics.tone_accuracy.value).toBe(1);
  });
});

describe("quality", () => {
  it("asks to re-record silence or an empty transcript", () => {
    const s = spec({ language: "en", target: "hello" });
    const quiet = analyzeSpeech(s, { transcript: { text: "", words: [] }, samples: silence(2, 16000), sampleRate: 16000 });
    expect(quiet.quality.ok).toBe(false);
    expect(quiet.quality.reRecord).toMatch(/couldn't hear anything/);
    const empty = analyzeSpeech(s, { transcript: { text: " ", words: [] } });
    expect(empty.quality.ok).toBe(false);
    expect(empty.quality.reRecord).toMatch(/couldn't make out any words/);
  });
});

describe("transcribers", () => {
  it("builds a transcript from text", () => {
    const t = transcriptFromText("你好 world", { language: "zh", start: 1 });
    expect(t.words.map((w) => w.word)).toEqual(["你", "好", "world"]);
    expect(t.words[0].start).toBe(1);
    expect(t.language).toBe("zh");
  });

  it("parses whisper.cpp JSON with tokens and with segments only", () => {
    const full = parseWhisperJson(JSON.parse(readFileSync(join(FIX, "whisper-full.json"), "utf8")));
    expect(full.language).toBe("es");
    expect(full.text).toBe("Hola, ¿cómo estás?");
    expect(full.words.map((w) => w.word)).toEqual(["Hola,", "cómo", "estás?"]);
    expect(full.words[1].start).toBeCloseTo(0.72, 6);
    expect(full.words[1].confidence).toBeCloseTo(0.7, 6);
    const legacy = parseWhisperJson(JSON.parse(readFileSync(join(FIX, "whisper-legacy.json"), "utf8")));
    expect(legacy.words.map((w) => w.word)).toEqual(["你", "好", "谢", "谢"]);
    expect(Number.isNaN(legacy.words[0].confidence)).toBe(true);
  });

  it("writes a 16 kHz mono WAV", () => {
    const wav = encodeWav16k(synthTone({ hz: 440, seconds: 0.5, sampleRate: 44100 }), 44100);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(wav.length).toBe(44 + 8000 * 2);
  });

  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** a stand-in for whisper-cli: records its arguments and writes a fixture as its JSON output */
  function fakeWhisper(fixture: string, legacy: boolean): { bin: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), "las-fake-whisper-"));
    dirs.push(dir);
    const bin = join(dir, legacy ? "main" : "whisper-cli");
    const log = join(dir, "args.log");
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$@" >> "${log}"
OF=""; F=""
for a in "$@"; do
  case "$a" in
    -ojf) ${legacy ? 'echo "error: unknown argument: -ojf" >&2; exit 1' : ":"} ;;
    -np) ${legacy ? 'echo "error: unknown argument: -np" >&2; exit 1' : ":"} ;;
  esac
done
while [ $# -gt 0 ]; do
  case "$1" in
    -of) OF="$2"; shift ;;
    -f) F="$2"; shift ;;
  esac
  shift
done
[ "$(head -c 4 "$F")" = "RIFF" ] || { echo "bad wav" >&2; exit 2; }
cp "${join(FIX, fixture)}" "$OF.json"
`
    );
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  it("runs whisper-cli with full JSON output and cleans up", async () => {
    const { bin, log } = fakeWhisper("whisper-full.json", false);
    const t = whisperCliTranscriber({ binary: bin, modelPath: "/models/ggml-base.bin", language: "es" });
    expect(t.id).toBe("whisper-cli:ggml-base.bin");
    const out = await t.transcribe(synthTone({ hz: 200, seconds: 1, sampleRate: 22050 }), 22050);
    expect(out.words.map((w) => w.word)).toEqual(["Hola,", "cómo", "estás?"]);
    const args = readFileSync(log, "utf8").trim().split("\n");
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/-m \/models\/ggml-base.bin -f \S+input.wav -l es -of \S+ -np -ojf/);
    const tmp = /-f (\S+)\/input.wav/.exec(args[0])![1];
    expect(existsSync(tmp)).toBe(false);
  });

  it("falls back to the older CLI flags", async () => {
    const { bin, log } = fakeWhisper("whisper-legacy.json", true);
    const out = await whisperCliTranscriber({ binary: bin, modelPath: "m.bin" }).transcribe(synthTone({ hz: 200, seconds: 1, sampleRate: 16000 }), 16000, "zh");
    expect(out.language).toBe("zh");
    expect(out.words).toHaveLength(4);
    const args = readFileSync(log, "utf8").trim().split("\n");
    expect(args).toHaveLength(4);
    expect(args[3]).toMatch(/-l zh .* -oj -ml 1$/);
  });

  it("reports a missing binary", async () => {
    await expect(whisperCliTranscriber({ binary: join(tmpdir(), "no-such-whisper-binary"), modelPath: "m.bin" }).transcribe(new Float32Array(1600), 16000)).rejects.toThrow(/not found/);
  });
});

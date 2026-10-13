import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact-render-to-string";
import { BASE_THEME, COMPONENT_VARIANTS, ThemeSchema, validateTheme, type Theme } from "@las/schema";
import { themeToCss, themeAttrs, Onboarding, Today, SessionScreen, Recording, Replay, ProgressScreen, Summary, ProofResult, Widget, ThemePreview, sessionSteps } from "../src/index.js";
import { intakeSteps, today, session, feedback, analysis, progress, summary, proof } from "./fixtures/views.js";

const fixturesDir = join(import.meta.dirname, "../../../evals/fixtures/themes");
const fixtures: Theme[] = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).map((f) => ThemeSchema.parse(JSON.parse(readFileSync(join(fixturesDir, f), "utf8"))));
const themes: Theme[] = [BASE_THEME, ...fixtures];

const sample = { skill: "Test skill", milestone: "Ten clean reps", nextSession: "Session 2: Depth", ladder: ["Brand new", "First clean rep", "Ten clean reps", "Add weight"], lessonCard: session.blocks[2].items[0].type === "lesson" ? session.blocks[2].items[0].cards[0] : ({ type: "predict", text: "?", options: ["a", "b"], answer: 0 } as const), feedback: { headline: "Reps stop above parallel", praise: "Five reps found" } };

/** Every screen the design names, rendered from view models. */
function screens(theme: Theme): Record<string, string> {
  const voice = theme.voice;
  const steps = sessionSteps(session);
  const out: Record<string, string> = {};
  intakeSteps.forEach((v) => (out[`onboarding:${v.step}:${v.answerType}`] = render(<Onboarding view={v} voice={voice} />)));
  out.today = render(<Today view={today} voice={voice} />);
  out["today:first-day"] = render(<Today view={{ ...today, state: "first-day", checkin: undefined }} voice={voice} />);
  out["today:paused"] = render(<Today view={{ ...today, state: "paused" }} voice={voice} />);
  out["today:proof-ready"] = render(<Today view={{ ...today, state: "proof-ready" }} voice={voice} />);
  for (const s of steps) out[`session:${session.blocks[s.blockIndex].kind}:${s.phase ?? ""}`] = render(<SessionScreen plan={session} step={s} state={{ warmup: [0], cards: {}, drills: {}, pipeline: { as_1: 2 } }} voice={voice} />);
  out.recording = render(<Recording engine="movement" prompt="Film five reps" how="Side-on" angle="side" durationS={30} framing={{ pointsVisible: 0.8, light: true, steady: false, ready: false, seconds: 0 }} landmarks={{ left_hip: [0.4, 0.5, 0.9], left_knee: [0.42, 0.7, 0.9], left_ankle: [0.4, 0.9, 0.9], left_shoulder: [0.4, 0.3, 0.9] }} voice={voice} />);
  out["recording:audio"] = render(<Recording engine="audio" prompt="Record 4 bars" meters={{ level: 0.5, pitch: { cents: 12, note: "G3" }, beats: { beats: 8, offsetsMs: [10, -70, null, 15] } }} voice={voice} />);
  out["recording:code"] = render(<Recording engine="code" prompt="Write count_words" meters={{ tests: [{ label: "count_words('')", pass: true }, { label: "count_words('a  b')", pass: false }, { label: "hidden" }] }} voice={voice} />);
  out.replay = render(<Replay analysis={analysis} feedback={feedback} landmarks={{ left_hip: [0.4, 0.5, 0.9], left_knee: [0.42, 0.7, 0.9] }} reference={{ left_hip: [0.4, 0.5, 0.9], left_knee: [0.4, 0.72, 0.9] }} marks={[{ kind: "arc", role: "attention", points: [[0.4, 0.5], [0.42, 0.7], [0.4, 0.9]], degrees: 104 }]} compare="reference" voice={voice} />);
  out["replay:rerecord"] = render(<Replay analysis={{ ...analysis, quality: { ok: false, issues: ["feet out of frame"] } }} feedback={{ ...feedback, reRecord: "I couldn't see your feet. Move the phone back a step." }} voice={voice} />);
  out.progress = render(<ProgressScreen view={progress} voice={voice} />);
  out.summary = render(<Summary view={summary} voice={voice} />);
  out.proof = render(<ProofResult view={proof} voice={voice} />);
  out["proof:failed"] = render(<ProofResult view={{ ...proof, passed: false, criteria: proof.criteria.map((c, i) => ({ ...c, passed: i === 0 })) }} voice={voice} />);
  out["widget:today"] = render(<Widget payload={{ view: "today", title: "Today", data: today, theme, studioLink: "http://127.0.0.1:4711/app/today" }} />);
  out["widget:feedback"] = render(<Widget payload={{ view: "feedback", title: "One fix", data: feedback, theme }} />);
  out["widget:sim"] = render(<Widget payload={{ view: "sim", title: "Sim", data: { kind: "sim", title: "Lean", params: { hip: { label: "Hips", min: 5, max: 60, default: 30 } }, formulas: { load: "clamp(hip * 1.5, 0, 100)" }, figure: { kind: "gauge", value: "load", min: 0, max: 100, good: [0, 40] }, readout: [{ value: "load", label: "Arm load", unit: "%", decimals: 0 }] }, theme }} />);
  out["widget:capabilities"] = render(<Widget payload={{ view: "capabilities", title: "Capabilities", data: { engines: [{ id: "movement", available: true, backend: "wasm" }], runners: { browser: ["python"], local: [], container: { available: false } } }, theme }} />);
  out["widget:capture"] = render(<Widget payload={{ view: "capture", title: "Record", data: { engine: "movement", prompt: "Film five reps" }, theme, studioLink: "http://127.0.0.1:4711/s/x" }} />);
  out["widget:diagram"] = render(<Widget payload={{ view: "diagram", title: "Order", data: { text: "Subject, verb, object.", figure: { kind: "mermaid", source: "graph LR; s[Subject] --> v[Verb] --> o[Object]" } }, theme }} />);
  out["theme-preview"] = render(<ThemePreview sample={sample} voice={voice} />);
  return out;
}

/** Offline accessibility checks over rendered HTML (layout checks run in the browser e2e suite). */
function a11yIssues(html: string): string[] {
  const issues: string[] = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const inner = m[2].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
    if (!inner && !/aria-label=/.test(attrs) && !/aria-labelledby=/.test(attrs)) issues.push(`button without a name: ${m[0].slice(0, 80)}`);
  }
  for (const m of html.matchAll(/<img\b([^>]*)>/g)) if (!/\balt=/.test(m[1])) issues.push(`img without alt: ${m[0].slice(0, 80)}`);
  for (const m of html.matchAll(/<input\b([^>]*)>/g)) if (!/aria-label=/.test(m[1]) && !/type="(hidden|file)"/.test(m[1]) && !/\bid="/.test(m[1])) issues.push(`input without a label: ${m[0].slice(0, 80)}`);
  for (const m of html.matchAll(/<svg\b([^>]*)>/g)) if (/role="img"/.test(m[1]) && !/aria-label=/.test(m[1])) issues.push(`svg img without a label: ${m[0].slice(0, 80)}`);
  for (const m of html.matchAll(/<textarea\b([^>]*)>/g)) if (!/aria-label=/.test(m[1])) issues.push(`textarea without a label`);
  if (/style="[^"]*#[0-9a-fA-F]{3,8}/.test(html)) issues.push("inline hex color");
  if (/style="[^"]*font-family/.test(html)) issues.push("inline font-family");
  return issues;
}

describe("theme fixtures", () => {
  it("has the six very different looks and they all pass validation", () => {
    expect(fixtures.map((t) => t.id).sort()).toEqual(["brutalist", "dark-neon", "glass", "high-contrast", "monochrome-serif", "playful-rounded"]);
    for (const t of themes) {
      const v = validateTheme(t);
      expect(v.errors, `${t.id}: ${v.errors.map((e) => e.message).join("; ")}`).toEqual([]);
    }
  });
  it("exercises every variant on the component menu across the fixtures", () => {
    for (const [comp, menu] of Object.entries(COMPONENT_VARIANTS)) {
      const used = new Set(themes.map((t) => (t.components as any)[comp]));
      expect([...menu].filter((v) => !used.has(v)), `${comp} variants never used`).toEqual([]);
    }
    expect(new Set(themes.map((t) => t.motion.personality))).toEqual(new Set(["none", "subtle", "snappy", "springy"]));
    expect(new Set(themes.map((t) => t.texture.kind)).size).toBeGreaterThanOrEqual(3);
    expect(themes.some((t) => t.modes.length === 1 && t.modes[0] === "dark")).toBe(true);
  });
  it("turns every theme into CSS variables and data attributes with no undefined values", () => {
    for (const t of themes) {
      const css = themeToCss(t);
      expect(css).not.toMatch(/undefined|NaN/);
      expect(css).toMatch(/--las-color-bg:/);
      expect(css).toMatch(/--las-font-display:/);
      expect(css).toMatch(/--las-motion-duration:/);
      if (t.modes.includes("dark") && t.dark) expect(css).toMatch(/prefers-color-scheme: dark/);
      const attrs = themeAttrs(t);
      for (const comp of Object.keys(COMPONENT_VARIANTS)) expect(attrs[`data-${comp}`]).toBe((t.components as any)[comp]);
    }
  });
});

describe("screens in every theme", () => {
  for (const theme of themes) {
    it(`renders every screen in "${theme.name}" with no accessibility issues`, () => {
      const out = screens(theme);
      expect(Object.keys(out).length).toBeGreaterThan(30);
      for (const [name, html] of Object.entries(out)) {
        expect(html.length, name).toBeGreaterThan(200);
        expect(a11yIssues(html), `${theme.id} ${name}`).toEqual([]);
        expect(html, name).not.toMatch(/\[object Object\]|undefined/);
      }
    });
  }
  it("shows the copy set the theme's voice picks", () => {
    const warm = { ...BASE_THEME, voice: "warm" as const };
    const html = render(<Today view={today} voice={warm.voice} />);
    expect(html).toMatch(/Begin today's session/);
    expect(render(<Today view={today} voice="terse" />)).not.toMatch(/Begin today's session/);
  });
  it("keeps the session frame consistent: progress segments per block, back button, exit, sticky CTA", () => {
    const html = render(<SessionScreen plan={session} step={sessionSteps(session)[0]} state={{}} />);
    expect(html.match(/<i style="transform:scaleX\(/g)?.length ?? 0).toBe(session.blocks.length);
    expect(html).toMatch(/aria-label="Back"/);
    expect(html).toMatch(/>Exit</);
    expect(html).toMatch(/las-cta/);
  });
});

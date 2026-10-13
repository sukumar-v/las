import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact-render-to-string";
import { BASE_THEME, COMPONENT_VARIANTS, ThemeSchema, validateTheme, type Theme } from "@las/schema";
import { themeToCss, themeAttrs, Onboarding, Today, SessionScreen, Recording, Replay, ProgressScreen, Summary, ProofResult, Widget, ThemePreview, sessionSteps, LiveScreen, CoachMessage, PlanProposal, Presence, AskCoach, PauseScreen, coachWidgetModel, clampWords, copy, type Voice } from "../src/index.js";
import { intakeSteps, today, session, feedback, analysis, progress, summary, proof, coachMessage, coachLeaving, planProposal, liveScreens } from "./fixtures/views.js";

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
  // the live coach: every screen kind, each presence, a message over a screen, a plan, the pause and the end
  out["live:lesson:here+message"] = render(<LiveScreen screen={liveScreens.lesson} presence="here" message={coachMessage} state={{ cards: {} }} voice={voice} />);
  out["live:drill:away"] = render(<LiveScreen screen={liveScreens.drill} presence="away" state={{ drills: {} }} voice={voice} />);
  out["live:feedback"] = render(<LiveScreen screen={liveScreens.feedback} presence="here" voice={voice} />);
  out["live:plan"] = render(<LiveScreen screen={liveScreens.plan} presence="here" chosen="keep" voice={voice} />);
  out["live:pause"] = render(<LiveScreen screen={liveScreens.pause} presence="away" seconds={754} voice={voice} />);
  out["live:thinking"] = render(<LiveScreen screen={liveScreens.drill} presence="thinking" waiting voice={voice} />);
  out["live:left"] = render(<LiveScreen screen={liveScreens.drill} presence="left" message={coachLeaving} state={{ drills: {} }} voice={voice} />);
  out["live:ended"] = render(<LiveScreen screen={liveScreens.wrapup} presence="away" summary={summary} voice={voice} />);
  out["widget:coach"] = render(<Widget payload={{ view: "coach", title: "Coach", data: { liveSessionId: "ses_1", state: "live", coachPresent: true, screen: liveScreens.lesson, message: coachMessage }, theme, studioLink: "http://127.0.0.1:4711/app/session/ses_1" }} />);
  out["widget:coach-plan"] = render(<Widget payload={{ view: "coach", title: "Coach", data: liveScreens.plan, theme }} />);
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

describe("the live coach's pieces", () => {
  const voices: Voice[] = ["plain", "warm", "playful", "terse"];
  const keys = ["coachHere", "coachAway", "coachThinking", "coachLeft", "coachMessage", "askLabel", "askPlaceholder", "askSend", "askHelp", "askHelpAway", "askSent", "reply", "dismiss", "pause", "resume", "pausedTitle", "timeSoFar", "planChange", "planChosen", "backToToday", "offline"];
  it("has every live copy key in every voice", () => {
    for (const v of voices) for (const k of keys) expect(copy(v, k), `${v}.${k}`).not.toBe(k);
    // the voices differ
    expect(new Set(voices.map((v) => copy(v, "coachHere"))).size).toBe(4);
  });
  it("draws presence from the state and says where the asked words go", () => {
    expect(render(<Presence status="here" />)).toMatch(/data-presence="here"[^>]*>.*Coach here/);
    expect(render(<Presence status="thinking" />)).toMatch(/Coach is thinking/);
    expect(render(<AskCoach />)).toMatch(/Your words go to your coach/);
    expect(render(<AskCoach away />)).toMatch(/answer when back/);
    expect(render(<AskCoach />)).toMatch(/maxlength="280"/i);
  });
  it("keeps a message within its budget, with reply and dismiss, and a leaving message says the session goes on", () => {
    const long = render(<CoachMessage view={{ ...coachMessage, text: Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") }} onDismiss={() => undefined} onReply={() => undefined} />);
    expect(long).toMatch(/w24…/);
    expect(long).not.toMatch(/w25/);
    expect(long).toMatch(/aria-label="Dismiss"/);
    expect(long).toMatch(/Reply/);
    expect(render(<CoachMessage view={coachLeaving} />)).toMatch(/session goes on/);
    expect(clampWords("a b c", 2)).toBe("a b…");
  });
  it("offers 2–4 plan options as tiles and marks the one picked", () => {
    const html = render(<PlanProposal view={planProposal} chosen="keep" />);
    expect(html.match(/class="las-tile"/g)?.length).toBe(3);
    expect(html).toMatch(/aria-pressed="true"[^>]*>[\s\S]*Keep Nov 3/);
  });
  it("shows the time so far on the pause screen and Resume as the main button", () => {
    expect(render(<PauseScreen seconds={754} />)).toMatch(/12:34/);
    expect(render(<LiveScreen screen={liveScreens.pause} presence="away" seconds={60} />)).toMatch(/las-cta[\s\S]*Resume/);
  });
  it("hides the ask box and pause in the read-only widget and on the summary", () => {
    expect(render(<LiveScreen screen={liveScreens.lesson} presence="here" readOnly />)).not.toMatch(/las-ask/);
    const ended = render(<LiveScreen screen={liveScreens.wrapup} presence="away" summary={summary} />);
    expect(ended).not.toMatch(/las-ask/);
    expect(ended).toMatch(/data-live-kind="ended"/);
  });
  it("reads the coach view from a LiveView, a {screen, state} result or a bare screen", () => {
    expect(coachWidgetModel({ liveSessionId: "x", state: "coach-away", coachPresent: false, leftOnPurpose: true, screen: liveScreens.lesson })).toMatchObject({ presence: "left", screen: { id: "scr_1" } });
    expect(coachWidgetModel({ screen: liveScreens.drill, state: { state: "live" } })).toMatchObject({ presence: "here", screen: { id: "scr_2" } });
    expect(coachWidgetModel(liveScreens.plan).screen?.id).toBe("scr_plan");
    expect(coachWidgetModel({ id: "m", kind: "message", item: coachMessage })).toMatchObject({ screen: undefined, message: { screenId: "scr_msg" } });
    expect(coachWidgetModel({ state: "ended", summary }).summary?.sessionId).toBe("ses_1");
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

/** /snapshots?theme=<id>&screen=<name>: one main screen with fixture data in a stored theme (or the base theme). */
import { useEffect, useState } from "preact/hooks";
import { Onboarding, Today, SessionScreen, sessionSteps, Recording, Replay, ProgressScreen, Widget, Note, LiveScreen, type LiveHandlers } from "@las/ui";
import { BASE_THEME, type Theme } from "@las/schema";
import { api } from "../api.js";
import { setActiveTheme } from "../theme.js";
import { intakeSteps, today, session, analysis, feedback, progress, summary, coachMessage, coachLeaving, liveScreens } from "./fixtures.js";
import { SNAPSHOT_SCREENS } from "./names.js";

const lm = { left_shoulder: [0.42, 0.3, 0.9], left_hip: [0.4, 0.5, 0.9], left_knee: [0.46, 0.7, 0.9], left_ankle: [0.4, 0.9, 0.9], left_elbow: [0.45, 0.42, 0.9], left_wrist: [0.5, 0.5, 0.9] } as Record<string, [number, number, number]>;

function app(children: preact.ComponentChildren) {
  return (
    <div class="las-app">
      <main class="las-main">{children}</main>
    </div>
  );
}

const noop = () => undefined;
/** Live screens draw with every control a session has (pause, exit, reply, dismiss); nothing happens here. */
const live: LiveHandlers = { onNext: noop, onExit: noop, onPause: noop, onResume: noop, onReply: noop, onDismissMessage: noop, onAsk: noop, onChoose: noop };

export function snapshotScreen(name: string, theme: Theme) {
  const voice = theme.voice;
  const step = (s: string, type?: string) => intakeSteps.find((v) => v.step === s && (!type || v.answerType === type))!;
  if (name.startsWith("onboarding-")) {
    const key = name.slice("onboarding-".length);
    const v = key === "probe" ? step("probe", "single") : key === "quiz" ? step("probe", "quiz") : step(key);
    return <Onboarding view={v} voice={voice} />;
  }
  if (name.startsWith("today-")) {
    const state = name.slice("today-".length) as typeof today.state;
    return app(<Today view={{ ...today, state, checkin: state === "missed" ? today.checkin : undefined }} voice={voice} />);
  }
  switch (name) {
    case "lesson": {
      const steps = sessionSteps(session);
      const s = steps.find((x) => session.blocks[x.blockIndex].kind === "learn")!;
      return <SessionScreen plan={session} step={s} state={{ cards: {} }} voice={voice} />;
    }
    case "recording-movement":
      return app(<Recording engine="movement" prompt="Film five reps" how="Side-on, about 3 m back." angle="side" durationS={30} framing={{ pointsVisible: 0.8, light: true, steady: false, ready: false, seconds: 0 }} landmarks={lm} voice={voice} />);
    case "recording-audio":
      return app(<Recording engine="audio" prompt="Play four bars with the click" recording elapsed={6} durationS={20} meters={{ level: 0.5, pitch: { cents: 12, note: "G3" }, beats: { beats: 8, offsetsMs: [10, -70, null, 15] } }} voice={voice} />);
    case "recording-code":
      return app(<Recording engine="code" prompt="Write count_words" meters={{ tests: [{ label: "count_words('') → 0", pass: true }, { label: "count_words('a  b') → 2", pass: false }, { label: "hidden test" }] }} voice={voice} />);
    case "feedback":
      return app(<Replay analysis={analysis} feedback={feedback} landmarks={lm} reference={{ ...lm, left_knee: [0.43, 0.72, 0.9] }} marks={[{ kind: "arc", role: "attention", points: [[0.4, 0.5], [0.46, 0.7], [0.4, 0.9]], degrees: 104 }]} compare="reference" voice={voice} />);
    case "progress":
      return app(<ProgressScreen view={progress} voice={voice} />);
    case "widget-today":
      return <Widget payload={{ view: "today", title: "Today", data: today, theme, studioLink: "http://127.0.0.1:4711/app/today" }} />;
    case "widget-feedback":
      return <Widget payload={{ view: "feedback", title: "One fix", data: feedback, theme }} />;
    case "live-lesson":
      return <LiveScreen screen={liveScreens.lesson} presence="here" message={coachMessage} state={{ cards: {} }} fill={0.4} h={live} voice={voice} />;
    case "live-away":
      return <LiveScreen screen={liveScreens.drill} presence="away" state={{ drills: {} }} fill={0.6} h={live} voice={voice} />;
    case "live-thinking":
      return <LiveScreen screen={liveScreens.drill} presence="thinking" waiting fill={0.6} h={live} voice={voice} />;
    case "live-feedback":
      return <LiveScreen screen={liveScreens.feedback} presence="here" fill={0.8} h={live} voice={voice} />;
    case "live-plan":
      return <LiveScreen screen={liveScreens.plan} presence="here" chosen="keep" askSent fill={0.9} h={live} voice={voice} />;
    case "live-pause":
      return <LiveScreen screen={liveScreens.pause} presence="away" seconds={754} h={live} voice={voice} />;
    case "live-left":
      return <LiveScreen screen={liveScreens.drill} presence="left" message={coachLeaving} state={{ drills: {} }} fill={0.6} h={live} voice={voice} />;
    case "live-ended":
      return <LiveScreen screen={liveScreens.wrapup} presence="away" summary={summary} h={live} voice={voice} />;
    case "widget-coach":
      return <Widget payload={{ view: "coach", title: "Coach", data: { liveSessionId: "ses_1", state: "live", coachPresent: true, screen: liveScreens.lesson, message: coachMessage }, theme, studioLink: "http://127.0.0.1:4711/app/session/ses_1" }} />;
    default:
      return app(<Note kind="warn">Unknown screen. One of: {SNAPSHOT_SCREENS.join(", ")}</Note>);
  }
}

export function SnapshotPage({ query }: { query: URLSearchParams }) {
  const id = query.get("theme") ?? "base";
  const screen = query.get("screen") ?? SNAPSHOT_SCREENS[0];
  const [theme, setTheme] = useState<Theme | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (id === "base") {
      setActiveTheme(BASE_THEME, "base");
      setTheme(BASE_THEME);
      return;
    }
    api.themeById(id).then((r) => {
      setActiveTheme(r.theme, r.themeId);
      setTheme(r.theme);
    }, (e) => setError((e as Error).message));
  }, [id]);
  if (error) return app(<Note kind="warn">{error}</Note>);
  if (!theme) return null;
  return (
    <div class="las-snap" data-screen={screen} data-ready="">
      {snapshotScreen(screen, theme)}
    </div>
  );
}

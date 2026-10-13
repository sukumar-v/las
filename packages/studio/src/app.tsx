/** The studio's router: one screen per path, all drawn by @las/ui in the learner's theme. */
import { useEffect, useState } from "preact/hooks";
import { currentRoute, onNavigate, type RouteMatch } from "./router.js";
import { VoiceContext, onThemeChange, currentTheme } from "./theme.js";
import { Home, TodayPage, ReviewPage, DrillPage, CapturePage, ReplayPage, ProgressPage, SummaryPage, ProofPage, ThemePage } from "./screens/loop.js";
import { OnboardNew, OnboardScreen } from "./screens/onboard.js";
import { SessionRoute } from "./screens/live.js";
import { SettingsPage } from "./screens/settings.js";
import { PairPage } from "./screens/pair.js";
import { SnapshotPage } from "./snapshots/page.js";
import { Failed } from "./screens/common.js";

export function screenFor(r: RouteMatch | undefined) {
  if (!r) return <Failed error="This page doesn't exist." />;
  const q = r.query;
  const sk = q.get("sk") ?? r.params.sk ?? null;
  switch (r.name) {
    case "home":
      return <Home />;
    case "onboard-new":
      return <OnboardNew />;
    case "onboard":
      return <OnboardScreen key={r.params.intakeId} intakeId={r.params.intakeId} />;
    case "today":
      return sk ? <TodayPage key={sk} sk={sk} /> : <Home />;
    case "session":
      return <SessionRoute key={r.params.id} id={r.params.id} query={q} />;
    case "capture":
      return <CapturePage key={r.params.attemptId} attemptId={r.params.attemptId} query={q} />;
    case "replay":
      return <ReplayPage key={r.params.attemptId} attemptId={r.params.attemptId} />;
    case "progress":
      return sk ? <ProgressPage key={sk} sk={sk} /> : <Home />;
    case "summary":
      return <SummaryPage key={r.params.sessionId} sessionId={r.params.sessionId} />;
    case "proof":
      return <ProofPage key={r.params.milestoneId + q.toString()} milestoneId={r.params.milestoneId} query={q} />;
    case "review":
      return sk ? <ReviewPage key={sk} sk={sk} back={q.get("return")} /> : <Home />;
    case "drill":
      return <DrillPage key={r.params.id} drillId={r.params.id} sk={sk} />;
    case "theme":
      return <ThemePage key={r.params.id} id={r.params.id} />;
    case "settings":
      return <SettingsPage sk={sk} />;
    case "pair":
      return <PairPage token={r.params.token} />;
    case "snapshots":
      return <SnapshotPage key={q.toString()} query={q} />;
    default:
      return <Failed error="This page doesn't exist." />;
  }
}

export function App() {
  const [route, setRoute] = useState(currentRoute());
  const [voice, setVoice] = useState(currentTheme()?.theme.voice);
  useEffect(() => onNavigate(() => setRoute(currentRoute())), []);
  useEffect(() => onThemeChange((s) => setVoice(s.theme.voice)), []);
  return <VoiceContext.Provider value={voice}>{screenFor(route)}</VoiceContext.Provider>;
}

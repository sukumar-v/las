/**
 * Settings: the look (per skill or for everything), pairing a phone as the camera, check-in reminders by
 * Web Push on this device, consent for code runners, export and delete, and what this computer can do.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import QRCode from "qrcode";
import { Button, Card, Chip, Chips, Eyebrow, H2, Hint, KeyValues, Note, Tabs, Tile, Tiles } from "@las/ui";
import type { Capabilities } from "@las/schema";
import { api, type PairInfo, type StateView } from "../api.js";
import { navigate, buildPath } from "../router.js";
import { loadTheme, useT } from "../theme.js";
import { Page } from "./common.js";
import { pushSupported, subscribePush, unsubscribePush } from "../push.js";

/** The QR code's modules as one SVG path, so the theme colors it (no colors in the markup). */
export function qrPath(text: string): { size: number; d: string } {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const data = qr.modules.data;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (data[y * n + x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return { size: n + 8, d };
}

/** Relative luminance of a CSS color as the browser computes it. */
function luminanceOf(css: string): number {
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return 0;
  c.fillStyle = css;
  const v = c.fillStyle;
  let rgb: number[] = [0, 0, 0];
  if (v.startsWith("#")) rgb = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  else {
    const m = v.match(/[\d.]+/g);
    if (m) rgb = m.slice(0, 3).map(Number);
  }
  const lin = rgb.map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function Qr({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  const [inverted, setInverted] = useState(false);
  useEffect(() => {
    const s = getComputedStyle(document.documentElement);
    // phone cameras read dark modules on a light field: draw with whichever of ink and surface is darker
    setInverted(luminanceOf(s.getPropertyValue("--las-color-ink").trim()) > luminanceOf(s.getPropertyValue("--las-color-surface").trim()));
  }, [text]);
  return (
    <div class="las-qr" data-inverted={inverted ? "" : undefined}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shape-rendering="crispEdges">
        <rect class="bg" width={size} height={size} />
        <path class="m" d={d} />
      </svg>
    </div>
  );
}

function PairSection() {
  const t = useT();
  const [info, setInfo] = useState<PairInfo | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setInfo(await api.pair());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void make();
  }, []);
  return (
    <section class="las-section" aria-label={t("Pair a phone")} data-section="pair">
      <H2>{t("Pair a phone")}</H2>
      <Hint>{t("Use your phone as the camera. It joins over your local network; the studio itself stays on this computer only.")}</Hint>
      {error ? <Note kind="warn" icon="warn">{error}</Note> : null}
      {info && !info.available ? (
        <Note icon="phone" kind="warn">
          {info.note ?? t("Pairing isn't available here.")}
        </Note>
      ) : null}
      {info?.available && info.urls?.length ? (
        <Card label={t("Pairing code")}>
          <Qr text={info.urls[0]} label={t("Pairing QR code")} />
          <Eyebrow>{t("Scan with the phone's camera, or open")}</Eyebrow>
          {info.urls.map((u) => (
            <span key={u} class="las-url">
              {u}
            </span>
          ))}
          <Hint>{t("Works once, for 10 minutes. The phone's browser must trust this computer's local certificate once:")} {info.ca ? <a href={info.ca} download>{t("download it")}</a> : null}</Hint>
          <Button icon="repeat" disabled={busy} onClick={() => void make()}>
            {t("New code")}
          </Button>
        </Card>
      ) : null}
    </section>
  );
}

function PushSection() {
  const t = useT();
  const [subs, setSubs] = useState<{ id: string; endpointHost: string }[]>([]);
  const [mine, setMine] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem("las.pushId") ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const supported = pushSupported();
  const load = () => api.pushSubscriptions().then((r) => setSubs(r.subscriptions), () => undefined);
  useEffect(() => {
    void load();
  }, []);
  return (
    <section class="las-section" aria-label={t("Reminders")} data-section="push">
      <H2>{t("Check-in reminders")}</H2>
      <Hint>{t("Off until you turn them on. Quiet hours and at most one nudge a day still apply. On iPhone, add the studio to your home screen first.")}</Hint>
      {!supported ? <Note>{t("This browser can't receive push reminders. Today still shows every check-in.")}</Note> : null}
      {supported ? (
        mine && subs.some((s) => s.id === mine) ? (
          <Button
            icon="x"
            onClick={async () => {
              await unsubscribePush(mine).catch(() => undefined);
              setMine(undefined);
              await load();
            }}
          >
            {t("Turn off on this device")}
          </Button>
        ) : (
          <Button
            primary
            icon="clock"
            onClick={async () => {
              setError(undefined);
              try {
                setMine(await subscribePush());
                await load();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {t("Turn on reminders here")}
          </Button>
        )
      ) : null}
      {subs.length ? <Hint>{t(`${subs.length} device${subs.length === 1 ? "" : "s"} get reminders.`)}</Hint> : null}
      {error ? <Note kind="warn" icon="warn">{error}</Note> : null}
    </section>
  );
}

function ThemeSection({ state, sk }: { state?: StateView; sk?: string | null }) {
  const t = useT();
  const [scope, setScope] = useState<string>(sk ?? "all");
  const [themes, setThemes] = useState<{ active: { themeId: string; scope: string }; all: { themeId: string }; themes: { id: string; name: string; modes: string[]; validated: boolean }[] } | undefined>(undefined);
  const load = () => api.themes(scope === "all" ? undefined : scope).then(setThemes, () => undefined);
  useEffect(() => {
    void load();
  }, [scope]);
  const activeId = scope === "all" ? themes?.all.themeId : themes?.active.themeId;
  return (
    <section class="las-section" aria-label={t("Look")} data-section="look">
      <H2>{t("Look")}</H2>
      {state?.enrollments.length ? <Tabs tabs={[{ id: "all", label: t("Everything") }, ...state.enrollments.map((e) => ({ id: e.sk, label: e.skill }))]} value={scope} onChange={setScope} /> : null}
      <Tiles list>
        {(themes?.themes ?? []).filter((th) => th.validated).map((th) => (
          <Tile
            key={th.id}
            title={th.name}
            detail={th.modes.join(" + ")}
            icon="look"
            on={activeId === th.id}
            onClick={async () => {
              await api.setTheme(th.id, scope).catch(() => undefined);
              await loadTheme(scope === "all" ? sk : scope);
              await load();
            }}
          />
        ))}
      </Tiles>
      {activeId ? (
        <Button link onClick={() => navigate(buildPath("/theme/:id", { id: activeId }))}>
          {t("Preview on your screens")}
        </Button>
      ) : null}
      <Hint>{t("To make a new look, describe it to your agent, paste a design prompt, or share a screenshot.")}</Hint>
    </section>
  );
}

function RunnerSection({ caps }: { caps?: Capabilities }) {
  const t = useT();
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (caps) setGranted({ local: caps.runners.local.some((l) => l.consented), container: caps.runners.container.consented });
  }, [caps]);
  const set = async (runner: "local" | "container", v: boolean) => {
    await api.consent(runner, v).catch(() => undefined);
    setGranted({ ...granted, [runner]: v });
  };
  return (
    <section class="las-section" aria-label={t("Code runners")} data-section="runners">
      <H2>{t("Code runners")}</H2>
      <Hint>{t("Code in the browser runs in a sandbox. Toolchains on this computer and containers ask first.")}</Hint>
      <Chips>
        <Chip label={t("This computer's toolchains")} on={!!granted.local} onClick={() => void set("local", !granted.local)} />
        <Chip label={t("Containers")} on={!!granted.container} onClick={() => void set("container", !granted.container)} />
      </Chips>
    </section>
  );
}

function DataSection({ sk }: { sk?: string | null }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  return (
    <section class="las-section" aria-label={t("Your data")} data-section="data">
      <H2>{t("Your data")}</H2>
      <div class="las-inline">
        <a class="las-btn" href={api.exportUrl("all")} download>
          {t("Export everything")}
        </a>
        {sk ? (
          <a class="las-btn" href={api.exportUrl(sk)} download>
            {t("Export this skill")}
          </a>
        ) : null}
      </div>
      {confirm ? (
        <Card class="las-dialog" role="alertdialog" label={t("Delete everything")}>
          <Note kind="bad" icon="warn">
            {t("This deletes every skill, session, attempt and recording. It can't be undone.")}
          </Note>
          <div class="las-inline">
            <Button
              primary
              onClick={async () => {
                await api.deleteData("all").catch(() => undefined);
                setConfirm(false);
                setDone(t("Deleted."));
              }}
            >
              {t("Delete everything")}
            </Button>
            <Button link onClick={() => setConfirm(false)}>
              {t("Keep it")}
            </Button>
          </div>
        </Card>
      ) : (
        <Button link onClick={() => setConfirm(true)}>
          {t("Delete everything…")}
        </Button>
      )}
      {done ? <Note icon="check">{done}</Note> : null}
    </section>
  );
}

function CapabilitySection({ caps }: { caps?: Capabilities }) {
  const t = useT();
  if (!caps) return null;
  return (
    <section class="las-section" aria-label={t("What this computer can do")} data-section="capabilities">
      <H2>{t("What this computer can do")}</H2>
      <Card label={t("Capabilities")}>
        <Eyebrow>{t("Engines")}</Eyebrow>
        <KeyValues items={caps.engines.map((e) => [e.id, e.available ? t(`ready (${e.backend})`) : t(`missing: ${e.reason ?? ""}`)])} />
        <Eyebrow>{t("Code runners")}</Eyebrow>
        <KeyValues items={[[t("browser"), caps.runners.browser.join(", ")], [t("this computer"), caps.runners.local.map((l) => l.language).join(", ") || t("none")], [t("container"), caps.runners.container.available ? (caps.runners.container.runtime ?? "") : t("none")]]} />
        <Eyebrow>{t("Devices")}</Eyebrow>
        <KeyValues items={Object.entries(caps.devices).map(([k, v]) => [k, v ? t("yes") : t("no")])} />
      </Card>
    </section>
  );
}

export function SettingsPage({ sk }: { sk?: string | null }) {
  const t = useT();
  const [state, setState] = useState<StateView | undefined>(undefined);
  const [caps, setCaps] = useState<Capabilities | undefined>(undefined);
  useEffect(() => {
    void loadTheme(sk);
    api.state().then(setState, () => undefined);
    api.capabilities().then(setCaps, () => undefined);
  }, []);
  return (
    <Page nav sk={sk ?? state?.enrollments[0]?.sk} current="settings">
      <h1 class="las-h1" tabIndex={-1}>
        {t("Settings")}
      </h1>
      <ThemeSection state={state} sk={sk} />
      <PairSection />
      <PushSection />
      <RunnerSection caps={caps} />
      <DataSection sk={sk} />
      <CapabilitySection caps={caps} />
    </Page>
  );
}

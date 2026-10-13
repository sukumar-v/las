/**
 * The phone side of pairing (/pair/<token>): claims the single-use token, then records whatever the computer
 * asks for next. The phone measures on its own and sends the analysis; the computer learns through its stream.
 */
import { useEffect, useState } from "preact/hooks";
import { Button, Card, Eyebrow, Hint, Note, Steps } from "@las/ui";
import { api, type AttemptInfo } from "../api.js";
import { loadTheme, useT } from "../theme.js";
import { Page } from "./common.js";
import { CaptureView } from "./capture.js";
import { processCapture, PIPELINE_STEPS, type Captured } from "../capture/pipeline.js";

export function PairPage({ token }: { token: string }) {
  const t = useT();
  const [status, setStatus] = useState<"claiming" | "paired" | "failed">("claiming");
  const [error, setError] = useState<string | undefined>(undefined);
  const [info, setInfo] = useState<AttemptInfo | undefined>(undefined);
  const [captured, setCaptured] = useState<Captured | undefined>(undefined);
  const [done, setDone] = useState(-1);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    api.pairClaim(token).then(
      () => {
        setStatus("paired");
        void loadTheme();
      },
      (e) => {
        setStatus("failed");
        setError((e as Error).message);
      }
    );
  }, [token]);

  // look for the attempt the computer is waiting on
  useEffect(() => {
    if (status !== "paired" || info) return;
    let alive = true;
    const poll = async () => {
      const p = await api.pendingAttempt().catch(() => ({ attemptId: null }));
      if (!alive) return;
      if (p.attemptId) {
        const i = await api.attempt(p.attemptId).catch(() => undefined);
        if (i && alive) {
          await loadTheme(i.attempt.enrollmentId);
          setInfo(i);
          setCaptured(undefined);
          setDone(-1);
        }
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [status, info]);

  if (status === "claiming") return <Page><Hint>{t("Pairing…")}</Hint></Page>;
  if (status === "failed")
    return (
      <Page>
        <h1 class="las-h1" tabIndex={-1}>
          {t("Couldn't pair")}
        </h1>
        <Note kind="warn" icon="warn">
          {error}
        </Note>
        <Hint>{t("On your computer, open the studio's Settings and scan the new code.")}</Hint>
      </Page>
    );
  if (!info)
    return (
      <Page>
        <h1 class="las-h1" tabIndex={-1}>
          {t("Paired")}
        </h1>
        <Note icon="phone">{sent ? t("Sent to your computer. Waiting for the next recording…") : t("This phone is the camera now. Start a recording on your computer, or ask your agent.")}</Note>
      </Page>
    );
  return (
    <Page>
      {done >= 0 ? (
        <Card label={t("Analysis")}>
          <Eyebrow>{t("On this phone. The clip stays on your devices.")}</Eyebrow>
          <Steps steps={PIPELINE_STEPS} done={done} />
        </Card>
      ) : (
        <CaptureView info={info} onCaptured={setCaptured} captured={!!captured} />
      )}
      {error ? <Note kind="warn" icon="warn">{error}</Note> : null}
      {done < 0 ? (
        <Button
          primary
          big
          disabled={!captured}
          onClick={async () => {
            if (!captured) return;
            setDone(0);
            try {
              await processCapture(api, info, captured, setDone);
              setSent((n) => n + 1);
              setInfo(undefined);
            } catch (e) {
              setDone(-1);
              setError((e as Error).message);
            }
          }}
        >
          {captured ? t("checkIt") : t("recordFirst")}
        </Button>
      ) : null}
    </Page>
  );
}

/** Page chrome the studio adds around shared screens: the app column and a small bottom navigation. */
import type { ComponentChildren } from "preact";
import { Button, Hint, Note } from "@las/ui";
import { navigate, buildPath } from "../router.js";
import { useT } from "../theme.js";

export function Page({ children, sk, nav, current }: { children?: ComponentChildren; sk?: string | null; nav?: boolean; current?: "today" | "progress" | "settings" }) {
  const t = useT();
  return (
    <div class="las-app">
      <main class="las-main">{children}</main>
      {nav ? (
        <nav class="las-studio-nav" aria-label={t("Studio")}>
          <Button icon="clock" aria-current={current === "today" ? "page" : undefined} onClick={() => navigate(sk ? buildPath("/app/today", {}, { sk }) : "/")}>
            {t("today")}
          </Button>
          <Button icon="target" aria-current={current === "progress" ? "page" : undefined} disabled={!sk} onClick={() => sk && navigate(buildPath("/app/progress", {}, { sk }))}>
            {t("progress")}
          </Button>
          <Button icon="look" aria-current={current === "settings" ? "page" : undefined} onClick={() => navigate(buildPath("/settings", {}, { sk: sk ?? undefined }))}>
            {t("Settings")}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

export function Loading({ what }: { what?: string }) {
  const t = useT();
  return (
    <Page>
      <Hint>{what ?? t("Loading…")}</Hint>
    </Page>
  );
}

export function Failed({ error, sk }: { error: string; sk?: string | null }) {
  const t = useT();
  return (
    <Page nav sk={sk}>
      <Note kind="warn" icon="warn">
        {error}
      </Note>
      <Button onClick={() => location.reload()}>{t("tryAgain")}</Button>
    </Page>
  );
}

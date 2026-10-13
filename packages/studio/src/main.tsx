/** Studio entry: base styles, the theme, live updates from the server, the service worker, then the app. */
import { render } from "preact";
import "@las/ui/base.css";
import "./styles.css";
import { BASE_THEME } from "@las/schema";
import { App } from "./app.js";
import { currentTheme, loadTheme, setActiveTheme } from "./theme.js";
import { onStream } from "./stream.js";
import { api } from "./api.js";
import { motionAvailable } from "./capture/sensor.js";

// the neutral base theme until the learner's arrives (theming §6)
setActiveTheme(BASE_THEME, "base");

const isSnapshot = location.pathname.startsWith("/snapshots") || location.pathname.startsWith("/theme/");
if (!isSnapshot) {
  void loadTheme(new URLSearchParams(location.search).get("sk"));
  // switching themes is instant: the server says when it changed, the page re-applies it
  onStream("theme.changed", () => {
    const sk = new URLSearchParams(location.search).get("sk") ?? undefined;
    void loadTheme(sk ?? (currentTheme()?.themeId === "base" ? undefined : sk));
  });
  // which devices this browser has; permissions are asked only when a capture needs them
  if (navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(
      (list) => api.devices({ camera: list.some((d) => d.kind === "videoinput"), microphone: list.some((d) => d.kind === "audioinput"), motion: motionAvailable() }).catch(() => undefined),
      () => undefined
    );
  }
}

if ("serviceWorker" in navigator && import.meta.env.PROD && !(window as unknown as { __lasFixture?: unknown }).__lasFixture) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

render(<App />, document.getElementById("app")!);

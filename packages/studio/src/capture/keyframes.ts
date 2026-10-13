/**
 * Key frames (evaluation §1): the movement engine names up to three moments (`frame:<i>`); the studio turns
 * them into small annotated images from the learner's own clip, the only pictures that leave the device.
 * The skeleton is drawn in the theme's overlay color, read from the applied tokens.
 */
import { POSE_CONNECTIONS } from "@las/ui";
import type { Analysis } from "@las/schema";
import type { PoseFrame } from "@las/engines";

const WIDTH = 320;

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      v.removeEventListener("seeked", done);
      resolve();
    };
    v.addEventListener("seeked", done);
    setTimeout(() => reject(new Error("seek timed out")), 3000);
    v.currentTime = Math.max(0, t);
  });
}

function nearest(frames: PoseFrame[] | undefined, t: number): PoseFrame | undefined {
  let best: PoseFrame | undefined;
  for (const f of frames ?? []) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best;
}

/** Replaces `frame:<i>` key frame refs with JPEG data URLs from the clip; refs that can't be drawn are dropped. */
export async function renderKeyFrames(analysis: Analysis, clip: Blob | undefined, frames: PoseFrame[] | undefined): Promise<Analysis> {
  const wanted = analysis.keyFrames.filter((k) => !/^(data:|https?:|\/)/.test(k.ref));
  if (!wanted.length) return analysis;
  const keep = analysis.keyFrames.filter((k) => !wanted.includes(k));
  if (!clip || typeof document === "undefined") return { ...analysis, keyFrames: keep };
  const url = URL.createObjectURL(clip);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error("clip unreadable"));
      setTimeout(() => reject(new Error("clip load timed out")), 4000);
    });
    const w = WIDTH;
    const h = Math.round((w * (v.videoHeight || 3)) / (v.videoWidth || 4));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d")!;
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue("--las-color-accent").trim() || css.color;
    const out = [...keep];
    for (const k of wanted) {
      try {
        await seek(v, k.t);
        g.drawImage(v, 0, 0, w, h);
        const f = nearest(frames, k.t);
        if (f?.pose) {
          g.strokeStyle = line;
          g.lineWidth = 2;
          for (const [a, b] of POSE_CONNECTIONS) {
            const pa = f.pose[a];
            const pb = f.pose[b];
            if (!pa || !pb || pa[3] < 0.3 || pb[3] < 0.3) continue;
            g.beginPath();
            g.moveTo(pa[0] * w, pa[1] * h);
            g.lineTo(pb[0] * w, pb[1] * h);
            g.stroke();
          }
        }
        out.push({ ...k, ref: canvas.toDataURL("image/jpeg", 0.7) });
      } catch {
        /* a moment that can't be shown is left out rather than shown broken */
      }
    }
    return { ...analysis, keyFrames: out.sort((a, b) => a.t - b.t).slice(0, 3) };
  } catch {
    return { ...analysis, keyFrames: keep };
  } finally {
    URL.revokeObjectURL(url);
  }
}

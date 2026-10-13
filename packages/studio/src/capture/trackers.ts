/**
 * Body, hand, face and object tracking on the device with MediaPipe Tasks Vision (Apache-2.0): the trackers a
 * metric spec needs (trackersFor), WASM from the studio's /vendor/mediapipe, weights from cachedModel.
 * Output is the engines' PoseFrame: normalized x, y (top-left origin), z, and visibility.
 */
import { FACE_LANDMARKS, HAND_LANDMARKS, POSE_LANDMARKS } from "@las/schema";
import type { PoseFrame, Point } from "@las/engines";
import { cachedModel, MODEL_URLS } from "./models.js";

export type TrackerKind = "pose" | "hands" | "face" | "objects";

export interface FrameTracker {
  kinds: TrackerKind[];
  detect(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap, tMs: number): PoseFrame;
  close(): void;
}

type Lm = { x: number; y: number; z: number; visibility?: number };

const point = (l: Lm, conf?: number): Point => [l.x, l.y, l.z ?? 0, conf ?? l.visibility ?? 1];

/** Loads the trackers in parallel. Downloads happen once; later sessions load from the cache. */
export async function createTracker(kinds: TrackerKind[], onProgress?: (label: string, share: number) => void): Promise<FrameTracker> {
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks("/vendor/mediapipe");
  const base = async (k: TrackerKind) => ({ modelAssetBuffer: await cachedModel(MODEL_URLS[k], (s) => onProgress?.(k, s)), delegate: "GPU" as const });
  const want = new Set(kinds.length ? kinds : ["pose"]);
  const [pose, hands, face, objects] = await Promise.all([
    want.has("pose") ? vision.PoseLandmarker.createFromOptions(fileset, { baseOptions: await base("pose"), runningMode: "VIDEO", numPoses: 1 }) : undefined,
    want.has("hands") ? vision.HandLandmarker.createFromOptions(fileset, { baseOptions: await base("hands"), runningMode: "VIDEO", numHands: 2 }) : undefined,
    want.has("face") ? vision.FaceLandmarker.createFromOptions(fileset, { baseOptions: await base("face"), runningMode: "VIDEO", numFaces: 1 }) : undefined,
    want.has("objects") ? vision.ObjectDetector.createFromOptions(fileset, { baseOptions: await base("objects"), runningMode: "VIDEO", scoreThreshold: 0.4, maxResults: 5 }) : undefined
  ]);
  let last = -1;
  return {
    kinds: [...want] as TrackerKind[],
    detect(source, tMs) {
      // MediaPipe needs strictly increasing timestamps in video mode
      const ts = Math.max(tMs, last + 1);
      last = ts;
      const frame: PoseFrame = { t: tMs / 1000 };
      const src = source as HTMLVideoElement;
      if (pose) {
        const r = pose.detectForVideo(src, ts);
        const lms = r.landmarks?.[0] as Lm[] | undefined;
        if (lms) frame.pose = Object.fromEntries(POSE_LANDMARKS.map((n, i) => [n, point(lms[i])]));
      }
      if (hands) {
        const r = hands.detectForVideo(src, ts);
        const out: NonNullable<PoseFrame["hands"]> = {};
        (r.landmarks ?? []).forEach((lms: Lm[], i: number) => {
          // MediaPipe labels handedness as seen in a mirrored selfie view; the studio's preview isn't mirrored
          const label = r.handedness?.[i]?.[0]?.categoryName === "Left" ? "right" : "left";
          const score = r.handedness?.[i]?.[0]?.score ?? 1;
          out[label] = Object.fromEntries(HAND_LANDMARKS.map((n, j) => [n, point(lms[j], score)]));
        });
        if (out.left || out.right) frame.hands = out;
      }
      if (face) {
        const r = face.detectForVideo(src, ts);
        const lms = r.faceLandmarks?.[0] as Lm[] | undefined;
        if (lms) frame.face = Object.fromEntries(Object.entries(FACE_LANDMARKS).map(([n, i]) => [n, point(lms[i], 1)]));
      }
      if (objects) {
        const r = objects.detectForVideo(src, ts);
        const dims = source as { videoWidth?: number; videoHeight?: number; width?: number; height?: number };
        const w = dims.videoWidth || dims.width || 1;
        const h = dims.videoHeight || dims.height || 1;
        const out: NonNullable<PoseFrame["objects"]> = {};
        for (const d of r.detections ?? []) {
          const c = d.categories?.[0];
          const b = d.boundingBox;
          if (!c || !b) continue;
          const name = (c.categoryName ?? "").toLowerCase().replace(/\s+/g, "_");
          if (!name || out[name]) continue;
          out[name] = { center: [(b.originX + b.width / 2) / w, (b.originY + b.height / 2) / h, 0, c.score ?? 1], w: b.width / w, h: b.height / h };
        }
        if (Object.keys(out).length) frame.objects = out;
      }
      return frame;
    },
    close() {
      pose?.close();
      hands?.close();
      face?.close();
      objects?.close();
    }
  };
}

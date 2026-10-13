/**
 * Recording quality: is the body in the frame, is the clip long enough, is the camera where the
 * spec asked for it. Every failure comes with one specific instruction for the next take.
 */
import type { PoseFrame } from "../types.js";
import { expandPointNames, isDirection, rawPoint, seen } from "./tracks.js";

export interface FramingResult {
  /** how many of the needed points are visible */
  pointsVisible: number;
  /** true when every needed point is visible */
  ready: boolean;
  missing: string[];
}

/**
 * The live framing guide: given the newest tracked frame, which needed points are missing.
 * The studio keeps the record button disabled until `ready` has held for one second.
 * Needed names may be body groups (`legs`) or derived points (`mid_hip`).
 */
export function framingCheck(frame: PoseFrame | undefined, needed: string[], opts: { minVisibility?: number } = {}): FramingResult {
  const minVis = opts.minVisibility ?? 0.6;
  const names = expandPointNames(needed.filter((n) => !isDirection(n)));
  if (!frame) return { pointsVisible: 0, ready: false, missing: names };
  if (!names.length) {
    const any = Object.values(frame.pose ?? {}).some((p) => seen(p, minVis));
    return { pointsVisible: 0, ready: any, missing: [] };
  }
  const missing = names.filter((n) => !seen(rawPoint(frame, n), minVis));
  return { pointsVisible: names.length - missing.length, ready: missing.length === 0, missing };
}

type Region = "feet" | "legs" | "hips" | "hands" | "arms" | "head" | "object";

function regionOf(name: string): Region {
  if (name.startsWith("object.")) return "object";
  if (name.startsWith("left_hand.") || name.startsWith("right_hand.")) return "hands";
  if (name.startsWith("face_") || /nose|eye|ear|mouth/.test(name)) return "head";
  if (/ankle|heel|foot/.test(name)) return "feet";
  if (/knee/.test(name)) return "legs";
  if (/hip/.test(name)) return "hips";
  if (/wrist|pinky|index|thumb/.test(name)) return "hands";
  return "arms";
}

const REGION_ORDER: Region[] = ["feet", "legs", "hips", "head", "hands", "arms", "object"];

/** One plain instruction naming the part that wasn't seen and how to fix the framing. */
export function framingInstruction(missing: string[], allMissing = false): string {
  if (allMissing || !missing.length) return "I couldn't see you. Stand where your whole body fits inside the frame guide, then record again.";
  const sides = new Set(missing.map((m) => (m.startsWith("left") ? "left" : m.startsWith("right") ? "right" : "both")));
  const regions = new Set(missing.map(regionOf));
  const region = REGION_ORDER.find((r) => regions.has(r))!;
  // a whole side missing (more than one body part, all on one side): the body is turned away
  if (sides.size === 1 && !sides.has("both") && regions.size > 1 && !regions.has("object")) {
    const side = [...sides][0];
    return `I couldn't see your ${side} side clearly. Turn so your ${side} side faces the camera, then record again.`;
  }
  switch (region) {
    case "feet":
      return "I couldn't see your feet. Move the phone back a step so your whole body is in the frame.";
    case "legs":
      return "I couldn't see your legs. Move the phone back a step or lower it to hip height.";
    case "hips":
      return "I couldn't see your hips. Move the phone back a step so your hips stay in the frame.";
    case "head":
      return "I couldn't see your head. Tilt the phone up a little or step back.";
    case "hands":
      return "I couldn't see your hands. Keep them inside the frame, or move the phone back a step.";
    case "arms":
      return "I couldn't see your arms. Move the phone back a step so your arms stay in the frame.";
    case "object": {
      const obj = missing.find((m) => m.startsWith("object."))!.slice(7).replace(/_/g, " ");
      return `I couldn't see the ${obj}. Keep it inside the frame and in good light.`;
    }
  }
}

const ANGLE_WORDS: Record<string, string> = {
  front: "facing you",
  side: "side-on",
  "side-45": "at 45° to your side",
  back: "behind you",
  top: "above you, looking down",
  "over-shoulder": "over your shoulder"
};

/** How well a detected camera angle serves the one the spec asked for: 1 same, 0.85 close, 0.5 wrong. */
export function angleFactor(wanted: string | undefined, detected: string | undefined): number {
  if (!wanted || wanted === "any" || !detected || detected === "any" || wanted === detected) return 1;
  const pair = [wanted, detected].sort().join("|");
  if (pair === "side|side-45" || pair === "front|side-45" || pair === "back|side-45") return 0.85;
  return 0.5;
}

export function angleInstruction(wanted: string): string {
  return `Place the phone ${ANGLE_WORDS[wanted] ?? wanted} for this drill, then record again.`;
}

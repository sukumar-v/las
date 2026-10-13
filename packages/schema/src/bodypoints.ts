/**
 * Standard body point names: MediaPipe naming for body, hands and face, plus object classes.
 * Metric specs may only reference these (and derived names like `vertical`, `horizontal`, `ground`).
 */
export const POSE_LANDMARKS = [
  "nose",
  "left_eye_inner",
  "left_eye",
  "left_eye_outer",
  "right_eye_inner",
  "right_eye",
  "right_eye_outer",
  "left_ear",
  "right_ear",
  "mouth_left",
  "mouth_right",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_pinky",
  "right_pinky",
  "left_index",
  "right_index",
  "left_thumb",
  "right_thumb",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
  "left_foot_index",
  "right_foot_index"
] as const;
export type PoseLandmark = (typeof POSE_LANDMARKS)[number];

export const HAND_LANDMARKS = [
  "wrist",
  "thumb_cmc",
  "thumb_mcp",
  "thumb_ip",
  "thumb_tip",
  "index_mcp",
  "index_pip",
  "index_dip",
  "index_tip",
  "middle_mcp",
  "middle_pip",
  "middle_dip",
  "middle_tip",
  "ring_mcp",
  "ring_pip",
  "ring_dip",
  "ring_tip",
  "pinky_mcp",
  "pinky_pip",
  "pinky_dip",
  "pinky_tip"
] as const;
export type HandLandmark = (typeof HAND_LANDMARKS)[number];

/** Hand points are addressed as `left_hand.index_tip` / `right_hand.index_tip`. */
export const HAND_PREFIXES = ["left_hand", "right_hand"] as const;

/** A useful subset of the 478 face mesh points, by name. Index is the MediaPipe face mesh index. */
export const FACE_LANDMARKS: Record<string, number> = {
  face_nose_tip: 1,
  face_chin: 152,
  face_forehead: 10,
  face_left_eye_outer: 33,
  face_left_eye_inner: 133,
  face_right_eye_outer: 263,
  face_right_eye_inner: 362,
  face_mouth_left: 61,
  face_mouth_right: 291,
  face_upper_lip: 13,
  face_lower_lip: 14,
  face_left_cheek: 234,
  face_right_cheek: 454
};

/** Derived (virtual) points and directions a metric spec can use. */
export const DERIVED_POINTS = ["vertical", "horizontal", "ground", "mid_hip", "mid_shoulder", "center_of_mass", "head"] as const;

/** Object classes from the COCO label set used by the MediaPipe object detector. */
export const OBJECT_CLASSES = [
  "person", "bicycle", "car", "sports ball", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "cup", "fork", "knife", "spoon", "bowl", "chair", "frisbee", "skis", "snowboard", "kite", "book", "clock", "scissors", "cell phone", "laptop", "keyboard", "mouse", "remote"
] as const;

/** Objects are addressed as `object.sports_ball`. */
export const OBJECT_PREFIX = "object";

export const POSE_GROUPS: Record<string, PoseLandmark[]> = {
  legs: ["left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"],
  hips: ["left_hip", "right_hip"],
  arms: ["left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"],
  torso: ["left_shoulder", "right_shoulder", "left_hip", "right_hip"],
  feet: ["left_ankle", "right_ankle", "left_heel", "right_heel", "left_foot_index", "right_foot_index"],
  head: ["nose", "left_eye", "right_eye", "left_ear", "right_ear"],
  all: [...POSE_LANDMARKS]
};

/** Is `name` a valid point reference (`left_hip`, `left_hand.index_tip`, `object.sports_ball`, `vertical`)? */
export function isKnownPoint(name: string): boolean {
  if ((POSE_LANDMARKS as readonly string[]).includes(name)) return true;
  if ((DERIVED_POINTS as readonly string[]).includes(name)) return true;
  if (name in FACE_LANDMARKS) return true;
  const dot = name.indexOf(".");
  if (dot > 0) {
    const prefix = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    if ((HAND_PREFIXES as readonly string[]).includes(prefix)) return (HAND_LANDMARKS as readonly string[]).includes(rest);
    if (prefix === OBJECT_PREFIX) return (OBJECT_CLASSES as readonly string[]).includes(rest.replace(/_/g, " "));
  }
  return false;
}

/** Which tracker a point needs. */
export function trackerFor(name: string): "pose" | "hands" | "face" | "objects" | "derived" {
  if (name.startsWith("left_hand.") || name.startsWith("right_hand.")) return "hands";
  if (name.startsWith("object.")) return "objects";
  if (name in FACE_LANDMARKS) return "face";
  if ((DERIVED_POINTS as readonly string[]).includes(name)) return "derived";
  return "pose";
}

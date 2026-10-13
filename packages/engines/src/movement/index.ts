/**
 * Movement engine: measures body movement from tracked points, configured by a metric spec.
 * It never knows which skill it is measuring; the spec says what to measure and what counts as a mistake.
 */
export { analyzeMovement, POSE_EDGES, type MovementContext } from "./analyze.js";
export { compareToReference, dtwPath, resolveJoints, SIMILARITY_SCALE, type ReferenceComparison, type CompareOptions } from "./reference.js";
export { alignToBeats, landingTimes, type AlignResult } from "./beats.js";
export { framingCheck, framingInstruction, type FramingResult } from "./quality.js";
export { OneEuroFilter, oneEuro, smoothFrames, ONE_EURO_DEFAULTS, type OneEuroOptions, type SmoothOptions } from "./one-euro.js";
export { repSegments, moveSegments, holdSegments, phraseSegments, type Segment as MovementSegment, type SegmentKind as MovementSegmentKind } from "./segment.js";
export {
  syntheticPose,
  squatSequence,
  stepsOnBeats,
  holdSequence,
  swingSequence,
  hidePosePoints,
  addPoseNoise,
  delayPoseFrames,
  type SyntheticClip,
  type SquatOptions,
  type SquatTruth,
  type StepsOptions,
  type StepsTruth,
  type HoldOptions,
  type HoldTruth,
  type SwingOptions,
  type SwingTruth
} from "./synthetic.js";

import { z } from "zod";
import { AnalysisSchema } from "./analysis.js";
import { DrillOutcomeSchema } from "./drill.js";

/** Events the studio sends to the server. */
export const StudioEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.started"), sessionId: z.string(), at: z.string().optional() }),
  z.object({ type: z.literal("session.completed"), sessionId: z.string(), minutes: z.number().min(0), at: z.string().optional() }),
  z.object({ type: z.literal("block.completed"), sessionId: z.string(), block: z.string(), durationS: z.number().min(0) }),
  z.object({ type: z.literal("drill.outcome"), sessionId: z.string().optional(), outcome: DrillOutcomeSchema }),
  z.object({ type: z.literal("review.graded"), cardId: z.string(), grade: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }),
  z.object({ type: z.literal("attempt.captured"), attemptId: z.string(), mediaRef: z.string().optional() }),
  z.object({ type: z.literal("attempt.analyzed"), attemptId: z.string(), analysis: AnalysisSchema }),
  z.object({ type: z.literal("attempt.disputed"), attemptId: z.string(), mistakeId: z.string(), consentToTune: z.boolean().default(false) }),
  z.object({ type: z.literal("pain.reported"), sk: z.string(), area: z.string(), level: z.number().int().min(1).max(5) }),
  z.object({ type: z.literal("checkin.answered"), checkinId: z.string(), option: z.string() }),
  z.object({ type: z.literal("placement.adjusted"), intakeId: z.string(), delta: z.union([z.literal(-1), z.literal(1)]) }),
  z.object({ type: z.literal("theme.changed"), themeId: z.string(), scope: z.string() }),
  // live coach (docs/design/live-coach.md §6)
  z.object({ type: z.literal("screen.viewed"), sessionId: z.string(), screenId: z.string(), previous: z.object({ screenId: z.string(), seconds: z.number().min(0) }).optional(), at: z.string().optional() }),
  z.object({ type: z.literal("card.answered"), sessionId: z.string(), screenId: z.string(), card: z.number().int().min(0), cardType: z.string(), answer: z.unknown(), correct: z.boolean().optional(), seconds: z.number().min(0).optional() }),
  z.object({ type: z.literal("learner.asked"), sessionId: z.string(), screenId: z.string().optional(), text: z.string().min(1).max(280) }),
  z.object({ type: z.literal("learner.hesitated"), sessionId: z.string(), screenId: z.string(), seconds: z.number().min(0) }),
  z.object({ type: z.literal("session.paused"), sessionId: z.string(), reason: z.enum(["learner", "pain"]).default("learner") }),
  z.object({ type: z.literal("session.resumed"), sessionId: z.string(), pausedSeconds: z.number().min(0).default(0) }),
  z.object({ type: z.literal("session.left"), sessionId: z.string(), reason: z.enum(["closed", "studio-offline"]).default("closed") }),
  /** the learner tapped an option on a plan screen */
  z.object({ type: z.literal("plan.chosen"), sessionId: z.string(), screenId: z.string(), optionId: z.string() })
]);
export type StudioEvent = z.infer<typeof StudioEventSchema>;

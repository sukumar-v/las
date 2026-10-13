import type { Scenario } from "../src/harness.js";
import { salsaRoutine } from "./salsa-routine.js";
import { strengthWorkout } from "./strength-workout.js";
import { yogaFlow } from "./yoga-flow.js";
import { runningForm } from "./running-form.js";
import { golfSwing } from "./golf-swing.js";
import { bouldering } from "./bouldering.js";
import { juggling } from "./juggling.js";
import { piano } from "./piano.js";
import { singing } from "./singing.js";
import { drums } from "./drums.js";
import { japanese } from "./japanese.js";
import { mandarin } from "./mandarin.js";
import { spanish } from "./spanish.js";
import { asl } from "./asl.js";
import { publicSpeaking } from "./public-speaking.js";
import { rust } from "./rust.js";
import { go } from "./go.js";
import { java } from "./java.js";
import { c } from "./c.js";
import { sql } from "./sql.js";
import { javascript } from "./javascript.js";
import { python } from "./python.js";
import { chess } from "./chess.js";
import { drawing } from "./drawing.js";
import { calligraphy } from "./calligraphy.js";
import { cooking } from "./cooking.js";
import { typing } from "./typing.js";

/** One scenario per coverage target in docs/design/any-skill.md §8 (the code and language rows split per language). */
export const SCENARIOS: Scenario[] = [
  salsaRoutine,
  strengthWorkout,
  yogaFlow,
  runningForm,
  golfSwing,
  bouldering,
  juggling,
  piano,
  singing,
  drums,
  japanese,
  mandarin,
  spanish,
  asl,
  publicSpeaking,
  rust,
  go,
  java,
  c,
  sql,
  javascript,
  python,
  chess,
  drawing,
  calligraphy,
  cooking,
  typing
];

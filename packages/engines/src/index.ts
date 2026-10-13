/** Browser-safe entry: every engine's analyzer plus the metric-spec interpreter and synthetic fixtures. */
export * from "./types.js";
export * from "./common/analysis.js";
export * from "./movement/index.js";
export * from "./sensor/index.js";
export * from "./audio/index.js";
export * from "./speech/index.js";
export * from "./code/index.js";
export * from "./visual/index.js";
export * from "./knowledge/index.js";
export * from "./interaction/index.js";
export * from "./game/index.js";
export * from "./self-report/index.js";
export { analyze } from "./dispatch.js";

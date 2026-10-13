import { buildModel } from "./common.js";

/** Speech: repeat a short sentence; measured for words recognized and pace. */
export const speechModel = buildModel({
  skill: "e2e speech skill",
  name: "Test phrases",
  noun: "the test phrases",
  physical: false,
  engine: "speech",
  perform: { id: "say", type: "say-it", title: "Say the phrase", prompt: "Say: the cat sat on the mat", spec: "say-spec" },
  specs: {
    "say-spec": { kind: "speech", language: "en", target: "the cat sat on the mat", mistakes: [{ id: "missed-words", when: "intelligibility < 0.95", fix_drill: "basics-fix" }] }
  },
  mistake: { id: "missed-words", name: "Missed words", metric: "intelligibility", when: "intelligibility < 0.95", headline: "Two words got lost" },
  key_metric: { id: "clarity", label: "Words understood", metric: "intelligibility", unit: "%", better: "higher", format: "percent" },
  proof: { label: "The phrase, every word clear", criteria: [{ id: "clear", label: "Every word clear", check: "intelligibility >= 0.95" }] }
});

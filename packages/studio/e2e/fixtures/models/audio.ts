import { buildModel } from "./common.js";

/** Audio: a short melody played to a click, measured for pitch and timing. */
export const audioModel = buildModel({
  skill: "e2e audio skill",
  name: "Test melody",
  noun: "the test melody",
  physical: false,
  engine: "audio",
  perform: { id: "melody", type: "play-along", title: "Play the phrase", prompt: "Play the four notes with the click", spec: "melody-spec" },
  specs: {
    "melody-spec": {
      kind: "audio",
      reference: { notes: [["C4", 1], ["E4", 1], ["G4", 1], ["C5", 1]] },
      tempo: 90,
      grade: ["pitch", "rhythm"],
      playback: "metronome",
      tolerance: { pitch_cents: 20, onset_ms: 60 },
      mistakes: [{ id: "off-pitch", when: "mean_abs_cents > 25", fix_drill: "basics-fix" }]
    }
  },
  mistake: { id: "off-pitch", name: "Off pitch", metric: "mean_abs_cents", when: "mean_abs_cents > 25", headline: "Some notes are sharp" },
  key_metric: { id: "pitch", label: "Pitch accuracy", metric: "pitch_accuracy", unit: "%", better: "higher", format: "percent" },
  proof: { label: "The phrase in tune", criteria: [{ id: "pitch", label: "In tune", check: "pitch_accuracy >= 0.8" }] }
});

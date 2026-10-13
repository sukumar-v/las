import { buildModel } from "./common.js";

/** Visual: a photo of finished work, measured for light; the rest is graded later from the rubric. */
export const visualModel = buildModel({
  skill: "e2e visual skill",
  name: "Test photos",
  noun: "test photos",
  physical: false,
  engine: "visual",
  perform: { id: "photo", type: "make", title: "Photograph your work", prompt: "Add a photo of your work", spec: "photo-rubric" },
  specs: {
    "photo-rubric": {
      kind: "rubric",
      criteria: [
        { id: "light", label: "Even light", levels: { "1": "Too dark or too bright", "2": "Some clipping", "3": "Even light" }, measure: "exposure()", level_from: "if(mean_luma < 0.25, 1, if(mean_luma > 0.85, 2, 3))" },
        { id: "framing", label: "Work fills the frame", levels: { "1": "Small in the frame", "2": "Mostly fills it", "3": "Fills the frame" } }
      ],
      must_cite: "region",
      taps: [{ id: "center", prompt: "Tap the middle of your work" }]
    }
  },
  mistake: { id: "light", name: "Dark photo", metric: "light_level", when: "light_level < 3", headline: "The photo is too dark" },
  key_metric: { id: "light", label: "Light level", metric: "light_level", unit: "", better: "higher", format: "number" },
  proof: { label: "A clear photo of your work", criteria: [{ id: "light", label: "Even light", check: "light >= 3" }] }
});

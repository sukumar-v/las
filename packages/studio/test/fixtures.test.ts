import { describe, expect, it } from "vitest";
import { validateSkillModel } from "@las/schema";
import { analyze } from "@las/engines";
import { movementModel } from "../e2e/fixtures/models/movement.js";
import { audioModel } from "../e2e/fixtures/models/audio.js";
import { speechModel } from "../e2e/fixtures/models/speech.js";
import { codeModel } from "../e2e/fixtures/models/code.js";
import { visualModel } from "../e2e/fixtures/models/visual.js";
import { EVIDENCE } from "../e2e/fixtures/evidence.js";
import { reviveEvidence } from "../src/capture/fixture.js";

/** The end-to-end journeys' test data: valid skill models, and evidence that shows each model's one mistake. */
const MODELS = { movement: movementModel, audio: audioModel, speech: speechModel, code: codeModel, visual: visualModel };

describe("e2e fixture models", () => {
  for (const [engine, model] of Object.entries(MODELS)) {
    it(`${engine}: validates, and its fixture evidence shows the mistake with a fix drill`, async () => {
      const v = validateSkillModel(model);
      expect(v.ok, JSON.stringify(v.errors)).toBe(true);
      const m = v.model!;
      const drill = m.drills.find((d) => d.nodes.includes("basics") && d.spec && m.specs[d.spec].kind !== "items")!;
      let ev: any = reviveEvidence((EVIDENCE as any)[engine]());
      if (engine === "code") ev = { files: ev.files, result: { runner: "browser", language: "javascript", tests: [{ label: "add(1, 2)", hidden: false, pass: false, expected: "3", got: "-1" }, { label: "add(2, 2)", hidden: false, pass: false, expected: "4", got: "0" }], timeMs: 1 } };
      const a = await analyze(m.specs[drill.spec!], ev, { specId: drill.spec });
      expect(a.quality.ok).toBe(true);
      const mistake = m.mistakes[0];
      const seen = a.mistakes.find((x) => x.id === mistake.id);
      expect(seen, JSON.stringify(a.mistakes)).toBeDefined();
      expect(seen!.confidence).toBeGreaterThanOrEqual(0.7);
      expect(m.drills.some((d) => d.id === mistake.fix_drill)).toBe(true);
    });
  }
});

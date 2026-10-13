import { recordFallbacks, type Scenario } from "../src/harness.js";

/**
 * Drawing from observation: graded with rubrics that cite a region, backed by measurements from points the learner
 * taps (proportions, angles). Subjective criteria stay rubric levels with a confidence.
 */
export const drawing: Scenario = {
  id: "drawing",
  skill: "drawing",
  notes: "Wants to sketch people in cafés. Draws stick figures now. Has a sketchbook and pencils.",
  expect: { engines: ["visual"], main: "visual", fallback: "self-report", physical: false, supervisedOnly: [] },
  build: (draft) => ({
    skill: "drawing",
    name: "Drawing",
    noun: "drawing",
    source: "generated",
    physical: false,
    engines: ["visual", "knowledge", "self-report"],
    fallbacks: recordFallbacks(draft, { visual: "self-report" }),
    why: [
      { id: "sketch", label: "Sketch what I see" },
      { id: "relax", label: "A calm hobby" },
      { id: "people", label: "Draw people" },
      { id: "share", label: "Share my sketchbook" }
    ],
    pictures: [
      { id: "cafe", label: "Sketching people in cafés", why: ["people", "sketch"], ladderStep: 5, milestone: "A five-minute figure with sound proportions", proof: "A photo of a figure sketch, proportions within 15%", focus: { Fundamentals: 30, Observation: 45, Theory: 25 } },
      { id: "objects", label: "Still lifes at home", why: ["relax", "sketch"], ladderStep: 3, milestone: "A still life with believable shading", proof: "A photo of a shaded still life, three values", focus: { Fundamentals: 40, Observation: 40, Theory: 20 } },
      { id: "book", label: "A sketchbook I'm proud of", why: ["share", "relax"], ladderStep: 4, milestone: "Objects in correct perspective", proof: "A photo of a box drawing, lines meeting near the vanishing point", focus: { Fundamentals: 35, Observation: 35, Theory: 30 } }
    ],
    probes: [
      { id: "level", type: "scale", question: "How much have you drawn?", options: [{ value: 0, label: "Stick figures" }, { value: 1, label: "Doodles" }, { value: 2, label: "Some sketching" }, { value: 3, label: "A regular practice" }] },
      { id: "sample", type: "record", question: "Photograph one quick sketch of a mug. Optional.", spec: "line-rubric", optional: true }
    ],
    placement: [
      { when: "!fresh && level >= 3", step: 3, evidence: "Sketches regularly" },
      { when: "level >= 2", step: 1, evidence: "Some sketching" }
    ],
    ladder: [
      { id: "start", label: "Brand new", hours: [0, 0] },
      { id: "lines", label: "Confident lines", hours: [2, 5], nodes: ["lines"],
        proof: { engine: "visual", spec: "line-rubric", label: "A page of straight lines and ellipses, graded for confidence", criteria: [{ id: "lines", label: "Single confident strokes", check: "line_confidence_level >= 2" }], fallback: "self-report", fallback_spec: "sketch-photo" } },
      { id: "shapes", label: "Seeing simple shapes", hours: [3, 6], nodes: ["shapes"],
        proof: { engine: "visual", spec: "shape-rubric", label: "A mug drawn as cylinder and ellipses, ellipses even", criteria: [{ id: "ellipse", label: "Even ellipses", check: "ellipses_level >= 2" }], fallback: "self-report", fallback_spec: "sketch-photo" } },
      { id: "values", label: "Light and shadow in three values", hours: [5, 10], nodes: ["values"],
        proof: { engine: "visual", spec: "value-rubric", label: "A still life with clear light, mid and dark values", criteria: [{ id: "values", label: "Three values", check: "value_range_level >= 2" }, { id: "light", label: "Consistent light", check: "light_direction_level >= 2" }], fallback: "self-report", fallback_spec: "sketch-photo" } },
      { id: "perspective", label: "Boxes in perspective", hours: [5, 10], nodes: ["perspective"],
        proof: { engine: "visual", spec: "perspective-rubric", label: "Three boxes in two-point perspective, lines converging", criteria: [{ id: "converge", label: "Lines converge", check: "convergence_level >= 2" }], fallback: "self-report", fallback_spec: "sketch-photo" } },
      { id: "figures", label: "Figures with sound proportions", hours: [10, 25], nodes: ["proportions"],
        proof: { engine: "visual", spec: "figure-rubric", label: "A standing figure, proportions within 15% of eight heads", criteria: [{ id: "prop", label: "Proportions", check: "proportions_level >= 2" }, { id: "gesture", label: "Gesture", check: "gesture_level >= 2" }], fallback: "self-report", fallback_spec: "sketch-photo" } }
    ],
    nodes: [
      { id: "lines", name: "Confident lines", lesson: "lines-lesson", drills: ["line-page"], mistakes: ["hairy-lines"], review: { prompt: "Draw from the wrist or the shoulder for long lines?", kind: "choice", options: ["Shoulder", "Wrist"], answer: 0 }, focus: "Fundamentals" },
      { id: "shapes", name: "Simple shapes", requires: ["lines"], lesson: "shapes-lesson", drills: ["shape-mug", "shape-quiz"], review: { prompt: "A mug's top seen from above the rim is...", kind: "choice", options: ["An ellipse", "A circle"], answer: 0 }, focus: "Observation" },
      { id: "values", name: "Values", requires: ["shapes"], lesson: "values-lesson", drills: ["value-study"], mistakes: ["flat-values"], review: { prompt: "Where is the darkest shadow?", kind: "choice", options: ["Where the object meets the table", "The lit side"], answer: 0 }, focus: "Observation" },
      { id: "perspective", name: "Perspective", requires: ["shapes"], lesson: "perspective-lesson", drills: ["box-page", "vp-quiz"], review: { prompt: "Parallel edges going away meet at...", kind: "choice", options: ["A vanishing point", "Nowhere"], answer: 0 }, focus: "Theory" },
      { id: "proportions", name: "Figure proportions", requires: ["values", "perspective"], lesson: "figure-lesson", drills: ["figure-sketch"], mistakes: ["big-head"], review: { prompt: "An adult is about how many heads tall?", kind: "choice", options: ["Seven to eight", "Five"], answer: 0 }, focus: "Observation" }
    ],
    lessons: [
      { id: "lines-lesson", title: "Confident lines", nodes: ["lines"], cards: [
        { type: "predict", text: "Many short strokes or one long stroke: which looks surer?", options: ["One long stroke", "Many short ones"], answer: 0 },
        { type: "compare", text: "Tap the hairy line.", left: { kind: "figure", points: { a: [10, 50], b: [90, 50] }, segments: [["a", "b"]] }, right: { kind: "figure", points: { a: [10, 50], b: [30, 52], c: [28, 49], d: [55, 51], e: [52, 48], f: [90, 50] }, segments: [["a", "b"], ["c", "d"], ["e", "f"]], marks: [{ at: "c", label: "re-stroke", role: "attention" }] }, answer: "right" }
      ] },
      { id: "shapes-lesson", title: "Simple shapes", nodes: ["shapes"], cards: [
        { type: "predict", text: "A mug is mostly which shape?", options: ["A cylinder", "A cube"], answer: 0 },
        { type: "diagram", text: "Cylinder, two ellipses, one handle.", figure: { kind: "figure", points: { tl: [30, 20], tr: [70, 20], bl: [30, 85], br: [70, 85], h1: [72, 35], h2: [85, 55], h3: [72, 70] }, segments: [["tl", "bl"], ["tr", "br"], ["h1", "h2"], ["h2", "h3"]], marks: [{ at: "tl", label: "ellipse", role: "reference" }] } }
      ] },
      { id: "values-lesson", title: "Light and shadow", nodes: ["values"], cards: [
        { type: "predict", text: "A drawing with only mid-greys looks...", options: ["Flat", "Dramatic"], answer: 0 },
        { type: "sim", text: "Move the light. Watch where the shadow falls.", sim: { title: "Light direction", params: { light_deg: { label: "Light angle", min: 0, max: 180, default: 45, unit: "deg" } }, formulas: { shadow_x: "50 - 40 * cos(rad(light_deg))", shadow_y: "80" }, figure: { kind: "linkage", points: { ball: ["50", "50"], shadow: ["shadow_x", "shadow_y"] }, segments: [["ball", "shadow"]] }, readout: [{ value: "light_deg", label: "Light", unit: "deg" }] } },
        { type: "compare", text: "Tap the flat study.", left: { kind: "chart", type: "bar", series: [{ label: "Value", values: [10, 50, 90] }], labels: ["Light", "Mid", "Dark"] }, right: { kind: "chart", type: "bar", series: [{ label: "Value", values: [45, 50, 55] }], labels: ["Light", "Mid", "Dark"] }, answer: "right" }
      ] },
      { id: "perspective-lesson", title: "Perspective", nodes: ["perspective"], cards: [
        { type: "predict", text: "Railway tracks going away look like they...", options: ["Meet", "Stay parallel"], answer: 0 },
        { type: "diagram", text: "Two vanishing points on the horizon line.", figure: { kind: "figure", points: { vp1: [0, 30], vp2: [100, 30], top: [50, 45], left: [30, 40], right: [70, 40] }, segments: [["vp1", "top"], ["vp2", "top"], ["vp1", "right"], ["vp2", "left"]], marks: [{ at: "vp1", label: "VP", role: "reference" }, { at: "vp2", label: "VP", role: "reference" }] } }
      ] },
      { id: "figure-lesson", title: "Figure proportions", nodes: ["proportions"], cards: [
        { type: "predict", text: "Where is the halfway point of a standing adult?", options: ["The hips", "The belly button"], answer: 0 },
        { type: "compare", text: "Tap the figure with a big head.", left: { kind: "figure", points: { head: [50, 6], chin: [50, 12], hip: [50, 50], feet: [50, 98] }, segments: [["head", "chin"], ["chin", "hip"], ["hip", "feet"]] }, right: { kind: "figure", points: { head: [50, 5], chin: [50, 25], hip: [50, 60], feet: [50, 98] }, segments: [["head", "chin"], ["chin", "hip"], ["hip", "feet"]], marks: [{ at: "chin", label: "big head", role: "attention" }] }, answer: "right" }
      ] }
    ],
    drills: [
      { id: "line-page", type: "make", title: "A page of lines", prompt: "Fill a page with straight lines and ellipses from the shoulder. Photograph it.", nodes: ["lines"], spec: "line-rubric", success: "line_confidence_level >= 2", difficulty: { param: "rubric level", levels: [2, 3] }, minutes: 10, intensity: 1, focus: "Fundamentals", fixes: ["hairy-lines"] },
      { id: "shape-mug", type: "make", title: "Mug as shapes", prompt: "Draw a mug as a cylinder with two ellipses. Photograph it flat.", nodes: ["shapes"], spec: "shape-rubric", success: "ellipses_level >= 2", minutes: 10, intensity: 1, focus: "Observation" },
      { id: "shape-quiz", type: "choice", title: "Which shape?", prompt: "Pick the simple shape under each object.", nodes: ["shapes"], spec: "drawing-quiz", minutes: 3, intensity: 1, focus: "Theory" },
      { id: "value-study", type: "make", title: "Three-value study", prompt: "Shade an egg under one lamp using three values. Photograph it.", nodes: ["values"], spec: "value-rubric", success: "value_range_level >= 2", difficulty: { param: "values", levels: [3, 5] }, minutes: 15, intensity: 1, focus: "Observation", fixes: ["flat-values"] },
      { id: "box-page", type: "make", title: "Boxes in perspective", prompt: "Draw three boxes in two-point perspective. Tap the vanishing points.", nodes: ["perspective"], spec: "perspective-rubric", success: "convergence_level >= 2", minutes: 15, intensity: 1, focus: "Theory" },
      { id: "vp-quiz", type: "hotspot", title: "Find the vanishing point", prompt: "Tap where the lines meet.", nodes: ["perspective"], spec: "drawing-quiz", minutes: 3, intensity: 1, focus: "Theory" },
      { id: "figure-sketch", type: "make", title: "Five-minute figure", prompt: "Sketch a standing person in five minutes. Tap head top, chin, hips and feet.", nodes: ["proportions"], spec: "figure-rubric", success: "proportions_level >= 2", difficulty: { param: "time", levels: ["10 min", "5 min", "2 min"] }, minutes: 10, intensity: 1, focus: "Observation", fixes: ["big-head"] }
    ],
    specs: {
      "line-rubric": { kind: "rubric", criteria: [{ id: "line_confidence", label: "Line confidence", levels: { "1": "Hesitant, many re-strokes", "2": "Mostly single strokes", "3": "Single confident strokes throughout" }, measure: "line_count(page)" }], must_cite: "region", pass: "line_confidence >= 2" },
      "shape-rubric": { kind: "rubric", criteria: [{ id: "ellipses", label: "Ellipses", levels: { "1": "Pointed or lopsided", "2": "Mostly even", "3": "Even, matching the eye level" }, measure: "symmetry(ellipse)" }, { id: "construction", label: "Construction", levels: { "1": "Outline only", "2": "Cylinder visible", "3": "Cylinder and centre line" } }], must_cite: "region", taps: [{ id: "ellipse_left", prompt: "Tap the left end of the top ellipse" }, { id: "ellipse_right", prompt: "Tap the right end of the top ellipse" }], pass: "ellipses >= 2" },
      "value-rubric": { kind: "rubric", criteria: [{ id: "value_range", label: "Value range", levels: { "1": "Mostly one grey", "2": "Light, mid and dark", "3": "Full range with soft transitions" }, measure: "exposure(drawing)", weight: 2 }, { id: "light_direction", label: "Light direction", levels: { "1": "Shadows disagree", "2": "Mostly consistent", "3": "One clear light source" } }], must_cite: "region", pass: "value_range >= 2 && light_direction >= 2" },
      "perspective-rubric": { kind: "rubric", criteria: [{ id: "convergence", label: "Lines converge", levels: { "1": "Lines parallel or random", "2": "Most lines head to the points", "3": "All receding lines meet their points" }, measure: "angle(vp_left, box_corner, vp_right)" }], must_cite: "region", taps: [{ id: "vp_left", prompt: "Tap the left vanishing point" }, { id: "vp_right", prompt: "Tap the right vanishing point" }, { id: "box_corner", prompt: "Tap the nearest box corner" }], pass: "convergence >= 2" },
      "figure-rubric": {
        kind: "rubric",
        criteria: [
          { id: "proportions", label: "Proportions", levels: { "1": "Off by more than 25%", "2": "Within 15% of eight heads", "3": "Within 10%" }, measure: "tapped_points(head_top, chin, hips, feet)", level_from: "if(ratio_error < 0.1, 3, if(ratio_error < 0.15, 2, 1))", weight: 2 },
          { id: "gesture", label: "Gesture", levels: { "1": "Stiff, symmetric", "2": "A clear line of action", "3": "Weight shift reads at a glance" } }
        ],
        must_cite: "region",
        taps: [{ id: "head_top", prompt: "Tap the top of the head" }, { id: "chin", prompt: "Tap the chin" }, { id: "hips", prompt: "Tap the hips" }, { id: "feet", prompt: "Tap the feet" }],
        pass: "proportions >= 2 && gesture >= 2"
      },
      "drawing-quiz": {
        kind: "items",
        items: [
          { type: "choice", id: "d1", prompt: "The simple shape under a mug?", options: ["Cylinder", "Cube", "Sphere"], answer: 0, difficulty: 1, nodes: ["shapes"] },
          { type: "hotspot", id: "d2", prompt: "Tap the vanishing point of the road.", figure: "road-photo", region: { x: 0.52, y: 0.38, r: 0.05 }, difficulty: 2, nodes: ["perspective"] },
          { type: "choice", id: "d3", prompt: "An adult is about how many heads tall?", options: ["Seven to eight", "Five", "Ten"], answer: 0, difficulty: 3, nodes: ["proportions"] }
        ]
      },
      "sketch-photo": { kind: "self-report", fields: ["done", "photo", "felt", "note"], criterion: "Photographed the drawing next to the reference, tapped the measuring points, and rated it against the rubric" }
    },
    mistakes: [
      { id: "hairy-lines", name: "Hairy lines", nodes: ["lines"], engine: "visual", detector: { metric: "line_confidence_level", when: "line_confidence_level < 2" }, severity: 1, explain: { lesson: "lines-lesson", card: 1 }, fix_drill: "line-page", headline: "Many short strokes per line" },
      { id: "flat-values", name: "Flat values", nodes: ["values"], engine: "visual", detector: { metric: "value_range_level", when: "value_range_level < 2" }, severity: 2, explain: { lesson: "values-lesson", card: 2 }, fix_drill: "value-study", headline: "Shading stays one mid-grey" },
      { id: "big-head", name: "Head too big", nodes: ["proportions"], engine: "visual", detector: { metric: "proportions_level", when: "proportions_level < 2" }, severity: 2, explain: { lesson: "figure-lesson", card: 1 }, fix_drill: "figure-sketch", headline: "The head is too big" }
    ],
    access: ["A sketchbook", "Pencils", "A phone camera"],
    focus: { Fundamentals: 35, Observation: 40, Theory: 25 },
    key_metrics: [
      { id: "score", label: "Rubric score", engine: "visual", metric: "score", unit: "%", better: "higher", format: "percent" },
      { id: "proportions", label: "Proportion level", engine: "visual", metric: "proportions_level", better: "higher", format: "number" }
    ],
    copy: { placeholder: "drawing, sketching, painting", blurb: "Lines, shapes, values, figures" },
    notes: "Engines: visual rubrics graded with the agent's own vision through submit_rubric_grade, always citing a region; tapped points back up proportions and perspective with measurements. Drawing is subjective, so levels come with a confidence and the learner can ask for a human review. If no vision is available, the learner photographs the work, taps the points and self-reports against the rubric. Hours are estimates, shown as ranges."
  })
};

import { recordFallbacks, type Scenario } from "../src/harness.js";

/**
 * Public speaking: pace, pauses and fillers (speech), posture and gestures (movement), slides (visual rubric).
 * "Engaging" is a rubric judgement with cited timestamps, never a single number.
 */
export const publicSpeaking: Scenario = {
  id: "public-speaking",
  skill: "public speaking",
  notes: "Has to give a five-minute talk at a team offsite in two months. Says 'um' a lot and reads from slides.",
  expect: { engines: ["speech", "movement", "visual"], main: "speech", fallback: "self-report", physical: false, supervisedOnly: [] },
  build: (draft) => ({
    skill: "public speaking",
    name: "Public speaking",
    noun: "public speaking",
    source: "generated",
    physical: false,
    engines: ["speech", "movement", "visual", "knowledge", "self-report"],
    fallbacks: recordFallbacks(draft, { speech: "self-report", movement: "self-report", visual: "self-report" }),
    why: [
      { id: "work", label: "Talks at work" },
      { id: "nerves", label: "Calmer nerves" },
      { id: "career", label: "Grow my career" },
      { id: "toast", label: "A wedding toast" }
    ],
    pictures: [
      { id: "offsite", label: "A five-minute talk at the offsite", why: ["work", "career"], ladderStep: 5, milestone: "Five minutes, few fillers, eyes up", proof: "One five-minute take, fillers under ten", focus: { Fundamentals: 25, Delivery: 45, Content: 30 } },
      { id: "meeting", label: "Speaking up in meetings", why: ["work", "nerves"], ladderStep: 2, milestone: "A clear one-minute update", proof: "A one-minute update at a steady pace", focus: { Fundamentals: 40, Delivery: 40, Content: 20 } },
      { id: "toast", label: "A toast without notes", why: ["toast", "nerves"], ladderStep: 3, milestone: "Two minutes, no notes, steady posture", proof: "A two-minute take with steady posture", focus: { Fundamentals: 30, Delivery: 50, Content: 20 } }
    ],
    probes: [
      { id: "level", type: "scale", question: "How often do you speak to a group?", options: [{ value: 0, label: "Never" }, { value: 1, label: "Rarely, and I dread it" }, { value: 2, label: "Monthly" }, { value: 3, label: "Weekly" }] },
      { id: "worries", type: "multi", question: "What gets in your way?", optional: true, options: [{ value: "fillers", label: "Ums and ahs" }, { value: "speed", label: "Talking too fast" }, { value: "reading", label: "Reading my slides" }, { value: "still", label: "Standing frozen" }] }
    ],
    placement: [
      { when: "!fresh && level >= 3", step: 3, evidence: "Speaks weekly" },
      { when: "level >= 2", step: 1, evidence: "Speaks now and then" }
    ],
    ladder: [
      { id: "start", label: "Brand new", hours: [0, 0] },
      { id: "pace", label: "A calm pace with pauses", hours: [2, 4], nodes: ["pace"],
        proof: { engine: "speech", spec: "update-talk", label: "A one-minute update at 120 to 160 words per minute", criteria: [{ id: "pace", label: "Steady pace", check: "words_per_minute >= 120 && words_per_minute <= 160" }, { id: "pauses", label: "Some pauses", check: "pause_count >= 4" }], fallback: "self-report", fallback_spec: "replay-check" } },
      { id: "fillers", label: "Fewer fillers", hours: [3, 8], nodes: ["fillers"],
        proof: { engine: "speech", spec: "update-talk", label: "A one-minute update with three fillers or fewer", criteria: [{ id: "fillers", label: "Few fillers", check: "filler_count <= 3" }], fallback: "self-report", fallback_spec: "replay-check" } },
      { id: "presence", label: "Steady posture and open gestures", hours: [3, 8], nodes: ["presence"],
        proof: { engine: "movement", spec: "stage-presence", label: "Two minutes standing: little swaying, hands visible", criteria: [{ id: "sway", label: "Little sway", check: "sway <= 0.04" }, { id: "gestures", label: "Hands used", check: "gesture_share >= 0.3" }], capture: { angle: "front", fps: 30, duration_s: 120 }, fallback: "self-report" } },
      { id: "slides", label: "Slides that support you", hours: [3, 6], nodes: ["slides"],
        proof: { engine: "visual", spec: "slide-rubric", label: "Three slides graded: one idea each, few words", criteria: [{ id: "words", label: "Few words", check: "text_density_level >= 2" }, { id: "idea", label: "One idea", check: "one_idea_level >= 2" }], fallback: "self-report" } },
      { id: "talk", label: "A five-minute talk", hours: [8, 20], nodes: ["structure"],
        proof: { engine: "speech", spec: "full-talk", label: "Five minutes, fillers under ten, a clear opening and close", criteria: [{ id: "length", label: "Five minutes", check: "duration_s >= 270 && duration_s <= 330" }, { id: "fillers", label: "Few fillers", check: "filler_count <= 10" }], fallback: "self-report", fallback_spec: "replay-check" } }
    ],
    nodes: [
      { id: "pace", name: "Pace and pauses", lesson: "pace-lesson", drills: ["pace-drill"], mistakes: ["too-fast"], review: { prompt: "A good conversational pace is about...", kind: "choice", options: ["140 words a minute", "220 words a minute"], answer: 0 }, focus: "Fundamentals" },
      { id: "fillers", name: "Fewer fillers", requires: ["pace"], lesson: "filler-lesson", drills: ["pause-swap"], mistakes: ["fillers"], review: { prompt: "What replaces an 'um'?", kind: "choice", options: ["A silent pause", "A faster word"], answer: 0 }, focus: "Delivery" },
      { id: "presence", name: "Posture and gestures", lesson: "presence-lesson", drills: ["presence-drill"], mistakes: ["swaying"], review: { prompt: "Where do your hands rest between gestures?", kind: "choice", options: ["Loosely at waist height", "In pockets"], answer: 0 }, focus: "Delivery" },
      { id: "slides", name: "Slides", lesson: "slide-lesson", drills: ["slide-make", "slide-quiz"], review: { prompt: "How many ideas per slide?", kind: "choice", options: ["One", "Three"], answer: 0 }, focus: "Content" },
      { id: "structure", name: "Talk structure", requires: ["fillers", "presence", "slides"], lesson: "structure-lesson", drills: ["talk-run"], review: { prompt: "Name the three parts of a short talk.", kind: "recall" }, focus: "Content" }
    ],
    lessons: [
      { id: "pace-lesson", title: "Pace and pauses", nodes: ["pace"], cards: [
        { type: "predict", text: "Nervous speakers usually talk...", options: ["Faster", "Slower"], answer: 0 },
        { type: "sim", text: "Drag your pace. Watch how much a listener keeps.", sim: { title: "Pace and recall", params: { wpm: { label: "Words per minute", min: 80, max: 240, default: 180 } }, formulas: { recall_pct: "clamp(100 - abs(wpm - 145) * 0.6, 0, 100)" }, figure: { kind: "plot", x: "wpm", series: ["recall_pct"] }, readout: [{ value: "recall_pct", label: "Listener keeps", unit: "%" }] } },
        { type: "compare", text: "Tap the take that rushes.", left: { kind: "chart", type: "bar", series: [{ label: "wpm", values: [140, 150, 145] }] }, right: { kind: "chart", type: "bar", series: [{ label: "wpm", values: [190, 210, 205] }] }, answer: "right" }
      ] },
      { id: "filler-lesson", title: "Fillers", nodes: ["fillers"], cards: [
        { type: "predict", text: "To the audience, a one-second silence feels...", options: ["Confident", "Awkward"], answer: 0 },
        { type: "compare", text: "Tap the take with more fillers.", left: { kind: "chart", type: "dots", series: [{ label: "Fillers", values: [1, 0, 1] }] }, right: { kind: "chart", type: "dots", series: [{ label: "Fillers", values: [5, 6, 4] }] }, answer: "right" }
      ] },
      { id: "presence-lesson", title: "Posture and gestures", nodes: ["presence"], cards: [
        { type: "predict", text: "Swaying side to side reads as...", options: ["Nervous", "Relaxed"], answer: 0 },
        { type: "compare", text: "Tap the swaying speaker.", left: { kind: "chart", type: "line", series: [{ label: "Hips", values: [50, 50, 51, 50, 50] }] }, right: { kind: "chart", type: "line", series: [{ label: "Hips", values: [44, 56, 43, 57, 44] }] }, answer: "right" }
      ] },
      { id: "slide-lesson", title: "Slides", nodes: ["slides"], cards: [
        { type: "predict", text: "Reading a wordy slide aloud, the audience...", options: ["Reads ahead and stops listening", "Listens more"], answer: 0 },
        { type: "compare", text: "Tap the slide that competes with you.", left: { kind: "mechanism", concept: "slide with one chart and five words" }, right: { kind: "mechanism", concept: "slide with forty words of text" }, answer: "right" }
      ] },
      { id: "structure-lesson", title: "Structure", nodes: ["structure"], cards: [
        { type: "predict", text: "What should the first sentence do?", options: ["Hook with a question or story", "Thank everyone"], answer: 0 },
        { type: "diagram", text: "Hook, three points, one clear close.", figure: { kind: "graph", nodes: [{ id: "h", label: "Hook" }, { id: "p1", label: "Point 1" }, { id: "p2", label: "Point 2" }, { id: "p3", label: "Point 3" }, { id: "c", label: "Close" }], edges: [["h", "p1"], ["p1", "p2"], ["p2", "p3"], ["p3", "c"]] } }
      ] }
    ],
    drills: [
      { id: "pace-drill", type: "say-it", title: "One-minute update", prompt: "Give a one-minute update on your week. Pause at each full stop.", nodes: ["pace"], spec: "update-talk", success: "words_per_minute <= 165", difficulty: { param: "length", levels: ["30 s", "60 s", "90 s"] }, minutes: 4, intensity: 1, focus: "Fundamentals", fixes: ["too-fast"] },
      { id: "pause-swap", type: "say-it", title: "Pause, don't um", prompt: "Answer the question; when you'd say 'um', pause instead.", nodes: ["fillers"], spec: "update-talk", success: "filler_count <= 3", difficulty: { param: "length", levels: ["30 s", "60 s", "2 min"] }, minutes: 5, intensity: 1, focus: "Delivery", fixes: ["fillers"] },
      { id: "presence-drill", type: "move", title: "Stand and speak", prompt: "Two minutes standing, feet planted, hands free. Film from the front.", nodes: ["presence"], spec: "stage-presence", capture: { angle: "front", fps: 30, duration_s: 120 }, needs: ["A phone tripod"], success: "sway <= 0.05", difficulty: { param: "length", levels: ["1 min", "2 min", "5 min"] }, minutes: 5, intensity: 1, focus: "Delivery", fixes: ["swaying"] },
      { id: "slide-make", type: "make", title: "Redo one slide", prompt: "Rebuild your wordiest slide: one idea, a picture, few words. Upload it.", nodes: ["slides"], spec: "slide-rubric", success: "score >= 0.6", difficulty: { param: "rubric level", levels: [2, 3] }, minutes: 10, intensity: 1, focus: "Content" },
      { id: "slide-quiz", type: "choice", title: "Which slide works?", prompt: "Pick the slide that supports the speaker.", nodes: ["slides"], spec: "talk-quiz", minutes: 2, intensity: 1, focus: "Content" },
      { id: "talk-run", type: "say-it", title: "Full run-through", prompt: "Give your whole talk once, start to finish.", nodes: ["structure"], spec: "full-talk", success: "filler_count <= 10", difficulty: { param: "length", levels: ["2 min", "3 min", "5 min"] }, minutes: 10, intensity: 1, focus: "Content" }
    ],
    specs: {
      "update-talk": { kind: "speech", language: "en", prompt: "Give a one-minute update on your week.", pass: "words_per_minute >= 120 && words_per_minute <= 160 && filler_count <= 3", mistakes: [{ id: "too-fast", when: "words_per_minute > 170", severity: 2, fix_drill: "pace-drill" }, { id: "fillers", when: "filler_count > 5", severity: 2, fix_drill: "pause-swap" }] },
      "full-talk": {
        kind: "speech",
        language: "en",
        prompt: "Give your five-minute offsite talk.",
        rubric: { kind: "rubric", criteria: [{ id: "opening", label: "Opening hook", levels: { "1": "Starts with thanks or logistics", "2": "A plain topic statement", "3": "A question, story or striking fact" } }, { id: "engaging", label: "Engaging", levels: { "1": "Flat, read aloud", "2": "Some variety in voice", "3": "Varied voice, pauses for effect, speaks to the room" } }, { id: "close", label: "Clear close", levels: { "1": "Trails off", "2": "Summarizes", "3": "One clear takeaway or ask" } }], must_cite: "timestamp", pass: "opening >= 2 && close >= 2" },
        pass: "filler_count <= 10 && duration_s >= 270"
      },
      "stage-presence": {
        kind: "metric",
        capture: { angle: "front", fps: 30, guide: "Head to knees in frame, as the audience would see you" },
        segment: { by: "whole" },
        metrics: {
          sway: "std(mid_hip.x)",
          gesture_share: "share(left_wrist.y < left_hip.y || right_wrist.y < right_hip.y)",
          face_turns: "std(face_nose_tip.x)"
        },
        mistakes: [{ id: "swaying", when: "sway > 0.06", show: "overlay(mid_hip.x)", fix_drill: "presence-drill" }],
        requires_visible: ["left_hip", "right_hip", "left_wrist", "right_wrist"]
      },
      "slide-rubric": {
        kind: "rubric",
        criteria: [
          { id: "text_density", label: "Words on the slide", levels: { "1": "Paragraphs to read", "2": "A few bullet lines", "3": "Under ten words" }, measure: "text(slide)", weight: 2 },
          { id: "one_idea", label: "One idea", levels: { "1": "Several ideas compete", "2": "One idea with clutter", "3": "One idea, nothing else" } },
          { id: "contrast", label: "Readable from the back", levels: { "1": "Low contrast or tiny text", "2": "Readable up close", "3": "Readable from across a room" }, measure: "exposure(slide)" }
        ],
        must_cite: "region",
        taps: [{ id: "main_point", prompt: "Tap the one thing you want people to see" }],
        pass: "text_density >= 2 && one_idea >= 2"
      },
      "talk-quiz": {
        kind: "items",
        items: [
          { type: "choice", id: "q1", prompt: "Which slide supports a speaker best?", options: ["A chart and five words", "Forty words of bullets"], answer: 0, difficulty: 1, nodes: ["slides"] },
          { type: "order", id: "q2", prompt: "Order the parts of a short talk.", items: ["Hook", "Three points", "Clear close"], difficulty: 2, nodes: ["structure"] },
          { type: "choice", id: "q3", prompt: "A good conversational pace is about...", options: ["140 words a minute", "220 words a minute"], answer: 0, difficulty: 2, nodes: ["pace"] }
        ]
      },
      "replay-check": { kind: "self-report", fields: ["done", "count", "felt", "note"], criterion: "Recorded the talk on the phone, played it back next to the reference recording of your best take, and counted the fillers" }
    },
    mistakes: [
      { id: "too-fast", name: "Talking too fast", nodes: ["pace"], engine: "speech", detector: { metric: "words_per_minute", when: "words_per_minute > 170" }, severity: 2, explain: { lesson: "pace-lesson", card: 2 }, fix_drill: "pace-drill", headline: "Pace is above 170 words a minute" },
      { id: "fillers", name: "Fillers", nodes: ["fillers"], engine: "speech", detector: { metric: "filler_count", when: "filler_count > 5" }, severity: 2, explain: { lesson: "filler-lesson", card: 1 }, fix_drill: "pause-swap", headline: "Many ums where pauses fit" },
      { id: "swaying", name: "Swaying", nodes: ["presence"], engine: "movement", detector: { metric: "sway", when: "sway > 0.06" }, severity: 1, explain: { lesson: "presence-lesson", card: 1 }, fix_drill: "presence-drill", headline: "Hips sway side to side" }
    ],
    access: ["A phone tripod", "Your slides"],
    focus: { Fundamentals: 30, Delivery: 40, Content: 30 },
    key_metrics: [
      { id: "fillers", label: "Fillers per take", engine: "speech", metric: "filler_count", better: "lower", format: "count" },
      { id: "slides", label: "Slide rubric", engine: "visual", metric: "score", unit: "%", better: "higher", format: "percent" },
      { id: "sway", label: "Sway", engine: "movement", metric: "sway", better: "lower", format: "number" }
    ],
    copy: { placeholder: "public speaking, a toast, a pitch", blurb: "Calm pace, fewer ums, slides that help" },
    notes: "Engines: speech for pace, pauses, fillers and length (rubric for opening, engagement and close, citing timestamps); movement for posture and gestures from the front; visual rubric for slides, graded by the agent's vision through submit_rubric_grade with a cited region. Engaging is a judgement, so it is a rubric criterion and never the only check. If speech is missing, the learner replays the take next to a reference recording and self-reports. Hours are estimates, shown as ranges."
  })
};

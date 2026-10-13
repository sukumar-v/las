import { recordFallbacks, type Scenario } from "../src/harness.js";

/** Singing in tune: pitch and rhythm against a melody (audio). Tone colour is only partly measurable, so it's self-reported. */
export const singing: Scenario = {
  id: "singing",
  skill: "singing",
  notes: "Sings in the car, thinks they're off-key. Wants to sing at a friend's wedding in four months.",
  expect: { engines: ["audio"], main: "audio", fallback: "self-report", physical: true, supervisedOnly: [] },
  build: (draft) => ({
    skill: "singing",
    name: "Singing",
    noun: "singing",
    source: "generated",
    physical: true,
    engines: ["audio", "knowledge", "self-report"],
    fallbacks: recordFallbacks(draft, { audio: "self-report" }),
    why: [
      { id: "in-tune", label: "Sing in tune" },
      { id: "event", label: "Sing at an event" },
      { id: "joy", label: "It makes me happy" },
      { id: "choir", label: "Join a choir" }
    ],
    pictures: [
      { id: "wedding", label: "One song at a wedding", why: ["event", "joy"], ladderStep: 5, milestone: "A full verse and chorus in tune", proof: "One take of verse and chorus, in tune", focus: { Fundamentals: 30, Pitch: 40, Songs: 30 } },
      { id: "choir", label: "Holding my part in a choir", why: ["choir", "in-tune"], ladderStep: 4, milestone: "A phrase in tune over a drone", proof: "One take of the phrase over a drone", focus: { Fundamentals: 35, Pitch: 50, Songs: 15 } },
      { id: "car", label: "Singing along, in tune", why: ["joy", "in-tune"], ladderStep: 2, milestone: "Match five notes in a row", proof: "Five matched notes in one take", focus: { Fundamentals: 50, Pitch: 40, Songs: 10 } }
    ],
    probes: [
      { id: "level", type: "scale", question: "How much have you sung?", options: [{ value: 0, label: "Only in the car" }, { value: 1, label: "Karaoke sometimes" }, { value: 2, label: "A choir or lessons" }, { value: 3, label: "I perform" }] },
      { id: "match", type: "record", question: "Sing back the note you hear. Optional.", spec: "pitch-match", optional: true }
    ],
    placement: [
      { when: "!fresh && level >= 2", step: 2, evidence: "Has sung with others" },
      { when: "level >= 1", step: 1 }
    ],
    ladder: [
      { id: "start", label: "Brand new", hours: [0, 0] },
      { id: "breath", label: "Steady breath for a long note", hours: [1, 3], nodes: ["breath"],
        proof: { engine: "audio", spec: "long-note", label: "One note held eight seconds without wobbling", criteria: [{ id: "steady", label: "Steady pitch", check: "mean_abs_cents <= 30" }], fallback: "self-report" } },
      { id: "match", label: "Match single notes", hours: [2, 6], nodes: ["pitch-match"],
        proof: { engine: "audio", spec: "pitch-match", label: "Five notes sung back within 30 cents", criteria: [{ id: "pitch", label: "In tune", check: "pitch_accuracy >= 0.8" }], fallback: "self-report" } },
      { id: "scale", label: "A five-note scale up and down", hours: [3, 8], nodes: ["scale"],
        proof: { engine: "audio", spec: "five-scale", label: "Do-re-mi-fa-so and back, in tune and in time", criteria: [{ id: "pitch", label: "In tune", check: "pitch_accuracy >= 0.8" }, { id: "rhythm", label: "In time", check: "onset_share_on_time >= 0.7" }], fallback: "self-report" } },
      { id: "phrase", label: "A phrase over a drone", hours: [6, 15], nodes: ["phrase"],
        proof: { engine: "audio", spec: "phrase", label: "One phrase over the drone, notes and pitch right", criteria: [{ id: "notes", label: "Right notes", check: "note_accuracy >= 0.85" }, { id: "pitch", label: "In tune", check: "mean_abs_cents <= 35" }], fallback: "self-report" } },
      { id: "song", label: "A verse and chorus", hours: [15, 35], nodes: ["song"],
        proof: { engine: "audio", spec: "song-take", label: "Verse and chorus in one take, in tune with the backing", criteria: [{ id: "pitch", label: "In tune", check: "pitch_accuracy >= 0.75" }, { id: "rhythm", label: "In time", check: "onset_share_on_time >= 0.7" }], fallback: "self-report" } }
    ],
    nodes: [
      { id: "breath", name: "Breath support", lesson: "breath-lesson", drills: ["long-note-drill"], mistakes: ["wobble"], review: { prompt: "Where should a deep breath expand?", kind: "choice", options: ["Belly and ribs", "Shoulders"], answer: 0 }, focus: "Fundamentals" },
      { id: "pitch-match", name: "Pitch matching", requires: ["breath"], lesson: "pitch-lesson", drills: ["match-drill", "interval-quiz"], mistakes: ["flat"], review: { prompt: "Sing below the note: flat or sharp?", kind: "choice", options: ["Flat", "Sharp"], answer: 0 }, focus: "Pitch" },
      { id: "scale", name: "Scales", requires: ["pitch-match"], lesson: "scale-lesson", drills: ["scale-drill"], review: { prompt: "How many steps from do to so?", kind: "choice", options: ["Four", "Five"], answer: 0 }, focus: "Pitch" },
      { id: "phrase", name: "Phrases", requires: ["scale"], lesson: "phrase-lesson", drills: ["phrase-drill"], review: { prompt: "What does a drone help you hear?", kind: "recall" }, focus: "Songs" },
      { id: "song", name: "A whole song", requires: ["phrase"], lesson: "song-lesson", drills: ["song-drill"], review: { prompt: "Where do you breathe in your song?", kind: "recall" }, focus: "Songs" }
    ],
    lessons: [
      { id: "breath-lesson", title: "Breath support", nodes: ["breath"], cards: [
        { type: "predict", text: "A steady note needs steady...", options: ["Air flow", "Loudness"], answer: 0 },
        { type: "compare", text: "Tap the wobbly long note.", left: { kind: "contour", values: [0, 0, 0, 0, 0, 0, 0, 0], label: "Steady" }, right: { kind: "contour", values: [0, 2, -2, 3, -3, 2, -1, 3], label: "Wobbly" }, answer: "right" }
      ] },
      { id: "pitch-lesson", title: "Matching a note", nodes: ["pitch-match"], cards: [
        { type: "predict", text: "If you sing slightly below the note, you're...", options: ["Flat", "Sharp"], answer: 0 },
        { type: "sim", text: "Drag your pitch. Watch the cents error.", sim: { title: "Cents off the note", params: { sung_hz: { label: "Your pitch", min: 420, max: 460, default: 436, unit: "Hz" } }, formulas: { cents: "1200 * log(sung_hz / 440) / log(2)" }, figure: { kind: "gauge", value: "cents", min: -80, max: 80, good: [-30, 30] }, readout: [{ value: "cents", label: "Off by", unit: "cents" }] } },
        { type: "compare", text: "Tap the flat attempt.", left: { kind: "contour", values: [0, 0, 0, 0], label: "Target" }, right: { kind: "contour", values: [-3, -3, -2, -3], label: "You" }, answer: "right" }
      ] },
      { id: "scale-lesson", title: "Five-note scale", nodes: ["scale"], cards: [
        { type: "predict", text: "Do-re-mi-fa-so goes up how many notes?", options: ["Five", "Eight"], answer: 0 },
        { type: "diagram", text: "Up five, back down.", figure: { kind: "notation", abc: "X:1\nL:1/4\nK:C\nC D E F | G F E D | C4 |]" } }
      ] },
      { id: "phrase-lesson", title: "Phrases over a drone", nodes: ["phrase"], cards: [
        { type: "predict", text: "A drone note makes being off-key...", options: ["Easier to hear", "Harder to hear"], answer: 0 },
        { type: "demo", text: "The phrase, one note at a time.", figure: { kind: "notation", abc: "X:1\nL:1/4\nK:C\nC C G G | A A G2 |]" }, playback: "steps" }
      ] },
      { id: "song-lesson", title: "Singing a song", nodes: ["song"], cards: [
        { type: "predict", text: "Plan breaths before you sing, or take them when needed?", options: ["Plan them", "When needed"], answer: 0 },
        { type: "try-it", text: "Mark your breaths: tap at each one.", action: "tap-rhythm", pattern: "x...x...", seconds: 20 }
      ] }
    ],
    drills: [
      { id: "long-note-drill", type: "play-along", title: "Long notes", prompt: "Hold a comfortable note for eight seconds on 'ah'.", nodes: ["breath"], spec: "long-note", success: "mean_abs_cents <= 35", difficulty: { param: "length", levels: ["4 s", "8 s", "12 s"] }, minutes: 4, intensity: 1, focus: "Fundamentals", fixes: ["wobble"] },
      { id: "match-drill", type: "play-along", title: "Match the note", prompt: "Listen, then sing it back on 'la'.", nodes: ["pitch-match"], spec: "pitch-match", success: "pitch_accuracy >= 0.8", difficulty: { param: "range", levels: ["comfortable", "wider", "full"] }, minutes: 5, intensity: 1, focus: "Pitch", fixes: ["flat"] },
      { id: "interval-quiz", type: "choice", title: "Higher or lower?", prompt: "Is the second note higher or lower?", nodes: ["pitch-match"], spec: "ear-quiz", minutes: 3, intensity: 1, focus: "Pitch" },
      { id: "scale-drill", type: "play-along", title: "Five-note scale", prompt: "Sing the scale with the piano, up and down.", nodes: ["scale"], spec: "five-scale", success: "pitch_accuracy >= 0.8", difficulty: { param: "tempo", levels: [60, 72, 90] }, minutes: 5, intensity: 1, focus: "Pitch" },
      { id: "phrase-drill", type: "play-along", title: "Phrase over the drone", prompt: "Sing the phrase while the drone plays.", nodes: ["phrase"], spec: "phrase", success: "note_accuracy >= 0.8", difficulty: { param: "tempo", levels: [60, 80] }, minutes: 6, intensity: 1, focus: "Songs" },
      { id: "song-drill", type: "play-along", title: "Song section", prompt: "Sing the verse with your backing track.", nodes: ["song"], spec: "song-take", success: "pitch_accuracy >= 0.75", difficulty: { param: "length", levels: ["verse", "verse and chorus"] }, minutes: 10, intensity: 2, focus: "Songs" }
    ],
    specs: {
      "long-note": { kind: "audio", reference: { notes: [["A3", 8]] }, tempo: 60, tolerance: { pitch_cents: 30, onset_ms: 200 }, grade: ["pitch"], playback: "none", pass: "mean_abs_cents <= 30", mistakes: [{ id: "wobble", when: "mean_abs_cents > 40", severity: 1, fix_drill: "long-note-drill" }] },
      "pitch-match": { kind: "audio", reference: { notes: [["C4", 2], ["E4", 2], ["G4", 2], ["D4", 2], ["A3", 2]] }, tempo: 60, tolerance: { pitch_cents: 30, onset_ms: 300 }, grade: ["pitch", "notes"], playback: "backing", pass: "pitch_accuracy >= 0.8", mistakes: [{ id: "flat", when: "mean_abs_cents > 40 && note_accuracy < 0.8", severity: 2, fix_drill: "match-drill" }] },
      "five-scale": { kind: "audio", reference: { notes: [["C4", 1], ["D4", 1], ["E4", 1], ["F4", 1], ["G4", 1], ["F4", 1], ["E4", 1], ["D4", 1], ["C4", 2]] }, tempo: 72, tolerance: { pitch_cents: 35, onset_ms: 120 }, grade: ["pitch", "rhythm"], playback: "backing", pass: "pitch_accuracy >= 0.8 && onset_share_on_time >= 0.7" },
      phrase: { kind: "audio", reference: { abc: "X:1\nM:4/4\nL:1/4\nK:C\nC C G G | A A G2 | F F E E | D D C2 |]" }, tempo: 80, tolerance: { pitch_cents: 35, onset_ms: 120 }, grade: ["pitch", "notes", "rhythm"], playback: "backing", pass: "note_accuracy >= 0.85 && mean_abs_cents <= 35" },
      "song-take": { kind: "audio", reference: { recording: "learner-media/wedding-song-guide.wav" }, tempo: 92, tolerance: { pitch_cents: 40, onset_ms: 150 }, grade: ["pitch", "rhythm"], playback: "backing", pass: "pitch_accuracy >= 0.75 && onset_share_on_time >= 0.7" },
      "ear-quiz": {
        kind: "items",
        items: [
          { type: "choice", id: "e1", prompt: "C4 then G4. The second note is...", options: ["Higher", "Lower"], answer: 0, difficulty: 1, nodes: ["pitch-match"] },
          { type: "choice", id: "e2", prompt: "Singing below the note is called...", options: ["Flat", "Sharp"], answer: 0, difficulty: 2, nodes: ["pitch-match"] },
          { type: "order", id: "e3", prompt: "Order the solfège notes going up.", items: ["Do", "Re", "Mi", "Fa", "So"], difficulty: 2, nodes: ["scale"] }
        ]
      },
      "tone-check": { kind: "self-report", fields: ["felt", "note"], criterion: "Listened back: did the voice sound relaxed and clear, with no strain?" }
    },
    mistakes: [
      { id: "flat", name: "Singing flat", nodes: ["pitch-match"], engine: "audio", detector: { metric: "mean_abs_cents", when: "mean_abs_cents > 40 && note_accuracy < 0.8" }, severity: 2, explain: { lesson: "pitch-lesson", card: 2 }, fix_drill: "match-drill", headline: "Notes sit below the target" },
      { id: "wobble", name: "Wobbly long notes", nodes: ["breath"], engine: "audio", detector: { metric: "mean_abs_cents", when: "mean_abs_cents > 40" }, severity: 1, explain: { lesson: "breath-lesson", card: 1 }, fix_drill: "long-note-drill", headline: "Long notes drift and wobble" }
    ],
    warmups: [
      { id: "voice-warmup", title: "Wake the voice", steps: ["Five slow breaths into the belly", "Lip trills, low to high, for a minute", "Humming slides up and down", "Gentle 'ng' sirens"], minutes: 5 }
    ],
    safety: {
      warmup: "voice-warmup",
      injury_questions: ["Is your voice hoarse or sore right now?", "Any throat or vocal problems a doctor knows about?"],
      beginner_caps: { max_intensity: 2, max_minutes: 30, sessions_per_week: 6 },
      stop_criteria: ["Throat pain or a scratchy feeling", "Hoarseness that builds during practice"],
      see_professional: ["Hoarseness lasting more than two weeks", "Pain when speaking"],
      supervised_only: []
    },
    access: ["A quiet room", "Headphones", "A backing track you own"],
    injuries: { "Sore throat": "No singing until it clears; humming only for two days after", Hoarseness: "Rest the voice; gentle humming only, ten minutes a day, for a week" },
    focus: { Fundamentals: 35, Pitch: 45, Songs: 20 },
    hard_focus: ["Songs"],
    key_metrics: [
      { id: "pitch", label: "Notes in tune", engine: "audio", metric: "pitch_accuracy", unit: "%", better: "higher", format: "percent" },
      { id: "cents", label: "Pitch error", engine: "audio", metric: "mean_abs_cents", unit: "cents", better: "lower", format: "cents" }
    ],
    media: [{ id: "guide", path: "learner-media/wedding-song-guide.wav", license: "learner", note: "A guide recording the learner made or owns" }],
    copy: { placeholder: "singing, a song, choir", blurb: "In tune, in time, without strain" },
    notes: "Engines: audio for pitch and rhythm against note data, ABC and the learner's own guide recording. Harmony and tone colour are only partly measurable, so a self-report listening check (tone-check) covers tone. Treated as physical for vocal health: warm-ups, short sessions and hoarseness rules. Hours are estimates from general beginner voice guidance, shown as ranges."
  })
};

# Spec languages

An engine measures; it doesn't know which skill it is measuring. A **spec** is the data that configures it: what to track, what to compute, what counts as good. You write specs under the model's `specs` (a map from spec id to spec), and drills, probes and proofs refer to them by id. Specs are data, not code: they run on a small sandboxed set of built-in functions.

Every spec has a `kind`. The kind decides the engine, and `validate_skill_model` checks that the engine is in the model's `engines`.

| Engine | Spec `kind` | What it measures | Metric names it produces |
|---|---|---|---|
| movement | `metric` | Anything from body, hand, face or object points over time | Whatever the spec names |
| audio | `audio` | Notes, pitch, onsets, tempo, dynamics | `AUDIO_METRICS` |
| speech | `speech` | Transcript, intelligibility, pace, pauses, tone contour | `SPEECH_METRICS` |
| code | `test` | Tests, compile, run time, lint | `tests_passed` ... |
| visual | `rubric` | Rubric levels with a cited region, plus measurements | `score`, `<criterion>_level`, `<criterion>_confidence` |
| knowledge | `items` | Answers | `correct`, `total`, `accuracy`, `stopped_early`, `difficulty_reached`, `mean_ms` |
| interaction | `task` | Typing, shortcuts, mental math, clicking | `INTERACTION_METRICS` |
| sensor | `sensor` | Phone motion: cadence, swing tempo, steadiness | `SENSOR_METRICS` |
| game | `game` | Moves against an engine's best moves | `GAME_METRICS` |
| self-report | `self-report` | What the learner says | The field names |

A `sim` spec (declarative interactive figure) is not an engine spec; it goes inside a `sim` lesson card.

## The expression language

One small language is used everywhere an engine, drill, proof or placement rule needs a formula. It has no assignment, no loops, no strings of code and no access to the host.

### Where expressions appear, and the names each can use

| Where | Names in scope |
|---|---|
| Metric spec: `metrics.<name>` | Body points, context names, **earlier** metrics in the same spec, phases. May end with `per <segment>` and `at <phase>`. |
| Metric spec: `segment.signal`, `phases.<name>` | Body points and context names only (no metrics). |
| Metric spec: `mistakes[].when`, `show` | Points, context, all of the spec's metrics. |
| Audio, speech: `pass`, `mistakes[].when` | The metrics of that engine (tables below). |
| Items, task, sensor, game, self-report: `pass` | The metrics of that engine. |
| Rubric: `pass` | Criterion ids, each holding that criterion's level number. |
| Rubric: `level_from` | Names of the measurements named in `measure`. |
| Model `mistakes[].detector.when` | Metric names from the mistake's spec; `learner.baseline.*`. |
| Drill `success`, proof `criteria[].check` | The metric names the spec produces. |
| Placement `when` | Probe ids, `quiz.correct`, `quiz.answered`, `fresh` (see [skill-model.md](skill-model.md#placement)). |
| Sim: `formulas`, figure formulas | Parameters, earlier formulas, `row`, `col`, `t`, `i`. |

In every place that reads metrics, a metric `m` is a number, `m_confidence` is its confidence, and `m_per` is the list of per-segment values when it was computed `per` something. Only the metric spec and the sim spec check names statically. Everywhere else the expression is parsed but a wrong name only fails at run time, so copy metric names exactly.

### Grammar

```
metric_expr := expr { ("per" NAME) | ("at" NAME) }        only in metrics.<name>
expr        := or
or          := and { ("||" | "or") and }
and         := cmp { ("&&" | "and") cmp }
cmp         := add [ ("<" | "<=" | ">" | ">=" | "==" | "!=") add ]     no chaining
add         := mul { ("+" | "-") mul }
mul         := unary { ("*" | "/" | "%") unary }
unary       := ("-" | "!" | "not") unary | postfix
postfix     := primary { "." (NAME | NUMBER) | "[" expr "]" }
primary     := NUMBER | STRING | true | false | NAME
             | NAME "(" [ arg { "," arg } ] ")"       arg := [ NAME (":" | "=") ] expr
             | "(" expr ")" | "[" [ expr { "," expr } ] "]"
```

- Numbers: `3`, `0.5`, `.5`, `1e3`. Strings: `'single'` or `"double"`. Use single quotes inside JSON.
- Names are `[A-Za-z_][A-Za-z0-9_]*`. Dots reach members: `left_hip.y`, `left_hand.index_tip`, `object.sports_ball`, `baseline.knee_bottom`.
- Named arguments: `pose_similarity(reference, joints: [legs, hips], align: dtw)`.
- `per` and `at` are valid only in a `metrics` entry. In a `when`, `success` or `check` they are a syntax error.
- Metric names (the keys of `metrics`) match `^[a-z_][a-z0-9_]*$`.

Gotchas:

- `not` and `!` bind tighter than comparison: `not a >= b` means `(not a) >= b`. Write `not (a >= b)`, or `a < b`.
- Comparisons do not chain: `1 < x < 3` is a syntax error. Write `x > 1 && x < 3`.
- `if(c, a, b)` is a function and evaluates all arguments.
- A `-` in an id (`line-confidence`) is subtraction inside an expression. Use `_` for any id you will reference.
- Strings compare as text; a string and a number compare as text unless both are numeric. `+` joins strings.

### Values

- A number, boolean, string, list (`[1, 2]`, `.length`, `[0]`) or **series**.
- A **series** is a signal over frames or samples; a **point** is a tracked body point over time with `.x`, `.y`, `.z` (a series each) and `.conf` (confidence). A series has `.t` (timestamps) and `.conf`.
- Arithmetic and comparison **lift** over series: `angle(a, b, c) > 150` is a 0/1 series. `&&` and `||` lift too.
- A series used as a condition is true only if **every** sample is non-zero. Use `share(...)` or `any(...)` when you mean "how often" or "ever".
- `NaN` samples are ignored by reductions.
- `per <segment>` turns a metric into one value per repetition, move, phrase or hold; later metrics reduce it (`share`, `mean`, `count`).

### Standard functions (every spec)

- Reductions (series or list; several arguments also work): `min`, `max`, `mean` (`avg`), `median`, `std`, `sum`, `count`, `len`, `first`, `last`, `range` (max minus min), `distinct`.
- Counting: `share(x)` is the fraction of non-zero samples (use it on a boolean series); `shareof(list, v)`; `any(x)`; `all(x)`; `contains(list_or_text, v)`.
- Element-wise math: `abs`, `round(x, digits)`, `floor`, `ceil`, `sqrt`, `pow(x, y)`, `log`, `exp`, `sin`, `cos`, `clamp(x, lo, hi)`, `diff(x)` (change between samples), `absdiff(a, b)`.
- Other: `where(x, mask)`, `if(c, a, b)`, `number(x)`, `string(x)`.

## Capture spec (shared)

Used in a metric spec, a drill and a proof (`capture`). `angle`: `front`, `side`, `side-45`, `back`, `top`, `over-shoulder`, `any` (default); state the angle the metrics need, because the engine reports low confidence when the real angle differs. `fps` 10–240, default 30 (60 or more for swings and spins). `duration_s` 1–600. `distance_m` 0.5–20. `track`: any of `pose`, `hands`, `face`, `objects`, derived from the points you use when omitted. `guide`: one line shown with the framing outline (120 chars).

## Metric spec (movement)

The engine tracks points, splits the clip, computes each metric and runs the mistake detectors.

| Field | Meaning |
|---|---|
| `capture` | See above. |
| `segment` | `by`: `reps`, `moves`, `phrases`, `holds` or `whole` (default). `signal`: a series expression whose minima split repetitions (`left_hip.y`). `beats` (1–64), `beat_source` (`audio_track`, `metronome`, `tap`), `min_duration_s` (at least 0.1) for beat-aligned phrases. |
| `reference` | Path of a clip the learner supplied (`learner-media/teacher-basic.mp4`). Shown to the learner as a ghost. Never a URL. |
| `phases` | Name to an expression that is true on the frames in that phase (`bottom: left_hip.y == max(left_hip.y)`). |
| `metrics` | Name to expression, computed in order. Later metrics may use earlier ones. |
| `units` | Optional display unit per metric. |
| `mistakes` | Detectors: `id`, `when`, optional `min_share`, `min_confidence` (default 0.7), `severity` (1–3, default 2), `show`, `fix_drill`. |
| `requires_visible` | Points that must be visible for the result to count. |

`per` segments: `rep(s)`, `move(s)`, `phrase(s)`, `hold(s)`, `segment`, `whole`. `at` phases: your declared `phases`, or built-in `down`, `up`, `hold`, `bottom`, `top`, `start`, `end`, `peak`.

### Body point names

| Group | Names |
|---|---|
| Pose (33) | `nose`; `left_`/`right_` plus `eye_inner`, `eye`, `eye_outer`, `ear`, `shoulder`, `elbow`, `wrist`, `pinky`, `index`, `thumb`, `hip`, `knee`, `ankle`, `heel`, `foot_index`; `mouth_left`, `mouth_right`. |
| Hands (21 each) | `left_hand.<p>` and `right_hand.<p>` where `<p>` is `wrist`, or a finger `thumb`, `index`, `middle`, `ring`, `pinky` joined to `_mcp`, `_pip`, `_dip`, `_tip` (the thumb uses `_cmc`, `_mcp`, `_ip`, `_tip`). Example: `left_hand.index_tip`. |
| Face | `face_nose_tip`, `face_chin`, `face_forehead`, `face_left_eye_outer`, `face_left_eye_inner`, `face_right_eye_outer`, `face_right_eye_inner`, `face_mouth_left`, `face_mouth_right`, `face_upper_lip`, `face_lower_lip`, `face_left_cheek`, `face_right_cheek`. |
| Objects | `object.<class>` with the class name in underscores: `object.sports_ball`, `object.tennis_racket`, `object.cell_phone`, plus `person`, `bicycle`, `car`, `baseball_bat`, `baseball_glove`, `skateboard`, `surfboard`, `bottle`, `cup`, `fork`, `knife`, `spoon`, `bowl`, `chair`, `frisbee`, `skis`, `snowboard`, `kite`, `book`, `clock`, `scissors`, `laptop`, `keyboard`, `mouse`, `remote`. |
| Derived | `vertical`, `horizontal` (directions), `ground`, `mid_hip`, `mid_shoulder`, `center_of_mass`, `head`. |
| Groups (for `joints:`) | `legs`, `hips`, `arms`, `torso`, `feet`, `head`, `all`. |

Coordinates are image-like: `y` grows downward, so the lowest hip is `max(left_hip.y)`. Left and right are the person's own. Unknown names (`left_foot`, `right_hand.index`) are rejected.

### Context names

| Name | Meaning |
|---|---|
| `baseline.<metric>` | The learner's own value from their first attempts. Use for thresholds that must fit their body. In a model detector, write `learner.baseline.<metric>`. |
| `learner` | The learner's own data. `learner.baseline.<metric>` is the same as `baseline.<metric>`. |
| `beat` | The beat grid from `segment.beat_source`. |
| `reference` | The reference clip. Pass it to `pose_similarity`. |
| `rep`, `segment`, `phase`, `t`, `fps`, `capture` | Reserved names the validator accepts, for the current segment, phase, time, frame rate and capture settings. |

The validator accepts any member after these names (`baseline.anything`). It cannot check them, so use only metrics the same spec defines.

### Movement functions

The validator accepts exactly these names and checks only the name, not the argument count or types. Calls shown for `angle`, `phase_duration`, `pose_similarity`, `on_beat`, `step_offset_ms` and `overlay` come from the design examples. Rows marked * follow the obvious convention but are not shown anywhere in the design; the movement engine is the authority, so test a new metric against a real capture before trusting it.

| Function | Call | Gives |
|---|---|---|
| `angle` | `angle(a, b, c)` | Degrees at `b` between `b-a` and `b-c`. `c` (or `a`) may be `vertical` or `horizontal`. |
| `distance`* | `distance(a, b)` | Distance between points, in the learner's body-relative units. |
| `velocity`*, `speed`* | `velocity(p)`, `speed(p)` | Rate of change of a point's position; its magnitude. |
| `height`* | `height(p)` | Height of a point above `ground`. |
| `between`* | `between(x, lo, hi)` | 1 where `x` lies between the bounds. |
| `phase_duration` | `phase_duration(down)` | Seconds spent in a phase (per segment with `per`). |
| `pose_similarity` | `pose_similarity(reference, joints: [legs, hips], align: dtw)` | 0..1 similarity to the reference. `align`: `dtw`, `linear`, `none`. |
| `on_beat` | `on_beat(left_ankle, right_ankle)` | Share of steps or hits landing on the beat. |
| `step_offset_ms` | `step_offset_ms(left_ankle, right_ankle)` | Milliseconds each step is off the nearest beat. Negative is early. |
| `symmetry`* | `symmetry(left_point, right_point)` | Left-right likeness of a pair of points. |
| `jerk`* | `jerk(p)` | Change in acceleration, a smoothness measure. |
| `visible`* | `visible(p)` | Share of frames where the point is visible with enough confidence. |
| `reps`*, `duration`*, `hold_time`* | `reps()`, `duration()`, `hold_time()` | Repetitions, segment length in seconds, seconds held. |
| `x`*, `y`*, `z`* | `x(p)` | Same as `p.x`. |
| `midpoint`*, `projection`* | `midpoint(a, b)`, `projection(p, a, b)` | A derived point; `p` projected onto line `a-b`. |
| `smooth`* | `smooth(series, n)` | A smoothed series. |
| `overlay` | `overlay(expr)` | In `show` only: draw the value on the frame. |

`show` (what to draw for a mistake) takes `overlay(expr)`, or the words `beat_timeline`, `ghost`, `skeleton`. Do not write `angle_arc(...)` or `line(...)`: the validator rejects them as unknown functions.

### Movement metric names

There is no fixed list. Every key of `metrics` is a metric, with the unit from `units`, a confidence per value and (for `per`) a value per segment. The Analysis also carries markers and segments. Name the metrics so that drill `success`, proof `check`, detector `when` and `key_metrics` can reuse them.

### Example: squat (side view, repetitions)

```json
{
  "kind": "metric",
  "capture": { "angle": "side", "fps": 30 },
  "segment": { "by": "reps", "signal": "left_hip.y" },
  "phases": { "bottom": "left_hip.y == max(left_hip.y)" },
  "metrics": {
    "knee_bottom": "min(angle(left_hip, left_knee, left_ankle)) per rep",
    "depth_ok": "knee_bottom <= 95",
    "torso_lean": "angle(left_shoulder, left_hip, vertical) at bottom",
    "tempo_down_s": "phase_duration(down)",
    "reps": "count(knee_bottom)"
  },
  "units": { "knee_bottom": "deg", "tempo_down_s": "s" },
  "mistakes": [
    { "id": "shallow", "when": "share(not depth_ok) >= 0.3", "show": "overlay(angle(left_hip, left_knee, left_ankle))", "fix_drill": "box-squat-to-depth" }
  ],
  "requires_visible": ["left_hip", "left_knee", "left_ankle"]
}
```

### Example: dance basic step against a learner-supplied clip, on the beat

```json
{
  "kind": "metric",
  "capture": { "angle": "front", "fps": 30 },
  "reference": "learner-media/teacher-basic.mp4",
  "segment": { "by": "phrases", "beats": 8, "beat_source": "audio_track" },
  "metrics": {
    "timing": "on_beat(left_ankle, right_ankle)",
    "shape": "pose_similarity(reference, joints: [legs, hips], align: dtw)",
    "step_offset_ms": "step_offset_ms(left_ankle, right_ankle)"
  },
  "mistakes": [
    { "id": "rushing", "when": "mean(step_offset_ms) < -80", "show": "beat_timeline" }
  ]
}
```

With no reference clip, drop `reference` and `shape` and keep timing, symmetry and range of motion.

## Rubric spec (visual, also open answers)

For anything judged by looking: drawing, plating, handwriting, a photo, a slide. The grade comes with a level per criterion, a cited region and a confidence.

| Field | Meaning |
|---|---|
| `criteria` (1–8) | `id` (use `_`), optional `label`, `levels` (level number to description, at least 2 levels, each 25 words or fewer, higher is better), optional `measure`, optional `level_from`, `weight` (0–10, default 1). |
| `measure` | `name(args)` with name one of `tapped_points`, `proportion`, `symmetry`, `exposure`, `color_balance`, `edge_density`, `text`, `line_count`, `angle`. E.g. `tapped_points(head_top, chin, feet)`. |
| `level_from` | An expression over the measurement that maps to a level: `if(ratio_error < 0.1, 3, if(ratio_error < 0.25, 2, 1))`. |
| `must_cite` | `region` (default), `timestamp`, `line` or `none`. The grader must point at the evidence. |
| `taps` | Up to 8 `{id, prompt}`: points the learner taps on the image first (`prompt` 60 chars). |
| `reference_image` | A learner-supplied image path. |
| `pass` | Expression over criterion ids as level numbers: `proportions >= 2 && line_confidence >= 2`. |
| `safety_critical` | `true` is always rejected: rubric grading is never a proof for anything safety-critical. |

Metric names: `score` (weighted overall, 0..1), `<criterion>_level` (for example `proportions_level`) and `<criterion>_confidence`. Use these in proof `check` and drill `success`. In the rubric's own `pass`, the bare criterion id (`proportions`) also holds the level.

```json
{
  "kind": "rubric",
  "criteria": [
    { "id": "proportions", "label": "Proportions",
      "levels": { "1": "Head and body sizes off by more than 25%", "2": "Mostly right", "3": "Within 10%" },
      "measure": "tapped_points(head_top, chin, feet)",
      "level_from": "if(ratio_error < 0.1, 3, if(ratio_error < 0.25, 2, 1))", "weight": 2 },
    { "id": "line_confidence", "label": "Line confidence",
      "levels": { "1": "Hesitant, many re-strokes", "2": "Some", "3": "Single confident strokes" } }
  ],
  "must_cite": "region",
  "taps": [{ "id": "head_top", "prompt": "Tap the top of the head" }, { "id": "chin", "prompt": "Tap the chin" }, { "id": "feet", "prompt": "Tap the feet" }],
  "pass": "proportions >= 2 && line_confidence >= 2"
}
```

### The visual grading flow

LAS never lets you see raw video. A still image is the one exception, because you grade it.

1. `request_capture` with an attempt spec naming the rubric spec. The studio takes or uploads the photo and, if the rubric has `taps`, asks the learner to tap the points.
2. LAS returns the image and the `rubricPrompt` (the criteria and levels, plus any measurements already computed).
3. You grade with your own vision: a level per criterion, the **region** you mean (x, y, w, h as fractions of the image), and a confidence.
4. `submit_rubric_grade` with those. Cite what `must_cite` asks for (a region by default). A grade with no region is kept, but its confidence is halved and the result says so.
5. `get_analysis` returns the Analysis: `score`, `<criterion>_level`, the criteria that passed, and the evidence. Show the region on the image. Confidence under 0.7 is not shown as a correction; ask for a better photo instead. Before any grade arrives, the result holds only the measurements, is marked `precision: reduced` and says grading is pending. A submitted grade always wins over a `level_from` level.

If you are text-only: use a local open vision model if `get_capabilities` lists one (`localModels` kind `vision`); the grade comes back the same way. If there is none, fall back to the measurements the learner's taps allow plus self-report, tell the learner the check is less precise, and record the fallback.

## Test spec (code)

| Field | Meaning |
|---|---|
| `language` | One of `javascript`, `typescript`, `python`, `sql`, `ruby`, `php`, `rust`, `go`, `java`, `c`, `cpp`, `csharp`, `kotlin`, `swift`, `bash`, `lua`, `r`, `haskell`, `elixir`, `scala`, `dart`, `zig`. |
| `entry` | Entry file inside the workspace (no `..`). |
| `tests` (1–50) | Each is one of: `{call, expect}` (a call written in the language, compared as trimmed text), `{stdin, stdout}`, or `{native}` (the language's own test file). Optional `hidden` (not shown to the learner) and `label`. |
| `runner` | Preference order from `browser`, `local`, `container`. Default all three. |
| `limits` | `time_s` (1–120, default 10), `memory_mb` (16–4096, default 256), `network` (always false). |
| `lint` | Lint command names to use if installed. |
| `starter` | File name to starting contents. |

Runners: `browser` runs JavaScript, TypeScript, Python and SQL with no install; `local` runs any installed toolchain; `container` runs anything that has an image and needs a container runtime. LAS picks the first available and asks consent once per runner. Put a runner the language can run first; a Go spec with `["browser"]` has nothing to run it. If no runner exists, the code engine falls back to `knowledge` (for example predict-output items).

Metric names: `tests_passed`, `tests_total`, `pass_rate`, `hidden_passed`, `compiled`, `run_ms`, `lint_findings`.

```json
{
  "kind": "test",
  "language": "go",
  "entry": "wordcount.go",
  "tests": [
    { "call": "CountWords(\"\")", "expect": "0", "label": "Empty input" },
    { "call": "CountWords(\"a b  c\")", "expect": "3", "hidden": true },
    { "stdin": "one two\nthree\n", "stdout": "3\n" },
    { "native": "wordcount_test.go", "hidden": true }
  ],
  "runner": ["local", "container"],
  "limits": { "time_s": 10, "memory_mb": 256, "network": false },
  "lint": ["go vet"],
  "starter": { "wordcount.go": "package main\n\nfunc CountWords(s string) int {\n\treturn 0\n}\n" }
}
```

Proof check: `pass_rate >= 1 && compiled`. Hidden tests are for the proof, so the learner can't tune to them.

## Audio spec

| Field | Meaning |
|---|---|
| `reference` | One of: `{score, part?, bars?}` (a score file the learner owns, bars like `"1-8"`), `{midi, track?, bars?}`, `{abc}`, `{recording}`, `{pattern, beats_per_bar?, bars?}`, `{notes: [[name, beats], ...]}`. |
| `tempo` | 20–300 bpm. |
| `tuning_hz` | 400–480, default 440. |
| `tolerance` | `pitch_cents` (1–200, default 30), `onset_ms` (5–500, default 60). |
| `grade` | Any of `pitch`, `rhythm`, `dynamics`, `tempo`, `notes`, `onsets`. Default `pitch`, `rhythm`. |
| `playback` | `metronome` (default), `backing`, `none`: what plays in the headphones. |
| `pass` | Expression over the metrics. |
| `mistakes` | `{id, when, severity, show, fix_drill}`. |

A `pattern` is a string with one character per subdivision of a bar: `x` is a hit, `.` is a rest (`"x.x.xx.x"` is eight steps). `notes` are note names with octave and a length in beats. Rules the validator applies: grading `pitch` or `notes` needs a `reference`; grading `rhythm` needs a `tempo` or a `reference`.

Metrics (`AUDIO_METRICS`):

| Metric | Meaning |
|---|---|
| `pitch_accuracy` | Share of notes within the pitch tolerance (0..1). |
| `mean_abs_cents` | Mean absolute pitch error in cents. |
| `notes_correct`, `notes_expected`, `notes_detected` | Note counts. |
| `note_accuracy` | Share of expected notes played correctly (0..1). |
| `mean_abs_onset_ms`, `mean_onset_ms`, `onset_std_ms` | Timing error: absolute, signed (early or late), spread. |
| `onset_share_on_time` | Share of onsets inside the onset tolerance (0..1). |
| `tempo_bpm`, `tempo_drift_pct` | Tempo played and its drift. |
| `dynamics_range_db`, `rms_db` | Loudness range and level. |
| `early_share`, `late_share` | Share of onsets early or late (0..1). |
| `up_offset_ms`, `down_offset_ms` | Timing offset of up and down strokes. |

Example with a `pattern` reference (a repeating rhythm):

```json
{
  "kind": "audio",
  "reference": { "pattern": "x.x.xx.x", "beats_per_bar": 4, "bars": 4 },
  "tempo": 80,
  "tolerance": { "onset_ms": 60 },
  "grade": ["onsets", "rhythm", "tempo"],
  "playback": "metronome",
  "pass": "onset_share_on_time >= 0.8 && abs(tempo_drift_pct) <= 5",
  "mistakes": [
    { "id": "late-hits", "when": "late_share >= 0.4", "severity": 2, "show": "beat_timeline", "fix_drill": "slow-click" }
  ]
}
```

Example with `notes` (a melody):

```json
{
  "kind": "audio",
  "reference": { "notes": [["C4", 1], ["D4", 1], ["E4", 0.5], ["F4", 0.5], ["G4", 2]] },
  "tempo": 72,
  "tuning_hz": 440,
  "tolerance": { "pitch_cents": 30, "onset_ms": 80 },
  "grade": ["pitch", "rhythm", "notes"],
  "pass": "note_accuracy >= 0.85 && mean_abs_cents <= 25"
}
```

## Speech spec

| Field | Meaning |
|---|---|
| `language` | BCP-47 tag: `es`, `ja`, `zh-CN`. |
| `target` | Text to repeat (400 chars). |
| `prompt` | Open prompt the learner answers (200). A spec needs a `target` or a `prompt`. |
| `tones` | `true` for a tonal language: measure the pitch contour per syllable. |
| `tone_pattern` | Expected tone per syllable (integers 0–6). Needs `tones: true`. |
| `rubric` | A rubric spec for open answers. |
| `sounds` | Per-sound scores to ask for, where a license-clean model exists for the language. |
| `pass`, `mistakes` | As in the audio spec. |

Metrics (`SPEECH_METRICS`): `intelligibility`, `words_recognized`, `words_expected`, `mean_word_confidence`, `words_per_minute`, `pause_count`, `pause_share`, `filler_count`, `duration_s`, `pitch_range_st`, `tone_accuracy`, `sound_score`. Score clarity, never a "native" accent. If `get_capabilities` shows no per-sound model for the language, don't ask for `sounds`; use intelligibility and the learner's earlier attempts.

```json
{
  "kind": "speech",
  "language": "zh-CN",
  "target": "谢谢",
  "tones": true,
  "tone_pattern": [4, 0],
  "pass": "intelligibility >= 0.8 && tone_accuracy >= 0.7",
  "mistakes": [
    { "id": "flat-tones", "when": "tone_accuracy < 0.5 && pitch_range_st < 3", "severity": 2, "fix_drill": "contour-shadow" }
  ]
}
```

## Items spec (knowledge)

Questions the learner answers. Standard types only.

| Item `type` | Fields (besides `id`, `prompt`, `difficulty` 1–5, `nodes`) |
|---|---|
| `choice` | `options` (2–6), `answer` (index), optional `code`, `audio` |
| `match` | `pairs`: 2–8 `[left, right]` |
| `order` | `items`: 2–8 in the correct order |
| `fill` | `text` with the gap, `answers` (accepted), `hints` |
| `hotspot` | `figure` (an id), `region` `{x, y, r}` |
| `predict-output` | `code` (1200 chars), `language`, `options`, `answer` |

Spec fields: `items` (1+), `stop_after_wrong` (1–5, default 2; placement quizzes use 2), `pass`. Prompts are 40 words or fewer and an `answer` index must be in range. Metrics: `correct`, `total`, `accuracy` (0..1), `stopped_early`, `difficulty_reached`, `mean_ms`. Order items from easy to hard; a quiz probe starts at the lowest `difficulty`.

```json
{
  "kind": "items",
  "stop_after_wrong": 2,
  "items": [
    { "type": "choice", "id": "q1", "prompt": "How wide is a normal stance?", "options": ["Shoulder width", "Feet together"], "answer": 0, "difficulty": 1, "nodes": ["setup"] },
    { "type": "order", "id": "q2", "prompt": "Put the steps in order.", "items": ["Set feet", "Brace", "Move"], "difficulty": 2, "nodes": ["setup"] },
    { "type": "predict-output", "id": "q4", "prompt": "What prints?", "code": "total = 0\nfor n in [1, 2, 3]:\n    total += n\nprint(total)", "language": "python", "options": ["3", "6"], "answer": 1, "difficulty": 2 }
  ],
  "pass": "accuracy >= 0.8"
}
```

## Task, sensor, game and self-report specs

These four are parsed for shape only; nothing checks their expressions, so use the metric names exactly.

**Task (interaction).** `task`: `type-text`, `shortcuts`, `mental-math`, `click-targets`, `sequence`. `content`: 1–100 strings (the text to type, the shortcuts, the problems). `duration_s` 5–600. `pass`. Metrics (`INTERACTION_METRICS`): `wpm`, `accuracy`, `consistency`, `mean_ms`, `errors`, `completed`.

```json
{ "kind": "task", "task": "type-text", "content": ["the quick brown fox jumps over the lazy dog"], "duration_s": 60, "pass": "wpm >= 30 && accuracy >= 0.95" }
```

**Sensor.** `detect`: `cadence`, `swing-tempo`, `steadiness`, `step-count`, `impact`. `placement`: `pocket` (default), `hand`, `wrist`, `strapped`, `on-object`. `duration_s` 5–600 (default 30). `target`: metric name to number. `pass`. Metrics (`SENSOR_METRICS`): `cadence_spm`, `tempo_ratio`, `backswing_ms`, `downswing_ms`, `steadiness`, `steps`, `peak_g`.

```json
{ "kind": "sensor", "detect": "cadence", "placement": "pocket", "duration_s": 120, "target": { "cadence_spm": 170 }, "pass": "cadence_spm >= 160 && cadence_spm <= 180 && steadiness >= 0.7" }
```

**Game.** `game`: `chess`, `go`, `other`. `position` (FEN or SGF), `moves` (SAN or UCI), `side` (`white`, `black`, `both`). `engine`: `uci`, `gtp` or `none` (default); the engine is optional and installed by the learner. `depth` 1–30 (default 12). `fallback_items`: `{position, best, prompt}` tactics used when no engine is installed; always provide them. `pass`. Metrics (`GAME_METRICS`): `agreement`, `blunders`, `mistakes`, `inaccuracies`, `mean_eval_loss_cp`, `legal_moves`, `puzzles_solved`, `puzzles_total` (the engine also reports `moves_evaluated`, which is not in the constant). Without an engine only `legal_moves` and the puzzle metrics exist.

```json
{ "kind": "game", "game": "chess", "side": "both", "engine": "uci", "depth": 12,
  "fallback_items": [{ "position": "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", "best": "Rd8#", "prompt": "White to move. Find mate in one." }],
  "pass": "agreement >= 0.7 && blunders <= 1" }
```

**Self-report.** Always available, always labeled as self-reported. `fields`: any of `minutes`, `effort`, `felt`, `pain`, `done`, `count`, `note`, `photo` (default `minutes`, `effort`, `felt`). `criterion`: what counts as done, in the learner's words (200 chars). `pass`. The metric names are the field names. A self-report proof needs no `spec`.

```json
{ "kind": "self-report", "fields": ["done", "minutes", "effort", "photo"], "criterion": "Made it start to finish and took a photo of the result", "pass": "done && minutes >= 30" }
```

## Sim spec (`render_sim` and `sim` cards)

A declarative interactive figure: parameters, formulas, one figure and a live readout. Nothing you write runs as code. It goes in a lesson's `sim` card (or in `render_sim`), not in `specs`.

| Field | Meaning |
|---|---|
| `title`, `prompt`, `takeaway` | `prompt` and `takeaway` are 25 words or fewer. |
| `params` | 1–4. Name (`^[a-z_][a-z0-9_]*$`) to `{label, min, max, step?, default?, unit?}`; `min` is below `max`. |
| `formulas` | Name to expression; may use params and earlier formulas. |
| `figure` | One of the kinds below. |
| `readout` | Up to 4 `{value, label, unit?, decimals?}`; `value` names a param or formula. |

Figures: `plot` `{x, series[1-4], marker?}` (y over the range of param `x`); `bars` `{values}` (1–8); `gauge` `{value, min, max, good?}`; `linkage` `{points: {name: [x_expr, y_expr]}, segments, labels?}` (coordinates 0–100); `timeline` `{events, length, reference?}`; `grid` `{rows, cols, cell}` (up to 16 by 16, `cell` uses `row` and `col`). Formulas may also use `pi`, `tan`, `atan`, `atan2`, `asin`, `acos`, `deg`, `rad`, `lerp`, `range_list`, `seq`.

```json
{
  "kind": "sim",
  "title": "Depth and load",
  "prompt": "Drag the slider.",
  "params": { "depth_cm": { "label": "Depth", "min": 0, "max": 60, "default": 20, "unit": "cm" } },
  "formulas": { "load_pct": "clamp(depth_cm * 1.5, 0, 100)" },
  "figure": { "kind": "plot", "x": "depth_cm", "series": ["load_pct"] },
  "readout": [{ "value": "load_pct", "label": "Load", "unit": "%", "decimals": 0 }],
  "takeaway": "Deeper means more load."
}
```

`validate_skill_model` does not run the sim checks (unknown names, undefined points, word limits). Call `render_sim` once with it.

## Fallbacks

When an engine isn't available here (`get_capabilities`), never block. Defaults: movement, audio, speech, visual, interaction and sensor fall back to `self-report`; code and game fall back to `knowledge`; knowledge and self-report have none.

Record it in three places:

1. **Proof.** `proof.fallback` (the engine) and, unless it is `self-report`, `proof.fallback_spec` (a spec of that engine's kind in `specs`).
2. **Model.** `fallbacks` maps wanted to used: `"fallbacks": { "game": "knowledge" }`.
3. **Engines.** Put both engines in `engines`, so specs of both kinds are allowed.

```json
"proof": { "engine": "game", "spec": "game-review", "label": "Review one game: at most 2 blunders",
  "criteria": [{ "id": "blunders", "label": "Few blunders", "check": "blunders <= 2" }],
  "fallback": "knowledge", "fallback_spec": "tactics-set" }
```

The validator, when it knows the capabilities: primary available, fine. Primary missing and fallback available: passes with a warning that the check is less precise. Primary missing and no available fallback: error (`self-report` always counts). A fallback other than `self-report` with a missing or unknown `fallback_spec`: error. Without capabilities none of this is checked.

Then tell the learner the check is less precise, mark results `precision: reduced`, and suggest an open-source install (a UCI engine, `ffmpeg`, a local vision model).

## What the validator catches in specs

| Mistake | Message or cause | Fix |
|---|---|---|
| Unknown body point | `unknown name "left_foot"` | Use a name from the table: `left_ankle`, `left_foot_index`. |
| Unknown function | `unknown function "angle_arc"` | Use the functions above; draw with `overlay(...)`, `beat_timeline`, `ghost`. |
| Metric uses a later metric | `unknown name "b"` | Reorder `metrics`; later ones may use earlier ones. |
| `segment.signal` or `phases` uses a metric | same message | Use points only. |
| Unknown `per` or `at` | `unknown segment kind` / `unknown phase "foo"` | Use a listed segment; declare the phase under `phases`. |
| `per` or `at` outside `metrics` | `unexpected trailing input` | Move the clause to a metric; compute the rest in `when`. |
| Chained comparison, stray symbol | `unexpected trailing input`, `unexpected character` | `a > 1 && a < 3`. |
| Audio `pitch` or `notes` without a reference | `needs a reference` | Add `reference`. |
| Audio `rhythm` with no tempo or reference | `needs a tempo or a reference` | Add `tempo`. |
| Speech without `target` or `prompt` | `needs a target text or an open prompt` | Add one. |
| `tone_pattern` without `tones` | `needs tones: true` | Set `tones`. |
| Rubric with one level, bad `measure`, level text over 25 words | rubric messages | Two or more levels; use a listed measure. |
| `safety_critical: true` | `never the proof for anything safety-critical` | Use another engine or mark it supervised-only. |
| Test path with `..` | `must stay inside the workspace` | Relative paths only. |
| Items: answer index out of range, prompt over 40 words | items messages | Fix the index; shorten. |
| Spec engine missing from `engines` | `a <kind> spec needs engine "<id>"` | Add the engine. |
| Spec of the wrong kind for a drill, proof or probe | `is scored by ...`, `is for ...` | Match engine to spec kind (table at the top). |

Not caught: wrong argument counts to movement functions; names in audio, speech, items, task, sensor, game and self-report `pass` and `when` expressions; the contents of those last four specs (task, sensor, game, self-report are parsed for shape only); the beat-grammar of a `pattern`; the rubric `level_from` and `pass` expressions. Check them by reading the metric tables above.

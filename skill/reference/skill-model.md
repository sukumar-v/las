# Writing a skill model

A skill model is one JSON object: everything LAS needs for one skill. You write it, `validate_skill_model` checks it and stores it, and onboarding, sessions and progress all run from it. It is data. It has no code, no colors, no fonts and no layout (the learner's theme draws everything).

Start from `draft_skill_model` (skeleton, available engines, any previous or curated model). Keep it general: the same screens, answer types and drill types serve every skill. The snippets below use a made-up physical skill called "the skill" with neutral ids. Replace everything with content for the real skill.

## Scaffold and fallback content

From v0.2 you coach live ([live coach](../../docs/design/live-coach.md)): during a session you write each lesson, drill, feedback headline and message for this learner, now. The skill model is then two things:

- **The scaffold** (required): the ladder and proofs, the skill graph with its BKT and review cards, drills with their types, specs, needs, success, difficulty and intensity, engine specs, mistakes with detectors and fix drills, warm-ups, safety, access, injuries, focus, key metrics, and the onboarding data (why, pictures, probes, placement). Onboarding, the planner, the engines and the safety rules run on it, and your live screens must reference it (`coach_show` can't invent a metric spec or a drill type mid-session).
- **The fallback content** (optional in the schema, but write all of it): lesson cards, practice-only knowledge items and drill prompts, mistake `headline` and `explain`. The studio shows it only when no coach is present, or when you miss the screen deadline. `validate_skill_model` passes the model and warns once per gap, naming what the studio does without you; with no fallback it never invents text (it skips to the next screen the scaffold can build and uses the mistake's `name` as a headline). A session must never block on a model, so the evals require full fallback content.
- **Defaults when left out:** a lesson's `cards` is `[]` (the lesson still needs its id, title and nodes: nodes name it), an items spec's `items` is `[]`, a mistake's `headline` is `""`, which means none (not a blank headline), and `explain` and a drill's `prompt` are absent. An items spec that a level check or a proof reads must have its items: that's an error.

## Conventions

- **Ids** are lowercase: `^[a-z0-9][a-z0-9-_.]*$`. If an id appears in an expression (metric names, rubric criteria, probe ids), use only letters, digits and `_`, because `-` is subtraction there.
- **Words** are counted as whitespace-separated tokens with a letter or digit. Figures don't count.
- Learner-facing text is short. Budgets the validator enforces:

| Text | Limit |
|---|---|
| Lesson card (`text`, plus `predict` options and `reveal`, plus a `sim` card's `prompt`) | 25 words |
| Drill `prompt`, probe `question`, proof `label`, rubric level description, sim `prompt` and `takeaway` | 25 words |
| Ladder step `label` | 10 words |
| Mistake `headline` | 8 words |
| Knowledge item `prompt` | 40 words |

- `engines` lists every engine the model touches: proofs, mistakes, key metrics, and any spec kind you use. Include the fallback engines too (`self-report` almost always).
- If the schema is invalid, `validate_skill_model` returns only schema errors. Fix those first; the other checks run after.

## Top-level fields

| Field | Required | Purpose |
|---|---|---|
| `schemaVersion` | no | Always `1`. |
| `skill` | yes | What the learner typed (80 chars). |
| `name` | yes | Display name (60). |
| `noun` | yes | Lowercase noun used inside questions: "the skill", "bouldering" (40). |
| `source` | no | `generated` (default) or `curated`. Write `generated`. |
| `based_on_pack`, `pack_version` | no | Set when you started from a curated pack. |
| `physical` | yes | `true` for anything done with the body. Triggers the safety checks. |
| `engines` | yes | Engines used (at least one). |
| `fallbacks` | no | `{wanted: used}`, e.g. `{"audio": "self-report"}`. Record it when an engine you wanted is missing. |
| `why` | yes | 3–8 reasons, worded for this skill. |
| `pictures` | yes | 2–8 six-month pictures. |
| `probes` | yes | 1–3 level checks. |
| `placement` | no | Rules mapping the answers to a ladder step. |
| `ladder` | yes | 4–9 steps (aim for 5–8) with hours and proofs. |
| `nodes` | yes | The skill graph. |
| `lessons` | yes | Teaching cards. |
| `drills` | yes | Practice items of the standard types. |
| `specs` | no | Engine specs by id. See [spec-languages.md](spec-languages.md). |
| `mistakes` | no | The mistake library. |
| `warmups`, `safety` | physical: yes | Warm-ups and safety fields. |
| `access` | no | Equipment and places the skill can need. |
| `injuries` | no | `{injury: training rule}`. Physical skills should have it. |
| `focus` | yes | Default practice mix, category to share, sums to 100. |
| `hard_focus` | no | Categories an injury lowers. |
| `key_metrics` | yes | 1–3 (use 2–3) numbers shown with a trend. |
| `media` | no | Local files only, license `CC0`, `CC-BY-4.0` or `learner`. Never a URL. |
| `copy` | no | `placeholder` and `blurb` for the skill tile. |
| `notes` | no | Your sources and reasoning (2000 chars). Never shown to the learner. |
| `version`, `id` | no | Set by the server. |

## Why

3–8 reasons in the learner's voice. Pictures point at them by id.

```json
"why": [
  { "id": "fun", "label": "For fun" },
  { "id": "health", "label": "Stay healthy" },
  { "id": "challenge", "label": "Push my limits" },
  { "id": "show", "label": "Show someone" }
]
```

`label` is at most 40 characters. `icon` is an optional short word, not an image.

## Pictures

"Six months from now, what are you doing?" Each picture is tagged with the reasons it fits (`why`). Onboarding ranks matches first with a "Fits your why" badge, so tag honestly: every why should fit at least one picture.

```json
"pictures": [
  { "id": "weekly", "label": "A weekly habit I enjoy", "why": ["fun", "health"],
    "ladderStep": 2, "milestone": "Ten clean reps in a row", "proof": "One clip, ten clean reps",
    "focus": { "Fundamentals": 40, "Technique": 40, "Theory": 20 }, "access": ["A clear floor"] },
  { "id": "perform", "label": "Showing it to friends", "why": ["show", "challenge"],
    "ladderStep": 3, "milestone": "A smooth set at pace", "proof": "One clip at target pace",
    "focus": { "Fundamentals": 20, "Technique": 50, "Theory": 10, "Pace": 20 }, "access": ["A friend to film"] }
]
```

- `ladderStep` is an index into `ladder` (the step this picture needs). It must exist.
- `milestone` (80 chars) and `proof` (120) are the picture's own wording. They are the "toward your picture" milestone.
- `focus` is this picture's practice mix. It sums to 100 (a tolerance of 5 is allowed). Its category names should be the same ones `model.focus`, `node.focus` and `drill.focus` use.
- `access` is extra equipment this picture needs on top of the skill's own `access`.
- Make the pictures differ in more than words: different ladder steps, different mixes.

## Probes

1–3 level checks, **standard answer types only**: `single`, `multi`, `scale`, `visual-multi`, `quiz`, `tap`, `record`, `code`. The first screen always also offers "I'm completely new to this".

| Type | Needs | Behavior |
|---|---|---|
| `single` | `options` (2+) | One tap. |
| `scale` | `options` (2+) | Like `single`, in the skill's own terms (grades, belts, levels). |
| `multi` | `options` (2+), optionally `max` | Pick several. |
| `visual-multi` | `options` (2+), each with a `figure` | Pick from pictures. |
| `quiz` | `spec` id | Items spec; gets harder, stops after wrong answers (`stop_after_wrong`). |
| `tap` | `spec` id | Short timing test. |
| `record` | `spec` id | Optional short capture, analyzed by that spec's engine. |
| `code` | `spec` id | Short coding check; use a `test` spec. |

```json
"probes": [
  { "id": "level", "type": "scale", "question": "How much have you done?",
    "options": [{ "value": 0, "label": "Never" }, { "value": 1, "label": "A few times" },
                { "value": 2, "label": "Most weeks" }, { "value": 3, "label": "Years" }] },
  { "id": "known", "type": "multi", "question": "Which of these can you do?", "max": 3, "optional": true,
    "options": [{ "value": "setup", "label": "Set up from scratch" }, { "value": "core", "label": "A clean core move" }] },
  { "id": "theory", "type": "quiz", "question": "Three quick questions.", "spec": "setup-quiz" }
]
```

Option `value` is a string or number (the thing placement rules compare against). `label` is at most 60 characters, `detail` 80. `question` is at most 25 words.

## Placement

Rules run in order. **The first rule whose `when` is true wins; no match means step 0.** Write the highest steps first.

```json
"placement": [
  { "when": "level >= 3 && quiz.correct >= 3", "step": 3, "evidence": "Years of practice" },
  { "when": "level >= 2 && contains(known, 'core')", "step": 2 },
  { "when": "level >= 1 || quiz.correct >= 1", "step": 1 }
]
```

`when` is an expression (max 200 chars) in the [expression language](spec-languages.md#the-expression-language). Variables:

| Variable | Value |
|---|---|
| each probe `id` | `single` and `scale`: the chosen option's `value`. `multi` and `visual-multi`: the list of chosen values (`contains(known, 'core')`, `count(known)`). |
| `quiz.correct` | Right answers in the quiz probe. |
| `quiz.answered` | Questions answered in the quiz probe (so `quiz.correct / quiz.answered` is accuracy). |
| `fresh` | `true` when the learner tapped "I'm completely new to this". Such learners start at step 0. Use it to guard rules: `!fresh && level >= 2`. |

`step` is a ladder index and must exist. `evidence` (80 chars) is the line shown as "Placement: ..." under the result. The learner can move the placement one step at a time ("too easy" / "too hard"), so be a little conservative. Use only the answers the learner actually gave: a skipped optional probe has no value. The validator parses `when` but does not check the variable names, so check them by hand.

## Ladder and proofs

The ladder is what the learner sees: steps with hour ranges and a proof. Step 0 is the starting point: `hours: [0, 0]`, no `nodes`, no `proof`. Every later step has `hours: [low, high]` (hours from the previous step, low at most high), `nodes` (the nodes that must be mastered), and a `proof`.

```json
"ladder": [
  { "id": "start", "label": "Brand new", "hours": [0, 0] },
  { "id": "first-rep", "label": "One clean rep", "hours": [2, 4], "nodes": ["setup"],
    "proof": {
      "engine": "movement", "spec": "move-metrics",
      "label": "Five reps, each deep enough",
      "criteria": [
        { "id": "depth", "label": "Deep enough", "check": "share(depth_ok) >= 0.8" },
        { "id": "count", "label": "Five reps", "check": "reps >= 5" }
      ],
      "capture": { "angle": "side", "fps": 30, "duration_s": 45 },
      "fallback": "self-report"
    } },
  { "id": "at-pace", "label": "Smooth at pace", "hours": [15, 30], "nodes": ["pace"],
    "proof": { "engine": "self-report", "label": "Log three paced sessions",
      "criteria": [{ "id": "logged", "label": "Three sessions", "check": "count >= 3" }] } }
]
```

- Hours are ranges and estimates. Cite your sources in `notes` (or the step's `sources`) when you could search.
- A proof's `engine` is in `engines`. Unless the engine is `self-report`, `spec` names a spec in `specs` **of that engine's kind** (metric for movement, audio for audio, and so on).
- `criteria` (1–6): each has an `id`, a `label` and a `check`, an expression over the metrics that spec produces. `check` is parsed but its names are not verified, so use exactly the metric names the spec defines (see [spec-languages.md](spec-languages.md)).
- `capture` (optional) states the camera angle, fps and length. `single_take` is always true: a proof is one continuous take.
- `fallback` is the engine to use when the primary one isn't available here. Anything other than `self-report` also needs `fallback_spec` (a spec id). Details in [spec-languages.md](spec-languages.md#fallbacks).
- Never make a safety-critical rubric the proof. Never put supervised-only activities in a proof.
- A proof says what the learner can do, not how long they practiced. Write it so it can be failed.

## Nodes (the skill graph)

Nodes are the units the planner schedules and tracks. `requires` makes the graph. Every node needs a lesson, at least one drill and a review card.

```json
"nodes": [
  { "id": "setup", "name": "Setup", "requires": [], "lesson": "setup-lesson", "drills": ["setup-check"],
    "review": { "prompt": "Where do your feet go?", "kind": "choice", "options": ["Shoulder width", "Together"], "answer": 0 },
    "focus": "Fundamentals" },
  { "id": "core-move", "name": "The core move", "requires": ["setup"], "lesson": "core-lesson",
    "drills": ["core-reps"], "mistakes": ["shallow"],
    "review": { "prompt": "Which angle counts as deep?", "kind": "choice", "options": ["95 degrees", "150 degrees"], "answer": 0 },
    "focus": "Technique" }
]
```

- `review.kind` is one of `choice | hotspot | fill | say | play | recall`. `options` and `answer` (an index, or a string) are optional, and `review.figure` can hold a figure. Keep the prompt visual-friendly and short (160 chars).
- `bkt` (`p_init`, `p_learn`, `p_slip`, `p_guess`) has defaults. Leave it out unless you have a reason.
- `focus` is the practice-mix category this node counts toward.
- No cycles. A node cannot require itself. Every node must sit on the path to some ladder step (named in a step's `nodes`, or a prerequisite of a node that is).
- A node a step needs should not have a prerequisite that first appears at a later step (a warning).
- One new idea per node. A node that needs two lessons is two nodes.

## Lessons and cards

A lesson has 1–5 cards. **Every card is 25 words or fewer and the first card is a `predict`** (ask before showing). Seven card types:

| Type | Fields | Use |
|---|---|---|
| `predict` | `text`, `options` (2–4), `answer` (index), optional `figure`/`figures`, `reveal` | Ask before showing. |
| `sim` | `text`, `sim` (a sim spec) | Sliders with a live readout. See [spec-languages.md](spec-languages.md#sim-spec-render_sim-and-sim-cards). |
| `mechanism` | `text`, `concept`, optional `figure` | How something works. |
| `diagram` | `text`, `figure` | A figure with one line of text. |
| `demo` | `text`, `figure`, `playback` (`steps`, `loop`, `once`) | Step-through of a move, a pattern, a trace. |
| `compare` | `text`, `left`, `right` figures, optional labels, `hotspot`, `answer` (`left`/`right`) | Good against bad; tap the difference. |
| `try-it` | `text`, `action` (`tap-rhythm`, `say-it`, `hold-pose`, `type-it`, `count`), optional `pattern`, `target`, `seconds` | A small action in the card. |

Figures (`kind`): `mechanism`, `mermaid`, `graph`, `figure` (points in 0–100 coordinates plus segments and marks), `notation` (ABC), `rhythm`, `code`, `chart`, `media` (the learner's own file), `contour`, `space`. Marks and points use roles (`good`, `attention`, `reference`, `neutral`), never colors.

```json
"lessons": [
  { "id": "core-lesson", "title": "The core move", "nodes": ["core-move"], "cards": [
    { "type": "predict", "text": "Where should your weight sit?", "options": ["Toes", "Mid-foot"], "answer": 1,
      "reveal": "Mid-foot keeps the load steady." },
    { "type": "sim", "text": "Drag the depth. Watch the load.",
      "sim": { "title": "Depth and load", "params": { "depth_cm": { "label": "Depth", "min": 0, "max": 60, "unit": "cm" } },
               "formulas": { "load_pct": "clamp(depth_cm * 1.5, 0, 100)" },
               "figure": { "kind": "plot", "x": "depth_cm", "series": ["load_pct"] },
               "readout": [{ "value": "load_pct", "label": "Load", "unit": "%" }] } },
    { "type": "compare", "text": "Same move, two reps. Tap the difference.",
      "left": { "kind": "mechanism", "concept": "good depth" }, "right": { "kind": "mechanism", "concept": "shallow depth" },
      "hotspot": "knee", "answer": "right" }
  ] }
]
```

- `lesson.id` is required here. `nodes` lists the nodes it teaches. `title` is at most 60 characters.
- Use the figure that shows the idea: `figure` for a body or linkage, `rhythm` for a pattern, `notation` for notes, `code` with a `trace` for programs, `contour` for pitch, `space` for a vowel or position chart. Prefer `mechanism`/anatomy tools if the client has them (see SKILL.md routing).
- `predict.answer` must be a valid option index. The validator does not enforce that the first card is a `predict`, but write it that way.
- A mistake's `explain` points at a lesson card, so keep an explaining card (usually a `compare`) in the lesson.

## Drills

Drills use only the standard types. The type decides the engine that scores it, and so the kind of spec it needs.

| Type | Scored by | `spec` kind | Gets harder by |
|---|---|---|---|
| `choice`, `match`, `order`, `hotspot`, `predict-output`, `fill` | knowledge | `items` | more distractors, longer code, fewer hints |
| `tap-rhythm` | interaction | `task` | tempo |
| `play-along` | audio | `audio` | tempo, longer passages |
| `say-it` | speech | `speech` | longer sentences, natural speed |
| `move`, `timed-reps` | movement | `metric` | harder holds, more reps |
| `build` | code | `test` | harder tests |
| `make` | visual | `rubric` | rubric level |

```json
"drills": [
  { "id": "setup-check", "type": "choice", "title": "Setup check", "prompt": "Pick the steadier setup.",
    "nodes": ["setup"], "spec": "setup-quiz", "minutes": 2, "intensity": 1, "focus": "Fundamentals" },
  { "id": "core-reps", "type": "move", "title": "Reps to depth", "prompt": "Film five slow reps from the side.",
    "nodes": ["core-move"], "spec": "move-metrics",
    "capture": { "angle": "side", "fps": 30, "duration_s": 45 }, "needs": ["A clear floor"],
    "success": "share(depth_ok) >= 0.7",
    "difficulty": { "param": "reps", "levels": [5, 8, 12], "start": 0 },
    "minutes": 6, "intensity": 3, "focus": "Technique", "fixes": ["shallow"] }
]
```

- `success` is an expression over the drill's result metrics (the spec's metrics). True means success. It is parsed, not name-checked.
- `difficulty.param` names the thing that grows; `levels` are ordered (labels or numbers, 1–8); `start` is an index. Match the table: tempo, reps, length, hints.
- `intensity` is 1–5 and feeds the beginner caps and injury rules. `minutes` is 1–30.
- `needs` lists equipment or places, using the same wording as `access`. A drill is skipped when the learner lacks one.
- `fixes` lists the mistake ids this drill targets (the fix drill of a mistake).
- `focus` is the practice-mix category the drill counts toward.
- Knowledge drills use an `items` spec (preferred). Inline `items` (strings) are accepted instead, but a spec is clearer.
- Performance drills (`move`, `play-along`, `say-it`, `build`, `make`) need a spec of the right kind. A `tap-rhythm` with a spec must use a `task` spec.
- The drill `prompt` is an instruction of 25 words or fewer.

## Mistakes

The mistake library: detector, a visual explanation, and a fix drill. The detection itself (`when` over metrics) also lives in the spec's own `mistakes` list; give both the same id.

```json
"mistakes": [
  { "id": "shallow", "name": "Shallow reps", "nodes": ["core-move"], "engine": "movement",
    "detector": { "metric": "depth_ok", "when": "share(not depth_ok) >= 0.3", "min_share": 0.3, "min_confidence": 0.7 },
    "severity": 2,
    "explain": { "lesson": "core-lesson", "card": 2 },
    "fix_drill": "core-reps", "resolved_after": 3,
    "headline": "Reps stop above the target depth" }
]
```

- `headline` is 8 words or fewer. `""` (the default) means none: the fallback feedback uses `name`, with a warning.
- `detector.metric` is a metric the engine's spec produces. `when` is an expression over metrics; use `learner.baseline.*` to be relative to the learner's own body or first attempts. `min_confidence` defaults to 0.7: below that a correction is never shown.
- `explain` is `{lesson, card}` (a lesson id and a card index) or `{figure}`. A figure explains with a picture, not text.
- `severity` 1–3. `resolved_after` is the number of attempts in a row without it (default 3).
- Each mistake has a `fix_drill` that exists, and `nodes` that exist. List the mistake in the node's `mistakes`, and in the fix drill's `fixes`.
- Write 3–6 mistakes that the engine can really detect, not a list of everything that can go wrong.

## Warm-ups and safety (physical skills)

Required when `physical` is true.

```json
"warmups": [
  { "id": "easy-start", "title": "Easy start", "steps": ["Two minutes of easy movement", "Ten slow bodyweight reps"],
    "minutes": 4, "for_injuries": ["Knees"] }
],
"safety": {
  "warmup": "easy-start",
  "injury_questions": ["Any knee or back pain right now?"],
  "beginner_caps": { "max_intensity": 3, "max_minutes": 40, "sessions_per_week": 4 },
  "stop_criteria": ["Sharp pain", "Dizziness"],
  "see_professional": ["Pain that lasts more than a week"],
  "supervised_only": []
}
```

- `safety.warmup` is the id of a warm-up. A warm-up has 1–8 steps of at most 80 characters, 1–20 minutes; `for_injuries` makes it the variant for those injuries.
- `injury_questions` are asked in onboarding; word them as the question the learner sees.
- `beginner_caps` limit intensity (1–5), minutes per session and sessions per week for beginners.
- **`supervised_only`** lists activities LAS teaches the theory of but never coaches or assesses: breath-holding and anything underwater, rope systems and belaying, maximal lifts, full-contact sparring, firearms, vehicles and aircraft, anything where a mistake can kill. The validator scans the skill name, ladder labels and picture labels and milestones for those words and rejects the model if one appears without a matching `supervised_only` entry. Word your entry with the same key word ("belaying and rope systems", "heavy lifting with a maximal load"). If a harmless word trips it (a ball sport's "shooting"), rename the ladder label, don't list the activity. Keep supervised-only activities out of drills, proofs and mistakes.

## Access, injuries, focus, key metrics

```json
"access": ["A clear floor", "A phone to film with"],
"injuries": { "Knees": "Cut depth to what is pain free; skip loaded reps for two weeks" },
"focus": { "Fundamentals": 40, "Technique": 40, "Theory": 20 },
"hard_focus": ["Technique"],
"key_metrics": [
  { "id": "depth", "label": "Reps to depth", "engine": "movement", "metric": "depth_ok", "unit": "%", "better": "higher", "format": "percent" },
  { "id": "quiz", "label": "Setup quiz", "engine": "knowledge", "metric": "accuracy", "format": "percent" }
]
```

- `access` items are short (40 chars) and are what the equipment screen offers. `needs` on drills and `access` on pictures use the same words.
- `injuries` keys are the injuries offered to the learner ("Knees", "Fingers"). Each value is a training rule of at most 160 characters, shown in the plan. Name what to skip, what to do instead and for how long.
- `focus` is the default mix. Its category names are the vocabulary for `picture.focus`, `node.focus`, `drill.focus` and `hard_focus`. `hard_focus` entries must be keys of `focus` (a warning otherwise).
- `key_metrics`: `engine` is in `engines`; `metric` is a metric name that engine's spec produces; `better` is `higher` or `lower`; `format` is `number | percent | ms | count | cents`.

## What `validate_skill_model` rejects

Errors block storing. Warnings don't. The `check` label is in each result.

| Area (`check`) | Rejected |
|---|---|
| `schema` | Anything the schema forbids: unknown enum values (probe type, drill type, card type, engine), missing required fields, too many or too few items, over-long strings, bad ids, `ladder` outside 4–9 steps, `probes` outside 1–3, `key_metrics` outside 1–3. |
| `spec` | A spec that fails its own checks: unknown body point, unknown function, bad syntax, unknown `per` or `at` name, a rubric with fewer than 2 levels or an unknown `measure`, a test spec whose path leaves the workspace, audio grading pitch or notes with no reference, a speech spec with no `target` or `prompt`, and the like. Path reads `specs.<id>...`. |
| `engines` | A spec kind whose engine is missing from `engines`. A proof, mistake or key metric using an engine not in `engines`. |
| `word-budget` | A card over 25 words, a drill prompt, probe question, proof label over 25, a ladder label over 10, a headline over 8. |
| `refs` | Any id that doesn't exist: node in a lesson, drill or mistake; lesson, drill, mistake or prerequisite in a node; spec in a drill, probe or proof; fix drill; `explain.lesson`; a picture's `why` or `ladderStep`; a placement `step`; `safety.warmup`. |
| `graph` | A node that requires itself, a prerequisite cycle, or a node that is on the path to no ladder step. |
| `ladder` | `hours` with low above high; a step past 0 with no `nodes`. |
| `proof` | A step past 0 with no proof; a non-self-report proof with no `spec`; a proof whose spec belongs to another engine; a fallback engine with no `fallback_spec` (when engines were checked). |
| `expr` | A placement `when`, drill `success`, proof `check` or mistake `detector.when` that doesn't parse. |
| `mix` | `focus` (model or picture) that doesn't sum to 100 within 5. |
| `probe` | `single`, `multi`, `scale`, `visual-multi` without 2+ options; `quiz`, `tap`, `record`, `code` without a `spec`; `visual-multi` options without a `figure`. |
| `spec` (drills) | A `move`, `play-along`, `say-it`, `build` or `make` drill with no spec, or with a spec of the wrong kind; a knowledge drill with neither a spec nor inline `items`. |
| `safety` | `physical: true` with no `safety`; a warm-up id that doesn't exist; a supervised-only activity named in the skill, ladder or pictures without a `supervised_only` entry; a rubric marked `safety_critical` used as a proof. |
| `capabilities` | When `get_capabilities` is known: a proof whose engine isn't available here and has no available fallback (`self-report` always counts). |
| `assets` | A `media.path` starting with `http`. |

Warnings: no placement rules; step 0 hours other than `[0, 0]`; a prerequisite that appears at a later step; `hard_focus` not in `focus`; physical skill with no `injuries`; a proof engine that isn't available here (its fallback is used). Fallback gaps (check `fallback`), one warning each: a lesson with no cards, an items spec with no items, a drill with no prompt, a mistake with headline `""`, a mistake with no `explain` or one pointing at a lesson with no cards.

### Passes validation, still wrong

The validator checks that expressions parse and that ids exist. It does not check:

- that the ids in a ladder step's `nodes` name real nodes. A typo there passes silently, and the real node then fails the "on the path" check, or worse, doesn't.
- that names in a proof `check`, a drill `success`, a detector `when` or a placement `when` exist. A typo evaluates to nothing at runtime. Reuse the metric names from the spec, character for character.
- that a metric in `key_metrics` or `detector.metric` exists in the spec.
- that a `focus`, `needs` or `access` string matches elsewhere in the model.
- that a `quiz` probe or knowledge drill points at an `items` spec, or that the drill type matches the item types.
- that `explain.card` is a valid index, or that each spec mistake's `fix_drill` exists. Use the same id for a spec mistake and its library entry.
- that the sim formulas inside `sim` cards are valid (run `render_sim` once while drafting).
- that `fallbacks` agrees with the fallbacks on the proofs.
- that supervised-only activities are absent from drills or proofs.
- that the ladder is believable. Hours and proofs are your judgment.

## How onboarding uses the model

LAS runs the rules; you supply the data. Nothing after the first question is the same for everyone.

| Output | Reads | Rule |
|---|---|---|
| Why options | `why` | Shown as written. |
| Picture options | `pictures[].why` | Matches to the learner's why come first, with a "Fits your why" badge. |
| Level screens | `probes` | 1–3 screens of the standard types, plus "I'm completely new to this". |
| Starting point | `placement`, `ladder` | First matching rule gives the step. "Too easy" / "too hard" moves it one step. |
| Equipment options | `access` + the chosen picture's `access` | The skill's basics plus what the picture needs. |
| Injury options | `injuries` keys, `safety.injury_questions` | Asked on the "Anything we should plan around?" screen. |
| Milestone suggestions | `ladder` hours, `pictures` | **Quick win**: the next step after the starting point. **Stretch**: the furthest step reachable in about 6 weeks at the learner's weekly hours. **Toward your picture**: the picture's `ladderStep`, `milestone` and `proof`. A deadline or a reason (trip, event, exam) puts the quick win first; otherwise the picture's leads. The learner can also pick any ladder step or use their own words. |
| Feasibility | hours per step, weekly time, deadline | Realistic, fits your deadline, ambitious or long road. If too far, a closer stepping stone is offered. |
| Practice mix | `picture.focus`, `hard_focus` | Starts from the picture's mix. Beginners get +10 to fundamentals. An injury lowers the `hard_focus` categories and adds recovery and prehab. |
| Injury rules on the plan | `injuries`, `warmups[].for_injuries`, drill `intensity`, `safety.beginner_caps` | The injury's rule is shown in the plan; matching warm-ups are used; hard drills are capped. |
| Question wording | `noun`, earlier answers | Questions quote what the learner already said. |

Design for this:

- The ladder steps must be far enough apart in hours that quick win, stretch and picture differ.
- Give each picture a distinct `ladderStep`, so the milestone suggestions aren't three copies of one.
- Name a "fundamentals" category in `focus` (and in each picture's mix) so the beginner bonus has somewhere to go. Name the categories an injury should lower in `hard_focus`.
- LAS adds recovery and prehab itself on an injury. You don't need to spend focus share on it.

## Order of work

1. `get_capabilities`. Choose engines, noting fallbacks.
2. Ladder (5–8 steps, hour ranges) and nodes.
3. Specs for the proofs and drills. Write the metrics first; every later field reuses their names.
4. Lessons, drills, mistakes.
5. Why, pictures, probes, placement.
6. Safety and injuries for physical skills.
7. `validate_skill_model`. Fix every error, then reread the "still wrong" list above.

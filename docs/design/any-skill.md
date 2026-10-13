# Any skill: how LAS works without per-skill code

LAS has **no code for any particular skill**. Like [REA](https://github.com/morluto/rea), it gives the agent general-purpose capabilities and lets the agent reason. REA groups its tools by kind of target (native binary, APK, website). LAS groups its tools by **kind of evidence** (video, audio, speech, code, images, answers). For each skill the learner picks, the agent works out which of those apply and writes the plan, the checks and the rubrics at runtime.

Related: [overview](../DESIGN.md) · [learning loop](learning-loop.md) · [evaluation](evaluation.md) · [MCP and data](mcp-and-data.md) · [skill models](skill-packs.md)

---

## 1. Who does what

```mermaid
flowchart LR
  L[Learner: "I want to learn salsa"] --> A[Agent + LAS skill]
  A -->|get_capabilities| S[LAS server]
  A -->|draft_skill_model, validate_skill_model| S
  S --> E[Engines<br/>movement · audio · speech · code<br/>visual · knowledge · interaction · sensor · game]
  A -.->|if present| X[Other MCP servers and skills<br/>anatomy · notation · chess engine · …]
  S --> U[Studio and widgets]
```

| Part | Responsibility | Never does |
|---|---|---|
| **Agent** (any model, guided by the LAS skill) | Understands the skill; writes the skill model; picks visuals and tools; explains results; talks to the learner | Judges raw video or audio itself; changes the plan without asking |
| **LAS server** | Structure (schemas, validation), state (learner model, schedule), the deterministic planner, routing to engines, rendering widgets | Contains logic for a specific skill |
| **Engines** | Measure. They're deterministic, don't know which skill they're measuring, and are configured by specs (§3) | Decide what "good" means: that comes from the spec |
| **Other MCP servers, skills and tools** | Extra power the agent uses when it's available (a chess engine, the anatomy skill, a notation server) | Become a requirement: LAS always has a fallback |

## 2. Engines

Each engine is general-purpose. The agent configures it with a spec; no new code is written for a new skill.

| Engine | Input | What the agent configures | Output | Covers, for example |
|---|---|---|---|---|
| **movement** | Camera or video file | Which body points to track (body, hands, face, objects); a metric spec (§3.1); how to split the clip (repetitions, moves, phrases or whole); an optional reference clip; optional alignment to the music's beat | Joint angles, speeds, repetitions, tempo, range of motion, symmetry, balance, similarity to the reference, share of moves on the beat | Workouts, yoga, dance, martial arts, golf and tennis swings, climbing, running form, sign language, juggling |
| **audio** | Microphone or file | A reference (MusicXML, MIDI, ABC or a recording), tempo, tuning, tolerances | Notes, pitch error (cents), timing error (ms), tempo stability, dynamics, chords | Any instrument, singing, drumming, ear training |
| **speech** | Microphone | Language, target text or an open prompt, a rubric | Transcript, intelligibility (target vs what was recognized), confidence per word, speaking rate, pauses, fillers, pitch contour, per-sound scores where a model exists for that language | Any language Whisper supports, tonal languages (via pitch contour), accents, public speaking |
| **code** | Files | Language, a test spec (§3.3), runner preference | Tests passed, errors, run time, lint findings | Any programming language (§4) |
| **visual** | Photo, scan or screenshot | A rubric (§3.2), an optional reference image, optional points the learner taps on the image | Rubric scores with confidence (from the agent's vision model), plus measurements: proportions from tapped points, symmetry, exposure, color | Drawing, painting, calligraphy, handwriting, crafts, plating, photography, design |
| **knowledge** | Answers | Items generated from the skill model | Accuracy, response time, spaced-repetition state | The theory side of any skill |
| **interaction** | Keystrokes and clicks in the studio | A task spec | Speed, accuracy, consistency | Typing, shortcuts, mental math |
| **sensor** | Phone motion sensors | What to detect | Cadence, swing tempo, steadiness | Running cadence, swing tempo, balance |
| **game** | Positions and moves | Rules, plus an engine if one is installed (§5) | Agreement with the engine's best move, blunders, evaluation loss | Chess, go, other board games |
| **self-report** | Learner input | — | Minutes, effort (RPE), how it felt, pain | Always available as a last fallback, and labeled as such |

Many skills need more than one engine:
- salsa = movement + audio (beat);
- guitar = audio + hand tracking;
- public speaking = speech + movement + visual (slides);
- Mandarin = speech (with tones) + knowledge.

## 3. Spec languages

Specs are data the agent writes and LAS validates. They are **not** code: each one runs on a small, sandboxed set of built-in functions.

### 3.1 Metric spec (movement)

- **Body points:** standard names (MediaPipe naming for body, hands and face; object classes for things like a ball).
- **Functions:** `angle`, `distance`, `velocity`, `height`, `between`, `min`, `max`, `share`, `phase_duration`, `pose_similarity`, `on_beat`.
- **Thresholds** can be relative to the learner's own first attempts (`baseline.*`).
- **Each metric declares the camera angle it needs.** The engine reports low confidence when the actual angle differs.

```yaml
# Squat, written by the agent
capture: { angle: side, fps: 30 }
segment: { by: reps, signal: left_hip.y }
metrics:
  knee_bottom: min(angle(left_hip, left_knee, left_ankle)) per rep
  depth_ok: knee_bottom <= 95
  torso_lean: angle(left_shoulder, left_hip, vertical) at bottom
  tempo_down_s: phase_duration(down)
mistakes:
  - id: shallow
    when: share(not depth_ok) >= 0.3
    show: overlay(angle(left_hip, left_knee, left_ankle))
    fix_drill: box-squat-to-depth
```

```yaml
# Salsa basic step against a reference clip the learner supplied
capture: { angle: front, fps: 30 }
reference: learner-media/teacher-basic.mp4
segment: { by: phrases, beats: 8, beat_source: audio_track }
metrics:
  timing: on_beat(left_ankle, right_ankle)              # share of steps landing on the beat
  shape: pose_similarity(reference, joints: [legs, hips], align: dtw)
mistakes:
  - id: rushing
    when: mean(step_offset_ms) < -80
    show: beat_timeline
```

### 3.2 Rubric spec (visual, open speech answers, writing)

```yaml
criteria:
  - id: proportions
    levels: { 1: "Head and body sizes off by more than 25%", 2: "Mostly right", 3: "Within 10%" }
    measure: tapped_points(head_top, chin, feet)        # optional measurement backing up the score
  - id: line_confidence
    levels: { 1: "Hesitant, many re-strokes", 2: "Some", 3: "Single confident strokes" }
must_cite: region                                       # the grader must point to the area of the image it means
```

- Rubric grades come with a confidence and must point at evidence: an image region or a timestamp.
- Rubric grading alone is never the proof for anything safety-critical.
- The learner can always ask for a human review: export the attempt and share it.

### 3.3 Test spec (code)

```yaml
language: rust
entry: src/lib.rs
tests:
  - { call: "count_words(\"\")", expect: "0", hidden: true }
  - native: tests/edge_cases.rs                          # or the language's own test files
runner: [browser, local, container]                     # preference order; LAS picks the first one available
limits: { time_s: 10, memory_mb: 256, network: false }
```

### 3.4 Audio reference spec

```yaml
reference: { score: learner-media/minuet.musicxml, part: right_hand, bars: 1-8 }
tempo: 72
tolerance: { pitch_cents: 30, onset_ms: 60 }
grade: [pitch, rhythm, dynamics]
```

## 4. Code: any language

| Runner | Languages | How | When |
|---|---|---|---|
| **browser** | JavaScript, TypeScript, Python (Pyodide), SQL (SQLite compiled to WebAssembly), plus other languages that compile to WebAssembly where a license-clean runtime exists | Inside the studio; no installs | Default for beginners and on phones |
| **local** | Any language installed on the learner's machine (`get_capabilities` detects `python3`, `node`, `rustc`, `go`, `javac`, `gcc`, `dotnet`, `ruby` and others) | The language's own build and test commands, with time, memory and network limits | Default when that language's toolchain is installed |
| **container** | Anything with a container image | Podman (or Docker Engine) with no network, a read-only mount and limits | When a container runtime is installed and the learner opts in |

- Code runs only after the learner agrees, the first time for each runner.
- Coding agents (Claude Code, Codex, OpenCode…) can already run code. LAS still runs tests through its own runner, so results are recorded, reproducible and sandboxed.
- Beyond tests, the agent can add rubric checks for design, readability and idiom, using the language's standard linters when they're installed.

## 5. Finding and choosing tools

`get_capabilities` returns what is usable right now:

- **Engines:** each one's status (models downloaded, runtime working, GPU or CPU).
- **Code runners:** the browser runtimes; local toolchains with their versions; whether a container runtime is available.
- **Devices** reachable through the studio: camera, microphone, motion sensors, a paired phone.
- **External tools on `PATH`** that LAS knows how to call as separate processes: for example a chess engine, `ffmpeg`, `mkcert`.

The agent already knows which other MCP servers and skills it has. The LAS skill tells it to look for useful ones (the anatomy skill, a diagram or notation server, a chess server) and prefer them when present.

**Routing rules (in the skill):** each need has a first choice and a fallback.

| Need | First choice | Fallback |
|---|---|---|
| Show how a mechanism works | anatomy skill | `render_diagram` or `render_sim` |
| Explain a concept interactively | `render_sim` (sliders, live readout) | `render_diagram` |
| Check a chess game | game engine with an installed engine | Tactics quiz (knowledge) |
| Check pronunciation in a language with no per-sound model | speech intelligibility, plus comparison with the learner's own earlier attempts | Self-report against a reference recording |
| Check a dance with no reference clip | movement metrics (timing on the beat, symmetry, range of motion) | Ask the learner for a reference clip |

**When something is missing:**
- Never block. Fall back, say that the check is less precise, and suggest an open-source install.
- Optional third-party MCP servers (a GitHub server to look at the learner's repository, a calendar for check-ins) are used only with the learner's consent and are never required.

## 6. Skill models

A **skill model** is everything LAS needs for one skill:
- why options and six-month pictures;
- the level-check questions;
- a ladder with hour ranges;
- the skill graph;
- teaching cards;
- drills, mistakes and proofs, all bound to engine specs;
- warm-ups and safety fields for physical skills.

The schema is in [Skill models](skill-packs.md).

**How the agent builds one**
1. **Classify the evidence:** which engines this skill needs (§2).
2. **Check what's available:** call `get_capabilities` and choose the best available option for each need (§5).
3. **Draft:** a ladder of 5–8 steps with hour ranges (citing sources when the agent can search the web), the skill graph, why options, pictures and level checks.
4. **Fill each step:** a proof bound to an engine spec, drills, mistakes and teaching cards.
5. **Validate:** call `validate_skill_model` and fix every error. It checks everything in [skill models §4](skill-packs.md#4-checks-every-skill-model-must-pass), plus:
   - every proof can be measured by an engine that's available now, or is explicitly labeled self-report;
   - the word budget is respected;
   - physical skills have safety fields.
6. **Store it** as `generated`. Learners see estimates as ranges, and the first weekly review asks whether the ladder feels right.

**Curated packs** are skill models a person has reviewed. When one exists, the agent starts from it and adapts it to the learner. Packs make LAS better; they're never required.

## 7. Physical safety for skills nobody has reviewed

Every generated model for a physical skill must include:
- a warm-up;
- injury questions during onboarding;
- intensity caps for beginners;
- stop criteria;
- "see a professional" triggers.

**Supervised-only activities.** LAS teaches the theory but won't coach or assess the practice, and says so. This covers:
- breath-holding and anything underwater;
- rope systems and belaying;
- heavy lifting with a maximal load;
- full-contact sparring;
- firearms;
- vehicles and aircraft;
- anything where a mistake can kill.

## 8. Coverage targets

LAS is general if it handles these with no curated pack. Each target is a test scenario (§9).

| Skill | Engines | What's hard |
|---|---|---|
| Salsa or a hip-hop routine | movement + beat + reference | Needs a reference clip for shape. Spins blur at 30 fps |
| Strength workout (squat, push-up) | movement (reps) | Side view only. The load isn't visible |
| Yoga flow | movement (holds) | Floor poses hide limbs from the camera |
| Running form | movement + sensor | Needs a treadmill side view, or the phone in a pocket for cadence |
| Golf or tennis swing | movement + objects + sensor | Needs 60 fps or more. Hard to see the club or racket |
| Bouldering | movement | Depth from one camera |
| Juggling | movement + objects | Tracking balls at speed |
| Piano | audio (score) + hands | Many notes at once |
| Singing | audio (melody) | Harmony and timbre are only partly measurable |
| Drums | audio (onsets) against a pattern | Separating cymbals from drums |
| Japanese, Mandarin, Spanish | speech + knowledge | Per-sound models vary by language. Tones via pitch contour |
| Sign language (ASL) | movement (hands) + reference | Comparing handshapes is possible; understanding signs isn't |
| Public speaking | speech + movement + visual | "Engaging" is a rubric judgment |
| Rust, Go, Java, C, SQL, JavaScript, Python | code | Toolchain present, or container, or browser |
| Chess | game + knowledge | Needs an external engine installed |
| Drawing, calligraphy | visual | Subjective. Backed by measurements where possible |
| Cooking | visual + timers + self-report | Taste can't be measured |
| Typing | interaction | — |

## 9. Keeping quality up without per-skill code

- **Engine regression tests:** fixtures per engine, not per skill. Synthetic pose sequences, synthesized audio, code fixtures for each runner. These check that measurements stay correct.
- **Agent evals** (`evals/`): scenario prompts for the coverage targets in §8. They check that the agent:
  - calls `get_capabilities`;
  - produces a skill model that passes validation;
  - picks the right engines and falls back correctly when one is missing;
  - stays within the word budget;
  - never grades raw media itself.
  
  Run them with at least one fully open stack (open client + open model) and one frontier model.
- **In use:** confidence floors, disputes, and the weekly review question "does the ladder feel right?". Any of these can flag a generated model for review. Reviewed models become curated packs.

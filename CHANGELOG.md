# Changelog

## 0.1.0 — 2026-10-13

The first release. Everything is general: no code for any particular skill and no fixed visual style. It all runs on the learner's own computer.

### Agent skill and MCP server
- `learn-any-skill` skill: the flow for a new skill (look, capabilities, skill model, onboarding, sessions, follow-up), eleven rules (visuals first, never grade raw recordings, one fix at a time, no silent plan changes, pain means stop, say when a check is weaker, supervised-only activities), a routing table with a fallback for every need, and reference pages for skill models, spec languages and themes.
- MCP server with 39 tools in eight groups: `skill`, `theme`, `onboard`, `plan`, `teach`, `practice`, `evaluate` (including `submit_rubric_grade`) and `track`.
- Resources for the profile, route, progress, mistakes and skill model; prompts `/las-start`, `/las-session`, `/las-weekly-review` and `/las-stuck`.
- Results render as MCP Apps widgets where the client supports them, and carry a studio link where it does not.
- `get_capabilities` reports engines and their models, browser runtimes, local toolchains, a container runtime, devices, external tools on `PATH` (Stockfish, Lc0, KataGo, GNU Go, ffmpeg, mkcert, whisper.cpp, espeak-ng, Ollama) and local vision models.

### Skill models
- The agent writes a skill model for any skill: why options, six-month pictures, level checks, a 5 to 8 step ladder with hour ranges, a skill graph, lessons, drills, mistakes, proofs bound to engine specs, and safety fields for physical skills.
- `validate_skill_model` checks the schema, word budgets, spec languages, the skill graph, that every proof can be measured by an engine available now (or is labeled self-report), and safety fields; it stores the model when it passes. `las-agents model validate <file.json>` runs the same checks offline.
- Spec languages with a small sandboxed expression language: metric, rubric, test, audio, speech, items, task, sensor, game and self-report specs. Nothing the agent writes runs as code.

### Themes
- The learner brings a design prompt, a description, a screenshot or a tokens file; `draft_theme`, `validate_theme`, `preview_theme`, `set_theme` and `get_theme` turn it into a theme. One look for everything, or one per skill.
- Validation checks WCAG AA contrast in every mode, evaluation colors, color-blind-safe chart series, focus rings, touch targets, motion caps and font licenses, and proposes a fix for each failure. A theme that fails is never applied. Fonts are cached locally.
- The base theme is deliberately plain. Component variants come from a fixed menu (card, button, chip, tile, progress, route, meter), so every theme works on every screen.

### Onboarding and the learning loop
- Onboarding with the standard answer types: look, why, six-month picture, level checks, placement with "too easy" and "too hard", time and constraints, milestone suggestions, a feasibility verdict with stepping stones, and a first session.
- A deterministic session planner (route, mastery, due reviews, open mistakes, practice mix, injuries, time and place), Bayesian knowledge tracing for mastery and FSRS for spaced repetition.
- One fix plus one thing done well after every attempt; confidence floor of 0.7; re-record requests instead of guesses; disputes logged.
- Check-ins (session reminders, missed sessions, weekly review, plateau, proof ready, pain follow-up, gone quiet and more) with quiet hours and nudge limits, answered by one tap. Re-plan options are always offered, never applied silently.
- Proof checks with a readiness test and one continuous take. `report_pain`, `log_external`, `revisit_why`, `export_data` and `delete_data`.
- SQLite storage through the built-in `node:sqlite`, with migrations. Media stays under the data folder (`~/.las`).

### Engines
- Movement (MediaPipe landmarks in, joint angles, reps, tempo, symmetry, balance, reference similarity by dynamic time warping, timing on the beat), audio (pitch, onsets, tempo against a score, MIDI, ABC or a recording), speech (transcript, understood words, pace, pauses, fillers, pitch contour for tones), code, visual (rubric grades with a cited region plus measurements), knowledge, interaction, sensor, game (chess rules built in; UCI and GTP adapters for engines the learner installs) and self-report.
- The visual grading flow: `request_capture`, the studio captures the image and measurements, the agent grades with its own vision and calls `submit_rubric_grade`, then `get_analysis`. Text-only agents fall back to a local open vision model, then to measurements plus self-report, marked as reduced precision.
- Engine regression tests on synthetic fixtures with drift guards (`LAS_UPDATE_FIXTURES=1` regenerates on purpose).

### Code runners
- Run tests in 22 languages from one table: in the browser (JavaScript, TypeScript, Python, SQL), with a local toolchain, or in a Podman or Docker container with no network and a read-only mount. The first use of each runner asks the learner.

### Studio
- A Vite + Preact PWA on `127.0.0.1:4711` with every screen drawn from the learner's theme, on-device camera and microphone analysis, a code editor and widgets (see packages/studio).
- Phone pairing with a QR code and HTTPS from mkcert; opt-in Web Push for check-ins; a single-file MCP Apps widget (see packages/studio).

### Command line
- `las-agents setup` detects Claude Code, Claude Desktop, Codex, Cursor, Goose, OpenCode, Continue and Cline, shows a diff of every change, backs up what it touches, asks, then adds the server and (for Claude Code, Codex and Cursor) the skill. `--dry-run`, `--yes`, `--client`, `--no-skill` and `--no-cli` are available.
- `serve`, `doctor`, `studio`, `checkin`, `engines test` and `model validate`.

### Quality gates
- Agent evals in `evals/`: one scenario per row of the coverage table, each run twice (all engines present, and the main engine missing). They check that `get_capabilities` comes first, the model validates, the engines and fallbacks are right, the word budget holds and raw media is never graded.
- `pnpm lint` (ESLint plus a style check that fails on any hard-coded color, font, radius or shadow in component code), `pnpm typecheck`, `pnpm test`, `pnpm test:engines`, `pnpm test:themes` (every screen in seven themes), `pnpm test:evals`, `pnpm test:e2e`, `pnpm run licenses` (open-source policy check) and `pnpm smoke` (MCP Inspector over stdio), all wired into GitHub Actions.

### Not in 0.1
- No curated skill packs; every skill model is written by the agent (v0.3).
- No hosted mode, remote MCP or sync (v0.2).
- Real-agent eval runs and tests with real recordings are manual.
- Per-sound pronunciation scores: no license-clean model ships, so speech uses intelligibility, pitch contour and comparison with the learner's earlier attempts.

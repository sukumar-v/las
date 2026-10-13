# Learn Any Skill (LAS)

LAS is an open-source MCP server, agent skill and local studio that help your AI agent coach you through learning any skill: guitar, bouldering, Spanish, Rust, chess, drawing, a dance. It follows the same pattern as [REA](https://github.com/morluto/rea): LAS adds capabilities and the agent does the reasoning. LAS has no code for any particular skill. For each learner the agent writes two pieces of data that LAS validates and runs, a skill model (ladder, lessons, drills, proofs, bound to general-purpose measurement engines) and a theme. LAS has no fixed look either: you bring a style and every screen follows it. Lessons are visual and interactive, practice is checked against a clear proof, and the follow-up is scheduled until you reach your goal.

Design docs: [docs/DESIGN.md](docs/DESIGN.md), starting with [docs/design/any-skill.md](docs/design/any-skill.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Quick start (about 60 seconds)

```bash
git clone https://github.com/sukumar-v/las && cd las
pnpm install
pnpm build
node packages/cli/bin/las-agents.js setup      # shows every change, backs up, asks, then installs
```

`setup` finds the agents you have, adds the `las` MCP server to each and copies the `learn-any-skill` skill where the agent has a skills folder. `--dry-run` shows the changes and writes nothing. `--yes` approves everything. `--client codex` names one agent. The server entry points at this checkout, so keep the folder where it is. `npx las-agents setup` is the same command once the package is published to npm; it is not published yet.

Restart your agent, then say:

> I want to learn the ukulele.

Optionally paste a look with it: a design prompt, a description ("cozy, like a paper notebook") or a screenshot. `/las-start` is a shortcut for this. Nothing else to configure.

Check what your machine can do with `node packages/cli/bin/las-agents.js doctor`.

## What happens next

The skill ([skill/SKILL.md](skill/SKILL.md)) makes the agent do this on its own the moment you name a skill:

1. **Look.** If you brought one, `draft_theme`, `validate_theme`, `preview_theme`, `set_theme`. Your first question is already in your style.
2. **Capabilities.** `get_capabilities` lists the engines, code runners, devices, external tools and local models that exist on your machine right now.
3. **Skill model.** The agent decides which kinds of evidence your skill needs (movement, audio, speech, code, images, answers, sensors, a game), calls `draft_skill_model`, writes the model and calls `validate_skill_model` until it passes.
4. **Onboarding.** `start_intake`, then one screen at a time: why, what you want to be doing in six months, a few level checks, time, equipment and injuries, your first milestone with a proof.
5. **Sessions.** `get_today`, `next_session`, then lessons, simulations, drills and recordings. Feedback is one fix plus one thing done well, quoted from measurements, never from the agent's impression of a video.
6. **Follow-up.** Check-ins are stored and fire from a scheduler. You choose every plan change (`replan`, `reschedule`); nothing changes silently.

Every tool returns a widget in clients that render MCP Apps, and a studio link otherwise.

## The studio

A small web app on `http://127.0.0.1:4711`, started with the MCP server (or alone with `node packages/cli/bin/las-agents.js studio`). It is a Vite + Preact PWA (see packages/studio).

- **Recording and analysis happen on your device.** Camera and microphone are used in the browser; body tracking, pitch, timing and the rest run there. Video and audio are not uploaded.
- **Phone pairing.** The studio shows a QR code; your phone joins over the local network on HTTPS from [mkcert](https://github.com/FiloSottile/mkcert), with a single-use token that expires after 10 minutes. Use the phone as the camera. mkcert is optional and installed by you.
- **Check-ins.** Opt-in Web Push (on iOS it works after you add the app to the home screen). Or run `node packages/cli/bin/las-agents.js checkin` from cron (`las checkin` when the `las` command is on your PATH): it works out what is due, respecting your quiet hours and nudge limits (1 a day, 4 a week by default), and prints it; Web Push delivery is in the studio (see packages/studio).
- **Widgets.** One single-file MCP Apps widget draws the same screens inside the chat.

Config by environment variable: `LAS_HOME` (data folder, default `~/.las`), `LAS_PORT` (default 4711), `LAS_DB`, `LAS_STUDIO_DIST`. By default the server listens on 127.0.0.1 only; pairing a phone is what opens it to your local network, behind the single-use token and HTTPS (see packages/studio).

## What it can measure

Engines are general-purpose. The agent configures them with specs; no engine knows which skill it measures.

| Engine | Measures | Where it runs |
|---|---|---|
| Movement | Joint angles, speeds, reps, range of motion, symmetry, balance, similarity to a reference clip, timing on the beat | Browser (MediaPipe Pose, Hand, Face, Object) |
| Audio | Notes, pitch error (cents), timing error (ms), tempo, dynamics, against a score, MIDI, ABC or a recording | Browser |
| Speech | Transcript, understood words, pace, pauses, fillers, pitch contour (tones) | Browser (Whisper), or whisper.cpp if installed |
| Code | Tests, errors, run time, lint, in 22 languages | Browser (JavaScript, TypeScript, Python, SQL), local toolchain, or container |
| Visual | Rubric grades with a cited region, plus proportions from tapped points, symmetry, exposure, color, text | The agent's own vision, plus browser measurements |
| Knowledge | Accuracy, response time, spaced repetition (FSRS), mastery | Built in |
| Interaction, sensor | Typing speed and accuracy; cadence, swing tempo, steadiness | Studio; a paired phone for sensors |
| Game | Agreement with the best move, blunders (chess rules built in) | Built in; a UCI or GTP engine if installed |
| Self-report | Minutes, effort, how it felt, pain | Always available, and labeled as the weakest check |

A missing engine never blocks you: the agent falls back, tells you the check is less precise and suggests an install.

### Optional tools you can install

All are separate programs LAS only detects and calls from outside. None is bundled and each has a fallback. Run `doctor` to see which LAS found.

| Tool | Used for | Without it |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Faster, local transcription | Whisper in the browser |
| [Stockfish](https://stockfishchess.org/) (UCI), [KataGo](https://github.com/lightvector/KataGo) (GTP) | Checking chess or go moves against an engine | Tactics quizzes |
| [ffmpeg](https://ffmpeg.org/) | Media conversion (detected by `get_capabilities`) | Formats the browser records |
| [mkcert](https://github.com/FiloSottile/mkcert) | HTTPS for phone pairing | Computer only |
| [Ollama](https://ollama.com/) with a vision model | Grading drawings and photos when the agent's model can't see images | Measurements plus self-report |
| Podman or Docker Engine | Running code in a container | Browser or local toolchain |
| A language toolchain (`rustc`, `go`, `javac`, `gcc`, `python3`, ...) | Running that language's tests locally | Browser (4 languages) or container |

Code runs only after you agree, once per runner. Local runs have time, memory and network limits.

## Choose the look

You can bring any of these, or nothing:

| You bring | The agent |
|---|---|
| A design prompt (from a gallery, or a `DESIGN.md`) | reads palette, type, radii, shadows and motion |
| A description | maps it to tokens and asks one or two visual questions if needed |
| A screenshot | describes it from its own vision (LAS never sees the pixels) |
| A tokens file (W3C JSON, CSS variables, Tailwind) | maps the names onto theme roles |

Then `draft_theme` -> `validate_theme` (contrast, color-blind-safe charts, focus ring, touch targets, motion caps, font licenses) -> `preview_theme` -> `set_theme`. A theme that fails validation is never applied. Give each skill its own look if you like ("make it warmer" is a small edit). The base theme is deliberately plain so it never competes with yours. Details: [docs/design/theming.md](docs/design/theming.md).

## Privacy

- **Local first.** One SQLite file (`~/.las/las.db`) holds your profile, plan and analyses. Recordings stay under `~/.las/media`. Export and delete are tools (`export_data`, `delete_data`) and cover everything, media included.
- **What leaves the device:** no recordings, answers, analyses or profile. LAS only downloads: font files named in your theme (once, cached), browser model files on first use (cached under `~/.las/models`, see packages/studio), and container images if you choose the container runner.
- **What your agent sees:** measurements, never raw video or audio, plus up to 3 annotated key frames. The one exception is a still image you submit for rubric grading (a drawing, a plate), which the agent looks at to grade it.
- Your agent's model provider sees whatever your agent sees. Use an open client and a local model if that matters to you.

## Supported agents

`setup` knows these. For the first three it also installs the skill; for the rest add [skill/](skill/) by hand if the agent supports skills.

| Agent | MCP config it edits | Skill folder |
|---|---|---|
| Claude Code | `claude mcp add --scope user` (or `~/.claude.json`) | `~/.claude/skills/learn-any-skill` |
| Claude Desktop | `claude_desktop_config.json` | none |
| Codex | `$CODEX_HOME/config.toml` (default `~/.codex`) | `$CODEX_HOME/skills/learn-any-skill` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/skills/learn-any-skill` |
| Goose | `~/.config/goose/config.yaml` | none |
| OpenCode | `~/.config/opencode/opencode.json` or `./opencode.json` | none |
| Continue | `~/.continue/config.yaml` or `config.json` | none |
| Cline | VS Code `cline_mcp_settings.json` | none |

## Requirements

- Node.js 22.13 or newer (LAS uses the built-in `node:sqlite`) and pnpm 10.
- Optional: language toolchains and a container runtime for code, mkcert for the phone, the tools above.
- A browser with camera and microphone for recording.

## Repository layout

| Path | What it is |
|---|---|
| `packages/schema` | Skill model, theme, spec languages, analyses, events, with validators |
| `packages/store` | SQLite storage and migrations |
| `packages/server` | MCP server (39 tools, resources, prompts) and the studio's local JSON API |
| `packages/engines`, `packages/runners` | Measurement engines; code runners for 22 languages |
| `packages/ui` | Themeable components and screens |
| `packages/studio` | The PWA and the widget (see packages/studio) |
| `packages/cli` | `las-agents`: setup, serve, doctor, studio, checkin, engines test, model validate |
| `skill/` | The `learn-any-skill` skill and its references |
| `evals/` | Theme fixtures and agent evals |
| `tools/` | License check, style check, ESLint plugin, Inspector smoke test |
| `docs/`, `prototypes/app` | Design, and the clickable prototype |

## Tests

| Command | What it runs |
|---|---|
| `pnpm test` | Every unit project |
| `pnpm test:engines` | Engine and runner regression tests on synthetic fixtures |
| `pnpm test:themes` | Every screen rendered in the base theme and six very different themes |
| `pnpm test:evals` | The agent evals that run offline |
| `pnpm test:e2e` | Studio end-to-end tests in a real browser (Playwright) |
| `pnpm run licenses` | Open-source license check (plain `pnpm licenses` is pnpm's own command) |
| `pnpm smoke` | Starts the server and drives it with the MCP Inspector |
| `pnpm lint`, `pnpm typecheck` | ESLint plus the style check; TypeScript |

## Status

v0.1: everything in [DESIGN §13](docs/DESIGN.md#13-build-plan) for v0.1, running locally. There are no curated packs; every skill model is written by the agent. Real-agent eval runs and real recordings are manual checks, not CI. Hosted mode (remote MCP, sync) is v0.2.

## License

MIT, see [LICENSE](LICENSE). Every dependency must be open source and free for commercial use: [DESIGN §11](docs/DESIGN.md#11-open-source-policy) and the allowlist in `tools/licenses-allowlist.json`.

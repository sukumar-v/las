# Demo: three skills, three looks

`pnpm demo` runs LAS the way an agent does, for three very different skills, each in its own look:

| Skill | Evidence (engines) | Look, as the learner put it |
|---|---|---|
| Salsa (on1) | movement + audio + knowledge | "Like a dance club after midnight", dark with a neon accent |
| Rust | code + knowledge | "Raw concrete brutalism, like a compiler's error page" |
| Drawing | visual + knowledge | "A printed art book", monochrome serif on warm paper |

The script plays the agent. It starts the real LAS server over stdio, with the studio on a local port, and prints every tool call it makes. LAS adds capabilities (validation, measurement, planning, the studio) and the agent does the reasoning (which engines a skill needs, the skill model, the look). LAS has no code for any of the three skills. The skill models are the validated ones the agent evals wrote (`evals/fixtures/models/{salsa-routine,rust,drawing}.json`), and the looks come from three new one-sentence descriptions that land near the eval themes `dark-neon`, `brutalist` and `monochrome-serif`.

## Run it

```bash
pnpm install
pnpm demo                 # keeps the studio up until you press Enter
pnpm demo --no-wait       # exits when done (CI)
```

| Flag | Default | |
|---|---|---|
| `--port <n>` | `$LAS_PORT` or 4711 | Studio port. The demo stops if the port is taken, so it never talks to another LAS. |
| `--home <dir>` | a new temporary folder | `LAS_HOME` for the server. Your `~/.las` is never touched, and the temporary folder is deleted at the end. |
| `--no-wait` | off | Exit when done instead of waiting for Enter. |
| `--skip-build` | off | Don't build the studio when `packages/studio/dist` is missing (the demo builds it with `pnpm --filter @las/studio build` otherwise). |

It takes a few seconds and exits non-zero if any tool call fails.

## What it does for each skill

1. **Look:** `draft_theme` from one sentence, `validate_theme` (with `apply_fixes`), `preview_theme`, then `set_theme` for everything, so onboarding is already in that look.
2. **Capabilities:** `get_capabilities`, and which of the engines the skill needs exist on this machine.
3. **Skill model:** `draft_skill_model` for the skeleton and rules, then `validate_skill_model` with the model the agent wrote.
4. **Onboarding:** `start_intake`, `record_answer` for each screen (why, six-month picture, level checks, time, things to plan around), `place_learner`, `suggest_milestones`, `check_feasibility`, `set_milestone`. Then `set_theme` again with the new enrollment as the scope, so this skill keeps its look when the next skill brings another.
5. **Today:** `get_today` and `next_session`, with the reason for each block.
6. **Links:** Today, the first session, the theme preview and sample screens, all on the studio.

It ends with a table (skill, engines, theme, milestone, studio link).

## What to look at in the studio

- **Three looks.** Open the three Today links side by side. The screens and the components are the same and only the theme changes: neon on near-black with square buttons, thick borders and hard shadows with a red accent, serif type on warm paper with underline buttons.
- **A session.** The Session link walks the planned blocks in that skill's look. Salsa starts with a knee-friendly warm-up, because the learner said "knees" during onboarding.
- **The framing guide.** In the salsa session, the perform block opens the recording screen. The framing guide checks that your body is in frame, the light and that the camera is steady before it lets you record (the camera and the analysis stay in the browser). To see it in each look without a camera, use the Screens link with `screen=recording-movement`.
- **A lesson sim.** `screen=lesson` shows a lesson with a sim: drag the slider and watch the readout. Among the demo's models, drawing's light-and-shadow lesson has a sim of its own.
- **A feedback card.** `screen=feedback` (the Screens link) shows one fix and one thing done well, quoted from the measurements, on a replay. You get a real one after recording a perform block.

The Look and Screens pages use sample data. Today and Session use the learner the demo just onboarded.

## The same flow with a real agent

The demo stands in for the agent. To have your own agent do it:

```bash
npx las-agents setup      # or: pnpm las:setup. Adds the las MCP server and the learn-any-skill skill to your agents
```

Restart Claude Code (or Goose, or another agent `setup` found) and type `/las-start`, or just say "I want to learn salsa. Make it look like a dance club after midnight." The agent runs the same tools and writes its own skill model and theme. In clients that render MCP Apps, each step shows as a widget. Otherwise the tool text carries a studio link. See [skill/SKILL.md](../skill/SKILL.md) for what the agent is told to do.

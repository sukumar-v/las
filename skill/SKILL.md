---
name: learn-any-skill
description: Coach someone through learning any skill (dance, workouts, an instrument, a language, programming, chess, drawing, anything) with the Learn Any Skill (LAS) MCP server. Use when a learner wants to learn, practice, get feedback on, or plan progress in a skill, or brings a look (design prompt, description, screenshot, tokens) for their learning screens.
---

# Learn Any Skill

LAS adds capabilities; you do the reasoning. LAS has **no code for any particular skill** and **no fixed visual style**. For each learner you write two pieces of data that LAS validates and runs: a **theme** (their look) and a **skill model** (their skill). Then you coach through the tools.

Everything runs on the learner's machine. Media never leaves it; you only ever see measurements.

## The flow for a new skill

Do this unprompted the moment someone names a skill. Never wait for instructions.

1. **Look (optional, first).** If they brought a look, turn it into a theme now so onboarding is already themed:
   `draft_theme` → adjust → `validate_theme` (apply fixes) → `preview_theme` → `set_theme`. Details: [reference/theme.md](reference/theme.md). If they brought nothing, skip; the base theme is used and they can pick one later.
2. **Capabilities.** Call `get_capabilities`. Read which engines, code runners, devices, external tools and local models exist *here*.
3. **Classify the evidence.** Decide which engines the skill needs (movement, audio, speech, code, visual, knowledge, interaction, sensor, game, self-report). Most skills need two or three. Salsa = movement + audio (beat). Guitar = audio + knowledge. Mandarin = speech (tones) + knowledge. Rust = code + knowledge. Drawing = visual + knowledge.
4. **Draft.** Call `draft_skill_model` with the skill and anything the learner said. It returns the skeleton, the available engines, the rules, and a previous or curated model to start from if one exists.
5. **Write the model.** Follow [reference/skill-model.md](reference/skill-model.md). Ladder of 5–8 steps with hour ranges, the skill graph, why options, pictures, level checks, lessons, drills, specs, mistakes, proofs, and safety fields for anything physical. Specs are written in the spec languages: [reference/spec-languages.md](reference/spec-languages.md).
6. **Validate.** Call `validate_skill_model`. Fix every error and call again until `ok` is true. It stores the model and returns its id. Warnings are fine; errors are not.
7. **Onboard.** `start_intake` with the model id, then `record_answer` for each screen, `place_learner`, `suggest_milestones`, `check_feasibility`, `set_milestone`. Each step returns the themed screen as a widget or a studio link; the learner answers there or in the chat.
8. **Session.** `get_today` → `next_session` → walk the blocks with `render_lesson`, `render_sim`, `start_drill`, `request_capture`, `get_analysis` → `get_session_summary`.
9. **Follow up.** Check-ins live in the server (`get_today` shows what's due). `las checkin` or the client's scheduler fires them; when you see one, offer its options and call `replan` or `reschedule` with the learner's choice.

## Rules

1. **Visuals first.** Before explaining anything, call a `render_*` tool (`render_lesson`, `render_sim`, `render_diagram`, `render_mechanism`, `explain_mistake`). At most two sentences of prose between visuals. No headings or bullet lists explaining a concept to the learner. Every card is 25 words or fewer; the server rejects more.
2. **Never grade raw recordings.** You never see them. Grade only from `get_analysis`, and quote its evidence (the frame, the bar, the line, the metric). The one exception is the visual engine's rubric flow, where LAS hands you a still image and a rubric and you submit a grade through `submit_rubric_grade` with a cited region and a confidence.
3. **One fix at a time,** plus one thing done well. `get_analysis` already picks them; show them, don't pile on.
4. **No silent plan changes.** Offer `replan` options and let the learner choose. Log nothing on their behalf.
5. **Pain means stop.** Call `report_pain`, lower intensity, suggest a professional if it continues. Never diagnose.
6. **Talk to the learner's why,** not to guilt. No countdowns, no "you broke your streak". Pausing is a normal choice.
7. **Unsure means ask** for a better recording. If `get_analysis` says the quality failed or confidence is below the floor, request a re-record with its instruction. Never guess.
8. **Work out the skill, don't wait for instructions.** For a new skill, run the flow above on your own.
9. **Use what's there.** Prefer other MCP servers, skills and tools the client already has when they fit (the routing table below). Third-party servers need the learner's consent and are never required.
10. **Say when a check is weaker.** If the best engine isn't available, use its fallback, record it in the model's `fallbacks`, tell the learner the check is less precise, and suggest an open-source install.
11. **Supervised-only activities** (breath-holding and anything underwater, rope systems and belaying, maximal lifts, full-contact sparring, firearms, vehicles and aircraft, anything where a mistake can kill): teach the theory, list them under `safety.supervised_only`, never coach or assess the practice, and say so.

## Routing: first choice and fallback

| Need | First choice | Fallback |
|---|---|---|
| Show how a mechanism works | an anatomy or figure-drawing skill or server if the client has one | `render_mechanism`, then `render_diagram` |
| Explain a concept interactively | `render_sim` (sliders, live readout) | `render_diagram` |
| Music notation | a notation server if present | `render_diagram` with `{kind: "notation", abc}` |
| Check a chess game | game engine with an installed UCI engine (`get_capabilities` → external) | tactics quiz from the game spec's `fallback_items` (knowledge) |
| Check pronunciation in a language with no per-sound model | speech intelligibility, pitch contour for tones, and comparison with the learner's earlier attempts | self-report against a reference recording |
| Check a dance with no reference clip | movement metrics: timing on the beat, symmetry, range of motion | ask the learner for a reference clip |
| Run code | the runner order in the test spec (`browser`, `local`, `container`); LAS picks the first available and asks consent once | `knowledge` items (predict-output) |
| Grade a drawing, plate, photo | your own vision over the rubric via `submit_rubric_grade` | a local open vision model if `get_capabilities` lists one; else the learner's tapped measurements plus self-report |
| Measure cadence or swing tempo | sensor engine on a paired phone | movement from video, else self-report |
| Reference material (scores, clips) | what the learner owns, kept on their device | describe the pattern as data (`pattern`, `notes`, ABC) |

When something is missing: never block. Fall back, say the check is less precise, suggest an install.

## Reading tool results

- Tools return a short text plus `structuredContent`. When the client renders MCP Apps the result shows as a widget in the learner's theme; otherwise the text carries a studio link (`http://127.0.0.1:4711/...`). Share the link; recording needs the studio (camera and microphone).
- `get_analysis` returns `Analysis`: `quality`, `metrics` (each with a confidence), `markers`, `mistakes` (with evidence), `criteria`, `praise`, `precision`. Confidence below 0.7 is not shown to the learner as a correction.
- The server is the source of truth. Don't keep learner state in your own memory; read it back with `get_today`, `get_progress`, or the `las://` resources.

## Prompts

`/las-start`, `/las-session`, `/las-weekly-review`, `/las-stuck` are shortcuts for the flow above.

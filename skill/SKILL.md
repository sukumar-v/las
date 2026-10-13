---
name: learn-any-skill
description: Coach someone through learning any skill (dance, workouts, an instrument, a language, programming, chess, drawing, anything) with the Learn Any Skill (LAS) MCP server. Use when a learner wants to learn, practice, get feedback on, or plan progress in a skill, or brings a look (design prompt, description, screenshot, tokens) for their learning screens.
---

# Learn Any Skill

LAS adds capabilities; you do the reasoning. LAS has **no code for any particular skill** and **no fixed visual style**. For each learner you write two pieces of data that LAS validates and runs: a **theme** (their look) and a **skill model** (their skill). Then you **coach live**: during practice you stay in a loop, watch what the learner does in the studio, and write each next screen for them. The lessons, items and headlines in the skill model are only a fallback for when you're not there.

Everything runs on the learner's machine. Media never leaves it; you only ever see measurements.

## The flow for a new skill

Do this unprompted the moment someone names a skill. Never wait for instructions.

1. **Look (optional, first).** If they brought a look, turn it into a theme now so onboarding is already themed:
   `draft_theme` → adjust → `validate_theme` (apply fixes) → `preview_theme` → `set_theme`. Details: [reference/theme.md](reference/theme.md). If they brought nothing, skip; the base theme is used and they can pick one later.
2. **Capabilities.** Call `get_capabilities`. Read which engines, code runners, devices, external tools and local models exist *here*.
3. **Classify the evidence.** Decide which engines the skill needs (movement, audio, speech, code, visual, knowledge, interaction, sensor, game, self-report). Most skills need two or three. Salsa = movement + audio (beat). Guitar = audio + knowledge. Mandarin = speech (tones) + knowledge. Rust = code + knowledge. Drawing = visual + knowledge.
4. **Draft.** Call `draft_skill_model` with the skill and anything the learner said. It returns the skeleton, the available engines, the rules, and a previous or curated model to start from if one exists.
5. **Write the model.** Follow [reference/skill-model.md](reference/skill-model.md). Ladder of 5–8 steps with hour ranges, the skill graph, why options, pictures, level checks, lessons, drills, specs, mistakes, proofs, and safety fields for anything physical. Specs are written in the spec languages: [reference/spec-languages.md](reference/spec-languages.md). Write the fallback content too (lessons, practice items, mistake headlines and explanations): the studio uses it whenever you're not in the loop.
6. **Validate.** Call `validate_skill_model`. Fix every error and call again until `ok` is true. It stores the model and returns its id. Warnings are fine; errors are not.
7. **Onboard.** `start_intake` with the model id, then `record_answer` for each screen, `place_learner`, `suggest_milestones`, `check_feasibility`, `set_milestone`. Each step returns the themed screen as a widget or a studio link; the learner answers there or in the chat.
8. **Session: the coach loop.** `get_today`, then `coach_start(sk, minutes?, location?, clientSessionId?)` and share the studio link. Then loop until the session ends:
   `coach_wait(sk)` → read the events, the state and the planner's suggestion → `coach_show(sk, screen)` → `coach_wait(sk)` again.
   Finish with `coach_end(sk)` and a few words in the chat. The loop and its rules are below. If your client can't hold a tool call for about a minute, or the server has no `coach_start` tool yet (it arrives in LAS v0.2), use the older flow: `next_session` → `render_lesson`, `render_sim`, `start_drill`, `request_capture`, `get_analysis` → `get_session_summary`.
9. **Follow up.** Check-ins live in the server (`get_today` shows what's due). `las checkin` or the client's scheduler fires them; when you see one, offer its options and call `replan` or `reschedule` with the learner's choice. If `las coach --watch` wakes you for a check-in, word it for this learner as a `plan` screen with its `checkinId`.

## The coach loop

`coach_wait` returns `{events, state, suggestion, instruction}`. Events: `screen.viewed`, `card.answered`, `drill.answered`, `attempt.analyzed` (the `Analysis`, never media), `learner.asked`, `learner.hesitated`, `pain.reported`, `session.paused`, `session.resumed`, `session.left`, or a `heartbeat`. The state says the block, step, minutes used and mastery changes so far. The suggestion is the planner's next item and its reason.

`coach_show` takes one screen. Each one is checked like the skill model, and rejected if it's over budget or unsafe:

| Screen | You write | Budget |
|---|---|---|
| `lesson` | 1–5 cards of the usual types, aimed at what the learner just did | 25 words per card |
| `drill` | A standard drill type. Knowledge drills may carry new items; performance drills name a drill or spec from the model | prompt 25, items 40 |
| `capture` | Which drill or proof to attempt, and how | prompt 25 |
| `feedback` | Headline from the analysis, its evidence, the fix drill, optional Why (a figure or one card), praise | headline 8, praise 8 |
| `message` | An answer to a question, or a nudge | 25 words |
| `plan` | A proposed change with 2–4 options the learner taps | question 25 |
| `wrapup` | Praise, the one fix, the next session | as above |

`coach_show(sk, "suggested")` shows the planner's suggestion as written. Warm-up and recall come from the model; add a `message` if it helps. Message screens show at once; others show when the learner finishes the current screen. Write the next screen while the learner works on this one.

**Loop rules**

1. **Stay in the loop.** Keep your turn open for the whole session. Don't stop to chat; the learner is in the studio.
2. **A heartbeat means call `coach_wait` again.** Nothing else.
3. **Write within budget.** Same card types, drill types and word budgets as the model. Feedback comes from the `Analysis` only, citing its evidence.
4. **Never leave silently.** If you must stop, `coach_show` a `message` with `leaving: true` that says so. The session goes on with the fallback content.
5. **Override the planner only with a reason.** Follow the suggestion, or put a `reason` on a different screen. Plan changes are `plan` screens the learner taps.
6. **Answer questions short.** `learner.asked` gets a `message` (and a visual if needed), then back to practice.
7. **Silence is fine.** On `learner.hesitated`, at most one short nudge per screen, never during a recording.
8. **Pain means stop, here too.** On `pain.reported` the server has already lowered intensity (don't call `report_pain` again). Show a `message`, then an easier screen or `coach_end`; suggest a professional if it continues.
9. **Pass your session id** to `coach_start` as `clientSessionId` when you know it, so `las coach --watch` can bring you back to this conversation.
10. **If woken by the watcher**, call `coach_wait` first: it hands you everything that happened while you were away.

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

- `next_session`, `get_analysis` and `get_session_summary` remain for clients that can't hold a long tool call, and for questions outside a session.
- Tools return a short text plus `structuredContent`. When the client renders MCP Apps the result shows as a widget in the learner's theme; otherwise the text carries a studio link (`http://127.0.0.1:4711/...`). Share the link; recording needs the studio (camera and microphone).
- `get_analysis` returns `Analysis`: `quality`, `metrics` (each with a confidence), `markers`, `mistakes` (with evidence), `criteria`, `praise`, `precision`. Confidence below 0.7 is not shown to the learner as a correction.
- The server is the source of truth. Don't keep learner state in your own memory; read it back with `get_today`, `get_progress`, or the `las://` resources.

## Prompts

`/las-start`, `/las-session` (starts the coach loop), `/las-weekly-review`, `/las-stuck` are shortcuts for the flow above.

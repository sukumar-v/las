# Agent, coach-loop and theme evals

LAS has no code for any skill. These evals show that the general pieces (MCP tools, validator, spec languages, engines, routing) cover every skill on the coverage list in [any-skill §8](../docs/design/any-skill.md#8-coverage-targets), that the live coach's loop holds for each of those skills, and that learners' looks become valid themes. Everything runs offline, in memory, in a few seconds.

```sh
pnpm vitest run --project evals                       # or: pnpm test:evals
LAS_UPDATE_FIXTURES=1 pnpm vitest run --project evals # accept intended changes to the fixtures
```

## What the agent evals prove

Each file in `scenarios/` is the agent's own work for one coverage target: a skill model written by hand, in the agent's voice, following `skill/SKILL.md` and `skill/reference/skill-model.md`. There are 27: salsa, strength, yoga, running form, golf, bouldering, juggling, piano, singing, drums, Japanese, Mandarin, Spanish, ASL, public speaking, Rust, Go, Java, C, SQL, JavaScript, Python, chess, drawing, calligraphy, cooking, typing.

`src/harness.ts` drives each one through the real MCP server (an in-memory client from `packages/server/test/helpers.ts`), in the order the skill prescribes, and records every tool call:

`get_capabilities` → `draft_skill_model` → the scenario writes the model from the draft and the capabilities it read → `validate_skill_model` (up to three repairs through the scenario's `repair` hook) → `get_skill_model`.

Every scenario runs twice:

- **real**: this machine's capabilities, detected once per run;
- **fallback**: the scenario's main engine is reported missing (`withUnavailable`), the way `get_capabilities` reports it. The model must record what replaces it, following the routing table: movement, audio, speech, visual and interaction → self-report; sensor → movement; code → knowledge predict-output items; game → knowledge tactics quiz (and the game spec keeps `fallback_items`); speech → self-report against a reference recording; visual → self-report with a photo plus tapped measurements.

The model must carry full **fallback content** (lesson cards, drill prompts and items, mistake headlines and explanations) even though the schema makes those fields optional from v0.2: the live coach writes screens on top of the scaffold, and the fallback is what the studio shows when no coach is present ([skill models §3.1](../docs/design/skill-packs.md#31-scaffold-and-fallback-content)). A model with gaps passes validation with warnings, and fails the evals.

The checks (all in `src/harness.ts`, each returns a list of problems):

| Check | Holds when |
|---|---|
| `calledCapabilitiesFirst` | `get_capabilities` came before drafting and before any validation |
| `enginesMatch` | the engines from the §8 row are in the model, each used through a spec of its kind, and nothing unexpected is listed |
| `fallbacksUsed` | every proof on a missing engine names an available fallback (with a spec of the right kind), `fallbacks` records exactly the missing engines, and each follows the routing table with its details |
| `wordBudgetHeld` | cards ≤ 25 words, headlines ≤ 8, probes, drill prompts, proof labels and rubric levels ≤ 25, ladder labels ≤ 10, item prompts ≤ 40 |
| `noRawMediaGrading` | no call carries media bytes; the only grading tool is `submit_rubric_grade`, with a region on every grade and no media path; every proof and performance drill is bound to a spec of its engine; no rubric is safety-critical |
| `predictFirst` | every lesson opens with a prediction |
| `stepHoursAreRanges` | 5–8 steps, step 0 is `[0, 0]`, every later step a real range |
| `physicalSafetyPresent` | physical skills have a warm-up, injury questions and rules, beginner caps, stop criteria (pain among them) and see-a-professional triggers |
| `supervisedOnlyFlagged` | `safety.supervised_only` lists exactly what §7 requires (only the strength workout's maximal lifts here) and no drill, proof or mistake touches it |
| `metricNamesExist` | names the validator parses but never checks (proof checks, drill success, detectors, key metrics, spec pass and when, placement rules) are metrics the bound spec really produces |
| `crossRefsConsistent` | spec mistakes point at real fix drills, each mistake is listed by a node and its fix drill, focus categories and equipment line up, pictures use distinct steps |

In fallback mode the test also checks that the server reported the engine missing, and that `validate_skill_model` warned once per affected proof that the check is less precise.

Fixtures, written on the first run and compared structurally afterwards (generated ids, versions and timestamps ignored):

- `fixtures/models/<scenario>.json` and `<scenario>.fallback.json`: the model as stored;
- `fixtures/transcripts/<scenario>.json`: both runs' tool calls, the errors of each validation attempt, the final warnings and the summary.

A drift fails the test unless `LAS_UPDATE_FIXTURES=1`. A summary table (scenario, mode, engines, nodes, cards, words, attempts, ok) prints at the end.

## What the theme evals prove

`test/theme-evals.test.ts` turns each description in `src/theme-descriptions.ts` (our own words, six very different looks) into a theme through `draft_theme` and `validate_theme` (with `apply_fixes` when needed), and checks that:

- each passes and equals its fixture in `fixtures/themes/` (ignoring `id`), with `source.kind` `"description"`;
- every pair differs in at least three of: modes, accent (color distance over 100), display font, card, button, motion, texture;
- no fixture names a prompt gallery, and the only URLs anywhere are font sources on an open font host;
- an edit ("make it warmer" with a stored theme as `base`) still validates and changes only a few color tokens.

`LAS_UPDATE_FIXTURES=1` regenerates the theme fixtures with `pnpm --filter @las/evals themes` first. One test is marked `it.fails`: a dark-only theme comes back from `validate_theme` with the base theme's `dark` overrides; flip it to `it` once that's fixed.

## Coach-loop evals

`test/coach-evals.test.ts` runs the live coach's loop ([live-coach §16](../docs/design/live-coach.md#16-testing)) against every scenario's stored model, with no model in the loop and no real time. Each scenario's `fixtures/models/<id>.json` is stored through `validate_skill_model` and enrolled through the intake (the quick milestone, with the model's equipment as the learner's access). `src/coach-harness.ts` holds the rig, the scripts and the checks.

- **The scripted learner** acts only through the studio's HTTP API. It opens the live session (`GET /api/live/:id`) and views each screen (`screen.viewed`, with the time spent on the previous one). It answers predict cards and knowledge items (`POST /api/drill/:id/next`), one wrong and then right. To record a take of a measured drill, it lets the drill route make the attempt, then posts a synthetic `Analysis` for the attempt's engine to `POST /api/attempt/:id/analysis`. The analysis has the spec's own metric names, one mistake from the model, a marker, and bait the server must strip: a key frame as a data URL and an overlay naming a media ref. It never posts media. The learner also asks a question, hesitates, reports pain, pauses and resumes, taps a plan option and finishes the wrap-up.
- **The scripted coach** uses only `coach_start`, `coach_wait`, `coach_show` and `coach_end`, over an in-memory MCP client. Every policy answers a question with a short `message` that replies to the question's event.
- **A fake clock** (`setDirectorClock`) makes the 60 s presence window, the 8 s deadline, the 300 ms batch window and the 45 s wait cost a millisecond each. A policy moves the clock on itself, for the quitter's absence or a pause.

Each scenario runs five live sessions, one per policy, in this order. The essayist comes last because pain lowers intensity for 7 days.

| Policy | The coach |
|---|---|
| `follow` | Shows `"suggested"` whenever nothing is queued and makes one quiet wait (a heartbeat). The learner asks, hesitates and finishes the wrap-up |
| `override` | Writes its own lesson on a node the suggestion doesn't cover, its own knowledge drill (the model's predict cards as items), feedback from the `attempt.analyzed` it gets, a plan screen (add an hour a week, or keep) and its own wrap-up. Every override carries a reason |
| `quitter` | Coaches the first screen (`quitter(n)`), takes one more batch and stops calling. The clock runs 61 s while the learner carries on with the fallback and asks a question. The quitter comes back with `ack` set to the last event it handled |
| `leaver` | Coaches the first screen, then sends a `message` with `leaving: true`. The learner finishes on the fallback |
| `essayist` | Tries an essay card, an unknown card type, a made-up metric spec, a 40-word message, feedback on a quality-failed analysis and feedback citing a mistake the analysis doesn't have. Then the learner reports pain (level 4) and the coach tries the hardest drill above the new cap. Last, pause and resume |

The checks (each returns a list of problems):

| Check | Holds when |
|---|---|
| `loopCompleted` | Every policy's session ran from `coach_start` to `coach_end`, which returned that session's summary, and the session is ended |
| `screensFromCoachWhilePresent` | Every screen the studio got (`coach.screen`) came from an accepted `coach_show` (`source: "coach"`), or from the fallback while the coach was away. The exceptions are the director's own warm-up, recall and pause, and the wrap-up `coach_end` shows when the coach didn't |
| `showsValidated` | Every `coach_show` returned `{ok, errors}`, and accepted screens are stored as coach screens. Each of the essayist's screens is refused with an error at its path (`cards[0]`, `cards[0].type`, `spec`, `text`, `attemptId`, `evidence.mistakeId`, `drillId`). None stored a row, sent the studio a screen or message, or changed the queued screen |
| `overridesLogged` | Each override is in the planner log with `by: "coach"`, its reason and what was suggested |
| `eventsDelivered` | Each wait returns, in id order, exactly the stored events not yet acknowledged (by `ack`, else by the previous batch), up to at least what was pending when it began. The quitter's lost batch comes again, with everything that happened while it was away |
| `noRawMedia` | No event carries a `mediaRef`, a data URL or an `overlay` |
| `waitResultsSmall` | Every `coach_wait` result (`structuredContent.data`) is under 4 KB of JSON. The table reports the max, and the max with the widget's theme added |
| `questionsAnswered` | Each `learner.asked` text reaches the coach word for word, including one asked while the coach was away. The reply shows at once: `status: "shown"`, a `coach.message` during the call, and the studio draws it |
| `painLowersCap` | `pain.reported` carries the cap the server applied, which is lower than before, the state has it, and the coach's next drill above it is refused at `drillId` |
| `planChoiceLogged` | The tapped plan option returns a change and is logged as the plan change `coach-plan:<screenId>`, and the coach hears `plan.chosen` |
| `leaverHandsOver` | The leaving message sets coach-away (`coachPresent: false`, `leftOnPurpose`) at once. The next screens come from the fallback with no waiting, and the session reaches its end |
| `heartbeatOnQuiet` | A wait with nothing pending returns `heartbeat: true` with no events and "call coach_wait again", once the fake clock has passed the timeout |

Some checks can't apply to a model, and the table's n/a column says which. No drill is above the lowered cap in the non-physical models or ASL, since all their drills are intensity 1. Chess has no drill an engine measures, so its essayist has no attempt to give feedback on. A separate test injects faults into a recorded run (media in an event, an oversize result, a skipped event, a refused screen that leaked, a fallback screen while the coach was present, a lost question) and checks that each one is flagged.

**Two checks came from bugs these evals found** (both fixed in the director): a `coach_wait` made after the session ended now delivers what was still pending (the wrap-up's `screen.viewed`, a last question), and a screen the coach queued before leaving is dropped, so the fallback takes over at once. `eventsLostAfterEnd` and `queuedShownAfterLeaving` in `CoachRun` keep watching for them.

**Adding a policy.**

1. Write it in `src/coach-harness.ts` as `async (r: CoachRig) => { ... }`. Start with `r.start("<name>")` and add the name to `PolicyName`. Drive the learner with `r.view`, `r.act`, `r.advance`, `r.ask`, `r.hesitate`, `r.pain`, `r.event` and `r.recordTake`, and the coach with `r.wait`, `r.show`, `r.followTurn` and `r.answerQuestions`. Finish with `r.drain()` and `r.end()`. The coach talks only through the coach tools and the learner only through the HTTP API.
2. Mark screens that must be refused with `{ expect: { what, path, message } }`, and overrides with `{ override: { reason, suggested } }`. Record anything a new check needs in `CoachRun`.
3. Add the policy to `POLICIES`, before the essayist unless it reports pain. If it proves something new, add a check to `COACH_CHECKS` and `coachChecks`. Every scenario then runs it.
4. Keep it light: all 27 scenarios with 5 sessions each run in about 15 seconds.

**Running.**

```sh
pnpm -s test:evals                                                      # every eval
pnpm vitest run --project evals evals/test/coach-evals.test.ts          # the coach loop only
pnpm vitest run --project evals evals/test/coach-evals.test.ts -t chess # one scenario
```

Add `--reporter=verbose` to see the summary table: time, sessions, waits, shows accepted and refused, events, studio screens from the coach and the fallback, the largest wait result (with and without the theme), and what didn't apply. A new scenario is picked up once its model fixture exists, so run the agent evals first.

## Adding a scenario

1. Write `scenarios/<id>.ts` exporting a `Scenario`: the learner's words (`skill`, `notes`), the expectation from §8 (`engines`, the `main` engine and its routing `fallback`, `physical`, `supervisedOnly`) and `build(draft, caps)` returning the model. Write it as the agent would: short learner-facing text, hour ranges, sources stated plainly in `notes`, no citations you can't back. Record fallbacks with `recordFallbacks(draft, {...})` so the model reacts to what `get_capabilities` reported.
2. Add it to `scenarios/index.ts` and to the coverage list in `test/agent-evals.test.ts` if it's a new §8 row.
3. Run the evals. If the validator rejects the first draft, either fix the model or, when the slip is the kind an agent makes, keep the draft and add a `repair` hook so the transcript shows the round trip (see `scenarios/rust.ts`).
4. Commit the new fixtures.

Keep scenarios independent: helpers for repetitive structures inside a file are fine; a shared model factory is not, because it would make the evals prove nothing about generality.

## Running with a real agent (manual)

The automated evals stand in for the agent. The design asks for runs with at least one fully open stack (an open client with an open-weights model) and one frontier model; that is a manual check:

1. Install LAS into the client: `las setup --client claude-code` (or `--client goose` for the open stack).
2. Start a fresh conversation and run `/las-start` with a skill from the list, e.g. "I want to learn bouldering". Don't help the agent.
3. When it has stored the model, ask it to call `get_skill_model` and save the result to a file, then validate it and run the model checks:

   ```sh
   las model validate /path/to/model.json
   pnpm --filter @las/evals exec tsx src/check-model.ts /path/to/model.json bouldering
   ```

4. From the client's tool log, confirm by hand what needs the transcript: `get_capabilities` came first, a missing engine led to a recorded fallback, and the agent never asked to see raw video or audio (grades came only from `get_analysis` or `submit_rubric_grade` with a region).
5. Note the model, client, date and result in the pull request that changes the skill or the server.

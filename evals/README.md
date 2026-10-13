# Agent and theme evals

LAS has no code for any skill. These evals show that the general pieces (MCP tools, validator, spec languages, engines, routing) cover every skill on the coverage list in [any-skill §8](../docs/design/any-skill.md#8-coverage-targets), and that learners' looks become valid themes. Everything runs offline, in memory, in a few seconds.

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

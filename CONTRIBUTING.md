# Contributing to Learn Any Skill

Thanks for helping. LAS is small on purpose: it gives an agent general-purpose capabilities and never contains logic for one skill. Read [CLAUDE.md](CLAUDE.md) (the project rules) and [docs/design/any-skill.md](docs/design/any-skill.md) first. This page is the practical part.

## Set up

You need Node.js 22.13 or newer (LAS uses the built-in `node:sqlite`) and pnpm 10 (`corepack enable` picks the version from `package.json`).

```bash
git clone https://github.com/sukumar-v/las && cd las
pnpm install
pnpm build
pnpm test                 # everything that runs without a browser or an agent
```

Try your changes in a real agent: `node packages/cli/bin/las-agents.js setup --dry-run`, then without `--dry-run`. In a checkout the server entry points at `packages/server/src/bin.ts` through `tsx`, so edits take effect on the agent's next start. `pnpm --filter @las/server dev` runs the server on stdio by hand, and `pnpm smoke` drives it with the MCP Inspector. `node packages/cli/bin/las-agents.js doctor` shows what your machine supports.

Before you push, run what CI runs: `pnpm lint && pnpm typecheck && pnpm test && pnpm run licenses` (also available as `pnpm run ci`), plus `pnpm test:engines`, `pnpm test:themes`, `pnpm test:evals` and `pnpm smoke`. CI is [.github/workflows/ci.yml](.github/workflows/ci.yml): a `verify` job with those steps and a studio build, then an `e2e` job.

## Map of the repository

| Path | Package | What goes here | Depends on |
|---|---|---|---|
| `packages/schema` | `@las/schema` | Zod schemas and validators: skill model, theme, spec languages, expression language, analyses, events | zod |
| `packages/store` | `@las/store` | SQLite through `node:sqlite`, migrations in `src/migrations.ts` | schema |
| `packages/engines` | `@las/engines` | One folder per engine; `types.ts` has the evidence shapes; `node.ts` has the process adapters (UCI, GTP, whisper.cpp) | schema, chess.js, pitchy |
| `packages/runners` | `@las/runners` | Code runners; `languages.ts` is the table for every language | schema |
| `packages/server` | `@las/server` | MCP tools (`src/mcp/tools`), the loop (`src/core`), the studio's JSON API (`src/http`) | the four above, MCP SDK, ts-fsrs |
| `packages/ui` | `@las/ui` | Themeable components, screens and the theme-to-CSS generator | schema, preact |
| `packages/studio` | `@las/studio` | The PWA and the widget (see packages/studio) | schema, ui, engines, runners |
| `packages/cli` | `las-agents` | `setup`, `serve`, `doctor`, `studio`, `checkin`, `engines test`, `model validate` | server, schema |
| `skill/` | | The `learn-any-skill` skill and its references | |
| `evals/` | `@las/evals` | Theme fixtures and agent evals | |
| `tools/` | | License check, style check, ESLint plugin, Inspector smoke test | |
| `docs/` | | Design docs; `prototypes/app/index.html` is the clickable prototype | |

## Tests

| Command | Runs | Notes |
|---|---|---|
| `pnpm test` | Every vitest project | The default check |
| `pnpm test:engines` | `engines` and `runners` projects | Same as `las-agents engines test`. Local-runner tests skip a language whose toolchain is missing, and say so in the test name |
| `pnpm test:themes` | The `ui` project | Renders every screen in the base theme and every theme in `evals/fixtures/themes` |
| `pnpm test:evals` | The `evals` project | Offline agent evals |
| `pnpm test:e2e` | Playwright, `packages/studio/playwright.config.ts` | Needs `pnpm --filter @las/studio build` and `npx playwright install chromium` first |
| `pnpm run licenses` | `tools/check-licenses.mjs` | Use `run`: plain `pnpm licenses` is pnpm's own command |
| `pnpm smoke` | `tools/smoke-inspector.mjs` | Starts the server and calls `tools/list`, `resources/list`, `prompts/list` and `get_capabilities` |
| `pnpm lint` | ESLint, then `tools/check-style.mjs` | |

Two things stay manual: runs with a real agent, and tests with real recordings. Everything in CI uses synthetic fixtures.

## The three hard rules, and how CI enforces them

### 1. Open source only

Every dependency must be open source and free for anyone to use, including commercially (the table is in [DESIGN §11](docs/DESIGN.md#11-open-source-policy)). `tools/check-licenses.mjs` lists every installed package with `pnpm licenses list`, compares each license with [tools/licenses-allowlist.json](tools/licenses-allowlist.json) and fails the build on anything else. It also fails if a workspace package does not declare `"license": "MIT"`. MPL-2.0 is allowed with care and printed as a warning. The result on the current tree:

```
License check: 335 packages from pnpm licenses list
warn  lightningcss@1.33.0: MPL-2.0 (allowed with care: use unmodified or publish changes)
warn  lightningcss-linux-x64-gnu@1.33.0: MPL-2.0 (allowed with care: use unmodified or publish changes)
warn  lightningcss-linux-x64-musl@1.33.0: MPL-2.0 (allowed with care: use unmodified or publish changes)
warn  pyodide@314.0.7: MPL-2.0 (allowed with care: use unmodified or publish changes)
warn  web-push@3.6.7: MPL-2.0 (allowed with care: use unmodified or publish changes)
OK
```

When you add a dependency: check its license (and its model weights' license separately), run the check, and add a row to [DESIGN §11.1](docs/DESIGN.md#111-chosen-components) in the same commit. A new license type needs a design-doc update, not just an allowlist edit. `exceptions` in the allowlist is for an accepted exception with a written reason, never for silencing a real violation. GPL tools (Stockfish, espeak-ng, ffmpeg builds) are allowed only as programs the learner installs, started as a separate process over a standard protocol, with a fallback when absent. Never bundle or link them. If a package you need pulls in something that is not allowed but is never loaded on the path you use, remove it with `overrides` in `pnpm-workspace.yaml` and say why in a comment there (as is done for `sharp`, an LGPL binary that `@huggingface/transformers` lists for Node only).

### 2. No fixed design language

Every color, font, radius, shadow, motion value and figure style comes from the learner's theme. Two checks enforce it over `packages/ui/src` and `packages/studio/src`:

- the ESLint rule `las/no-hardcoded-style` ([tools/eslint-plugin-las](tools/eslint-plugin-las/index.js)) fails on a literal color, font family or name, radius, shadow or pixel font size in `.ts` and `.tsx`;
- `tools/check-style.mjs` fails on the same in `.css` files. A line that is structural and not a style choice can carry the comment `las-style-allow`; use it rarely and say why. The token-to-CSS generator (`packages/ui/src/theme/css.ts`) is the only place token values become CSS.

How to write component CSS: reference tokens and select variants with data attributes, nothing else.

```css
.las-card {
  background: var(--las-color-surface);
  border: var(--las-border-width) var(--las-border-style) var(--las-color-line);
  border-radius: var(--las-radius-lg);
  padding: var(--las-pad);
  box-shadow: var(--las-shadow-card);
  font-family: var(--las-font-body);
  transition: transform var(--las-motion-duration) var(--las-motion-easing);
}
[data-card="raised"] .las-card { border-color: transparent; box-shadow: var(--las-shadow-raised); }
[data-card="glass"]  .las-card { background: color-mix(in srgb, var(--las-color-surface) 65%, transparent); }
```

Tokens: `--las-color-<role>` (`bg surface ink muted line accent on-accent good warn bad focus`, `--las-color-data-0..7`), `--las-font-display|body|mono`, `--las-text-0..5`, `--las-space-0..5`, `--las-radius-sm|md|lg|pill`, `--las-border-width|style`, `--las-shadow-card|raised`, `--las-motion-duration|easing`, `--las-overlay-good|attention|reference|neutral`, `--las-tap`. To add a component variant: add it to `COMPONENT_VARIANTS` in `packages/schema/src/theme/schema.ts`, write its `[data-...]` rule in `packages/ui/src/styles/base.css`, and update [docs/design/theming.md](docs/design/theming.md). The snapshot test renders every screen in seven themes, so a variant that breaks layout or accessibility fails there.

### 3. General first

- Never write `if (skill === ...)`, never branch on a skill's name, and never add per-skill code or per-skill copy. Per-skill content is a skill model: data the agent writes at runtime and `validate_skill_model` checks.
- Engines do not know which skill they measure; the spec says what to measure and what counts as a mistake. Runners do not branch on a language name; they read `LANGUAGE_TABLE`.
- Tests are per engine, with synthetic fixtures (generated poses, synthesized audio, code fixtures per runner), never per skill. Use a skill name only as a worked example in a test fixture or doc.
- Every skill goes through the same screens and the standard answer types ([DESIGN §5.2](docs/DESIGN.md#52-one-screen-every-skill)).

## Add an engine

An engine measures one kind of evidence. Most new needs are better met by a new spec on an existing engine; add an engine only when the evidence is new.

1. **Schema.** Add the id to `ENGINE_IDS`, and its entry to `ENGINES` and `SPEC_KIND_FOR_ENGINE`, in `packages/schema/src/engines.ts`.
2. **Spec language.** Write the spec schema in `packages/schema/src/specs/<kind>.ts` plus a static check (`checkXSpec`), add it to `EngineSpecSchema` and `ENGINE_FOR_SPEC_KIND`, and call the check from `checkSpec` in `specs/index.ts`. Spec tests go in `packages/schema/test/specs.test.ts`.
3. **Evidence.** Add the evidence shape to `packages/engines/src/types.ts` and to the `Evidence` union. Engines only measure evidence the studio or an adapter hands them.
4. **Analyzer.** Add `packages/engines/src/<engine>/index.ts` returning an `Analysis` (use `finish`, `metric`, `evalCriteria` from `common/analysis.ts`; apply the 0.7 confidence floor; stamp `version`). Export it from `src/index.ts`.
5. **Dispatch.** Add a `case` for the spec kind in `packages/engines/src/dispatch.ts`. Anything that needs a child process or the file system goes in `node.ts`, never in the browser-safe entry.
6. **Status.** Add its entry to `detectCapabilities` in `packages/server/src/core/capabilities.ts` so `get_capabilities` reports it, with any model licenses.
7. **Tests.** Add `packages/engines/test/<engine>.test.ts` with synthetic fixtures whose true values you know, and a drift test (see `movement-drift.test.ts`, `sensor-drift.test.ts`, `audio.drift.test.ts`) that compares fixed synthetic input with `packages/engines/test/fixtures/<engine>/expected.json`. Generate or update the expected file on purpose with `LAS_UPDATE_FIXTURES=1 pnpm vitest run --project engines test/<your drift test>.ts`, then review the diff: it must only move for a reason you can explain.
8. **Docs.** Update the engine table in [any-skill §2](docs/design/any-skill.md#2-engines), [DESIGN §8](docs/DESIGN.md#8-engines), [skill/reference/spec-languages.md](skill/reference/spec-languages.md), and record any new dependency ([DESIGN §11.1](docs/DESIGN.md#111-chosen-components)).

## Add a code runner language

1. Add the language id to `LANGUAGES` in `packages/schema/src/specs/test.ts`.
2. Add its row to `LANGUAGE_TABLE` in `packages/runners/src/languages.ts`: extensions, how a value is printed, the generated test harness (it must follow the `##LAS##` contract at the top of that file), toolchains with their build and run commands, native test and lint commands, a container image (an official image where one exists), and a `browser` runtime if a license-clean one exists.
3. Add the toolchain to `TOOLCHAINS` in `packages/server/src/core/capabilities.ts` so `get_capabilities` detects it.
4. Add a sample to `SAMPLES` in `packages/runners/test/harness.test.ts` (it is typed by `Language`, so the compiler tells you).
5. Add a fixture folder `packages/runners/test/fixtures/<language>/` with the entry file and a `spec.json` of six tests in this order: two passing calls, one passing hidden call, a deliberate failure, a call that raises an error, one stdin/stdout test, and a `spin` call that never returns. `local.test.ts` picks the folder up on its own and skips it when the toolchain is not installed.

## Add a theme fixture

Add `{ id, name, description }` to `evals/src/theme-descriptions.ts`, then run `pnpm --filter @las/evals themes`. It drafts the theme with `draftTheme`, runs `validateTheme` and writes `evals/fixtures/themes/<id>.json`. The `ui` snapshot test loads every file in that folder, so the new theme is exercised on every screen automatically. Pick a look that stresses something the others don't (a wide type scale, a hard shadow, very low motion).

## Add an agent eval scenario

Agent evals check that the LAS skill's flow works for a skill nobody wrote code for. They live in `evals/` (see evals/): `scenarios/<id>.ts` (listed in `scenarios/index.ts`), the harness in `src/harness.ts`, and the test in `test/agent-evals.test.ts`. There is one scenario for each row of the coverage table in [any-skill §8](docs/design/any-skill.md#8-coverage-targets).

A scenario is data in the agent's voice: what the learner typed, which engines the coverage table names, which engine goes missing in the fallback run and what the routing table says to use instead, and a `build` function that returns the skill model the agent would write from `draft_skill_model` and `get_capabilities` (plus an optional `repair` for what `validate_skill_model` rejects). The harness drives it through the real MCP tools in the order the skill prescribes, once with the real capabilities and once with the main engine marked unavailable, and checks that:

- `get_capabilities` is called first;
- the model passes `validate_skill_model` within a few repairs;
- the engines match the coverage table and the fallbacks are recorded and reported as less precise;
- the word budget holds;
- raw media is never graded (only `get_analysis`, or `submit_rubric_grade` for images the learner submitted);
- physical skills carry safety fields and supervised-only activities are flagged.

Scenario data belongs in `evals/` only; it is test input, never product code. Committed copies of each run's model and tool-call transcript live in `evals/fixtures/`; regenerate them on purpose with `LAS_UPDATE_FIXTURES=1 pnpm test:evals` and review the diff. `pnpm test:evals` is offline. Runs against a real agent and model are manual: run at least one fully open stack (an open client with an open model) and one frontier model, and note which you used.

## Add an agent to `las-agents setup`

Add a `ClientDef` to `CLIENTS` in `packages/cli/src/clients.ts`: an id and name, the files or commands that show it is installed (`signals`, `commands`), its MCP config files in order of preference (`configs`), the skills folder if it has one (`skillDir`), its own CLI if it can register a server (`cli`), and the restart message. If its config is shaped in a way no existing `ConfigFormat` handles, add a format and its merge logic to `packages/cli/src/configs.ts`. Setup must show a diff, back up before writing, and never lose the file's other settings. Add cases to `packages/cli/test/clients.test.ts` and `configs.test.ts`, update the table in the [README](README.md#supported-agents), and add the id to the help text in `packages/cli/src/index.ts`.

## Commits and pull requests

- Write a short imperative subject and a plain-language body.
- **No attribution trailers.** No `Co-Authored-By: Claude` and no `Claude-Session:` line in commit messages.
- Keep a change focused, with tests. A bug fix includes a test that failed before.

## Proposing a design change

The design docs are the contract, so change them in the same commit as the code: [docs/DESIGN.md](docs/DESIGN.md) and the page under `docs/design/` that the change touches, and the skill ([skill/SKILL.md](skill/SKILL.md)) if the agent's behavior changes. Tool names, paths and commands in the docs must exist in the code. A change to the principles in [DESIGN §1](docs/DESIGN.md#1-principles) needs a discussion first: open an issue that says what should change and what it costs, and wait for agreement before writing the patch. The clickable prototype shows flows, not a visual style; don't treat its look as a requirement.

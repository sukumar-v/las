/**
 * LAS demo: three very different skills in three very different looks, driven through the real MCP server.
 *
 * The script plays the agent. It starts the LAS server over stdio (the studio starts with it on --port), then for
 * salsa, Rust and drawing it does what the learn-any-skill skill tells an agent to do: turn a one-sentence look into a
 * theme, read the capabilities, write and validate a skill model, onboard a learner, and plan the first session.
 * Every tool call is printed as it is made, so you can see where LAS adds a capability and where the agent reasons.
 *
 * The skill models are the validated ones the agent evals wrote (evals/fixtures/models). Nothing in LAS knows these
 * three skills: the same tools and screens run all of them, from data.
 *
 *   pnpm demo [--port 4711] [--home <dir>] [--no-wait] [--skip-build]
 *
 * Exits non-zero when any tool call fails.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO_DIST = join(ROOT, "packages/studio/dist");
const SERVER_BIN = join(ROOT, "packages/server/src/bin.ts");
const started = Date.now();

// ---------------------------------------------------------------------------------------------------------------
// The three learners. This is data, like everything per-skill in LAS: one flow below runs all three.

interface DemoSkill {
  /** evals/fixtures/models/<fixture>.json: a skill model the agent wrote and validate_skill_model accepted */
  fixture: string;
  /** what the learner said, which becomes the model's `skill` */
  skill: string;
  notes: string;
  /** the look the learner brought, in one sentence; `like` is the eval theme fixture it should land near */
  look: { name: string; description: string; like: string };
  /** why the agent picked these engines, in a few words */
  evidence: string;
  /** the learner's onboarding answers */
  answers: {
    why: string[];
    picture: string;
    probes: Record<string, unknown>;
    /** how many level-check quiz questions this learner gets right before missing */
    quizRight: number;
    time: { minutes: number; deadline: "none" | "4w" | "3m" | "6m" };
    around: { access: string[]; injuries: string[] };
  };
}

const SKILLS: DemoSkill[] = [
  {
    fixture: "salsa-routine",
    skill: "salsa (on1), to dance at socials",
    notes: "Took one class. Wants to dance at the Friday social night without counting out loud.",
    look: { name: "Club Night", description: "Like a dance club after midnight: dark, black background, one glowing neon accent, square buttons and snappy transitions.", like: "dark-neon" },
    evidence: "body movement on the beat",
    answers: {
      why: ["social", "fun"],
      picture: "social-night",
      probes: { level: 1, known: ["basic"] },
      quizRight: 2,
      time: { minutes: 150, deadline: "none" },
      around: { access: ["A clear floor", "A phone to film with", "Headphones or a speaker"], injuries: ["Knees"] }
    }
  },
  {
    fixture: "rust",
    skill: "Rust",
    notes: "Writes Python at work. Wants to build small, fast command-line tools.",
    look: { name: "Rebar", description: "Raw concrete brutalism, like a compiler's error page: zero rounding, thick black borders, hard offset shadows, mono headings and a single red accent.", like: "brutalist" },
    evidence: "code that passes tests",
    answers: {
      why: ["tools", "oss"],
      picture: "cli",
      probes: { langs: ["python"] },
      quizRight: 2,
      time: { minutes: 240, deadline: "3m" },
      around: { access: ["A computer", "Rust toolchain or a container"], injuries: [] }
    }
  },
  {
    fixture: "drawing",
    skill: "drawing what I see",
    notes: "Doodles in meetings. Wants calm evenings drawing still lifes at home.",
    look: { name: "Inkwell", description: "A printed art book: monochrome editorial serif type, black ink on warm cream paper, flat cards, underline buttons and a timeline route.", like: "monochrome-serif" },
    evidence: "drawings graded against a rubric",
    answers: {
      why: ["relax", "sketch"],
      picture: "objects",
      probes: { level: 2 },
      quizRight: 0,
      time: { minutes: 120, deadline: "none" },
      around: { access: ["A sketchbook", "Pencils", "A phone camera"], injuries: [] }
    }
  }
];

// ---------------------------------------------------------------------------------------------------------------
// Flags

interface Flags {
  port: number;
  home?: string;
  wait: boolean;
  build: boolean;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { port: Number(process.env.LAS_PORT ?? 4711), wait: true, build: true };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split("=", 2) as [string, string | undefined];
    const value = () => inline ?? argv[++i] ?? die(`${k} needs a value`);
    if (k === "--") continue;
    else if (k === "--port") f.port = Number(value());
    else if (k === "--home") f.home = resolve(value());
    else if (k === "--no-wait") f.wait = false;
    else if (k === "--skip-build") f.build = false;
    else if (k === "--help" || k === "-h") {
      console.log("pnpm demo [--port 4711] [--home <dir>] [--no-wait] [--skip-build]\n\n  --port        studio port (default $LAS_PORT or 4711)\n  --home        LAS data folder (default: a new temporary folder; ~/.las is never touched)\n  --no-wait     exit when done instead of keeping the studio up until Enter\n  --skip-build  don't build the studio when packages/studio/dist is missing");
      process.exit(0);
    } else die(`unknown flag ${k} (try --help)`);
  }
  if (!Number.isInteger(f.port) || f.port <= 0 || f.port > 65535) die(`--port must be a port number, got ${f.port}`);
  return f;
}

// ---------------------------------------------------------------------------------------------------------------
// Output

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = sgr("1");
const dim = sgr("2");
const WIDTH = 116;

function die(msg: string): never {
  console.error(`\ndemo failed: ${msg}`);
  process.exit(1);
}

function clip(s: string, n = WIDTH - 8): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Word-wraps a line under an indent; continuation lines get two more spaces. */
function wrap(s: string, indent: number): string {
  const width = WIDTH - indent;
  const out: string[] = [];
  let line = "";
  for (const word of s.replace(/\n/g, " ").split(/(?<=\S) (?=\S)/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = "  " + word;
    } else line = line ? `${line} ${word}` : word;
  }
  out.push(line);
  return out.map((l) => " ".repeat(indent) + l).join("\n");
}

let stepNo = 0;
function step(title: string, why: string) {
  stepNo++;
  console.log(`\n${bold(`${String(stepNo).padStart(2)}. ${title}`)}`);
  console.log(wrap(why, 4));
}
const say = (line: string) => console.log(wrap(line, 6));
const section = (title: string) => console.log(`\n${bold("=".repeat(4) + " " + title + " " + "=".repeat(Math.max(4, WIDTH - title.length - 6)))}`);

/** A one-line rendering of tool arguments: long strings are clipped, models and themes are named, not dumped. */
function argsLine(args: Record<string, unknown>): string {
  const show = (k: string, v: unknown): string => {
    if (k === "model" && v && typeof v === "object") {
      const m = v as { name?: string; ladder?: unknown[]; nodes?: unknown[]; drills?: unknown[] };
      return `<skill model "${m.name}": ${m.ladder?.length} ladder steps, ${m.nodes?.length} nodes, ${m.drills?.length} drills>`;
    }
    if (k === "theme" && v && typeof v === "object") return `<theme "${(v as { name?: string }).name}">`;
    if (typeof v === "string") return JSON.stringify(v.length > 48 ? v.slice(0, 47) + "…" : v);
    return JSON.stringify(v);
  };
  return Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${show(k, v)}`)
    .join(", ");
}

// ---------------------------------------------------------------------------------------------------------------
// The MCP client

interface Result {
  text: string;
  data: any;
}

let client: Client | undefined;
let serverLog = "";
let toolCalls = 0;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  console.log(dim(`    $ ${clip(`${name}({ ${argsLine(args)} })`, WIDTH - 6)}`));
  toolCalls++;
  const r = (await client!.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  if (r.isError) {
    console.error(`\n${name} failed:\n${text.split("\n").slice(0, 20).map((l) => "  " + l).join("\n")}`);
    throw new Error(`${name} returned an error`);
  }
  return { text, data: r.structuredContent ?? {} };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The flow

interface Row {
  skill: string;
  engines: string;
  theme: string;
  milestone: string;
  today: string;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const tempHome = !flags.home;
  const home = flags.home ?? mkdtempSync(join(tmpdir(), "las-demo-"));
  const studio = `http://127.0.0.1:${flags.port}`;
  const link = (path: string) => `${studio}${path}`;

  console.log(bold("Learn Any Skill: three skills, three looks"));
  console.log(`LAS adds capabilities; the agent reasons. This script plays the agent, so every tool call below is one an agent makes.`);
  console.log(`LAS_HOME ${home}${tempHome ? " (temporary; your ~/.las is not touched)" : ""}`);

  const cleanup = async () => {
    await client?.close().catch(() => undefined);
    if (tempHome) rmSync(home, { recursive: true, force: true });
  };
  process.once("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    // 1. Server and studio --------------------------------------------------------------------------------------
    step("Start LAS", "One process: the MCP server on stdio and the studio (a local PWA) on the port. Agents talk to the first; learners click into the second.");
    if (!existsSync(join(STUDIO_DIST, "index.html"))) {
      if (!flags.build) die("the studio isn't built (packages/studio/dist is missing); drop --skip-build or run: pnpm --filter @las/studio build");
      console.log(dim("    $ pnpm --filter @las/studio build"));
      const b = spawnSync("pnpm", ["--filter", "@las/studio", "build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
      if (b.status !== 0) die("the studio build failed");
    } else say(`studio already built (${relative(ROOT, STUDIO_DIST)})`);
    if (!(await portFree(flags.port))) die(`port ${flags.port} is in use (another LAS?). Pass another one, e.g. pnpm demo --port ${flags.port + 1}`);

    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    delete env.LAS_DB; // the database lives in LAS_HOME, never in the learner's real one
    Object.assign(env, { LAS_HOME: home, LAS_PORT: String(flags.port) });
    console.log(dim(`    $ LAS_HOME=${home} LAS_PORT=${flags.port} node --import tsx ${relative(ROOT, SERVER_BIN)}`));
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", tsx, SERVER_BIN], env, cwd: ROOT, stderr: "pipe" });
    transport.stderr?.on("data", (b: Buffer) => (serverLog += b.toString()));
    // a plain client: no MCP Apps widgets, so every tool result carries a studio link in its text
    client = new Client({ name: "las-demo", version: "0.1.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    if (/studio not started/.test(serverLog)) die(`the studio didn't start: ${serverLog.trim().split("\n").pop()}`);
    const health = (await fetch(link("/api/health")).then((r) => r.json())) as { ok?: boolean; studio?: boolean };
    if (!health.ok) die("the studio didn't answer /api/health");
    say(`MCP server up with ${tools.length} tools; studio at ${studio}${health.studio ? "" : " (placeholder page: the PWA isn't built)"}`);

    const rows: Row[] = [];
    let caps: any;

    for (const s of SKILLS) {
      const model = JSON.parse(readFileSync(join(ROOT, "evals/fixtures/models", `${s.fixture}.json`), "utf8"));
      model.skill = s.skill;
      section(`${model.name}: "${s.skill}"`);

      // (a) the look ----------------------------------------------------------------------------------------------
      step(`${model.name}: the look`, `The learner says: "${s.look.description}" The agent turns it into a theme first, so onboarding is already in their style.`);
      const draft = await call("draft_theme", { description: s.look.description, name: s.look.name });
      say(`read as: ${draft.data.notes.join("; ")}`);
      const t = draft.data.theme;
      say(`draft: ${t.modes.join("+")} · bg ${t.tokens.color.bg} · accent ${t.tokens.color.accent} · display ${t.tokens.type.display.family} · button ${t.components.button} · card ${t.components.card} · radius ${t.tokens.radius.lg}px`);
      const fixture = JSON.parse(readFileSync(join(ROOT, "evals/fixtures/themes", `${s.look.like}.json`), "utf8"));
      const traits: [string, (x: any) => unknown][] = [["modes", (x) => x.modes.join("+")], ["accent", (x) => x.tokens.color.accent], ["display font", (x) => x.tokens.type.display.family], ["button", (x) => x.components.button], ["card", (x) => x.components.card], ["radius", (x) => x.tokens.radius.lg]];
      const same = traits.filter(([, get]) => get(t) === get(fixture)).map(([n]) => n);
      say(`agent's check: lands on the same look as the eval theme "${s.look.like}" in ${same.length}/${traits.length} traits (${same.join(", ")})`);

      const v = await call("validate_theme", { theme: t, apply_fixes: true });
      const themeId: string = v.data.themeId;
      say(v.data.fixes?.length ? `passes after ${v.data.fixes.length} fix(es) (${v.data.fixes.map((f: any) => f.path).join(", ")}); stored as ${themeId}` : `passes contrast, color-blind-safe charts, focus, touch targets, motion and font licenses; stored as ${themeId}`);
      const p = await call("preview_theme", { theme: themeId, screen: "all" });
      say(`preview: ${p.data.studioLink}`);
      const set = await call("set_theme", { themeId, scope: "all" });
      const fontNote = (set.data.fonts ?? []).filter((f: any) => f.error).map((f: any) => f.family);
      say(`applied to everything for now${fontNote.length ? ` (fonts ${[...new Set(fontNote)].join(", ")} not downloaded here; their fallback stacks are used)` : ""}`);

      // (b) capabilities ------------------------------------------------------------------------------------------
      step(`${model.name}: what can LAS measure here?`, `The agent classifies the evidence (${s.evidence}) and checks which engines exist on this machine.`);
      caps = (await call("get_capabilities", {})).data.data;
      const here = new Map<string, any>(caps.engines.map((e: any) => [e.id, e]));
      const needs = model.engines as string[];
      say(`needs: ${needs.map((id) => `${id} ${here.get(id)?.available ? "(here)" : `(missing: ${here.get(id)?.reason ?? "unknown"})`}`).join(", ")}`);
      say(`also here: ${caps.engines.filter((e: any) => e.available && !needs.includes(e.id)).map((e: any) => e.id).join(", ") || "nothing else"}`);

      // (c) the skill model ---------------------------------------------------------------------------------------
      step(`${model.name}: the skill model`, "LAS has no code for this skill. The agent asks for the skeleton and rules, writes the model as data, and LAS validates it.");
      const d = await call("draft_skill_model", { skill: s.skill, notes: s.notes });
      say(`skeleton with ${d.data.rules.length} rules; engines available ${d.data.availableEngines.length}, unavailable ${d.data.unavailableEngines.length}; ${d.data.startFrom ? `start from ${d.data.startFrom.kind} ${d.data.startFrom.id}` : "no pack or previous model to start from"}`);
      say(`agent writes: ${model.ladder.length}-step ladder (${model.ladder.at(-1).label}), ${model.nodes.length} skill-graph nodes, ${model.lessons.length} lessons, ${model.drills.length} drills, ${Object.keys(model.specs).length} specs`);
      const vm = await call("validate_skill_model", { model });
      const skillModelId: string = vm.data.stored.id;
      say(`ok: stored as ${skillModelId}${vm.data.warnings.length ? `, ${vm.data.warnings.length} warning(s): ${vm.data.warnings.map((w: any) => w.message).join("; ")}` : ", no warnings"}`);

      // (d) onboarding ----------------------------------------------------------------------------------------------
      step(`${model.name}: onboarding`, "One screen at a time, each already in the learner's look. The demo answers as the learner would; the options come back ranked.");
      const intake = await call("start_intake", { skillModelId });
      const intakeId: string = intake.data.data.intakeId;
      let view = intake.data.data;
      const answer = async (field: string, value: unknown) => (view = (await call("record_answer", { intakeId, field, value })).data.data);
      for (let guard = 0; guard < 24 && view.step !== "milestone" && view.step !== "plan"; guard++) {
        const before = `${view.step}:${view.field}:${view.payload?.item?.id ?? ""}`;
        switch (view.step) {
          case "look":
            await answer("look", "plain");
            break;
          case "why":
            say(`"${view.question}" -> ${s.answers.why.join(" + ")}`);
            await answer("why", s.answers.why);
            break;
          case "picture":
            say(`"${view.question}" -> ${s.answers.picture} (ranked: ${view.options.map((o: any) => o.value + (o.badge ? "*" : "")).join(", ")})`);
            await answer("picture", s.answers.picture);
            break;
          case "probe": {
            const field: string = view.field;
            if (view.answerType === "quiz") {
              const item = view.payload?.item;
              const spec = model.specs[view.payload.spec];
              const full = spec?.items?.find((x: any) => x.id === item?.id);
              const right = (view.payload.quiz?.correct ?? 0) < s.answers.quizRight && (view.payload.quiz?.answered ?? 0) === (view.payload.quiz?.correct ?? 0);
              const value = !full ? null : { itemId: full.id, answer: quizAnswer(full, right) };
              say(`level check "${item?.prompt ?? view.question}" -> ${right ? "right" : "a miss"}`);
              await answer(field, value);
            } else if (view.answerType === "record" || view.answerType === "code") {
              say(`"${view.question}" -> skipped (it needs the studio's ${view.answerType === "code" ? "editor" : "camera"}; ${view.payload.studioPath})`);
              await answer(field, null);
            } else {
              const value = s.answers.probes[field] ?? (view.answerType === "multi" ? [] : view.options?.[0]?.value);
              say(`"${view.question}" -> ${JSON.stringify(value)}`);
              await answer(field, value);
            }
            break;
          }
          case "place": {
            const pl = (await call("place_learner", { intakeId })).data.data;
            say(`start at step ${pl.step} "${model.ladder[pl.step].label}" because: ${pl.evidence.join("; ") || "no evidence yet"}`);
            await answer("place", "ok");
            break;
          }
          case "time":
            say(`"${view.question}" -> ${s.answers.time.minutes} min a week, deadline ${s.answers.time.deadline}`);
            await answer("time", s.answers.time);
            break;
          case "around":
            say(`"${view.question}" -> ${s.answers.around.access.length} things at hand${s.answers.around.injuries.length ? `, plan around: ${s.answers.around.injuries.join(", ")}` : ""}`);
            await answer("around", s.answers.around);
            break;
          default:
            die(`onboarding reached a step the demo doesn't know: ${view.step}`);
        }
        if (`${view.step}:${view.field}:${view.payload?.item?.id ?? ""}` === before && view.step !== "probe") die(`onboarding is stuck on ${before}`);
      }
      if (view.step !== "milestone") die(`onboarding never reached the milestone screen (at ${view.step})`);

      const sug = await call("suggest_milestones", { intakeId });
      const suggestions: any[] = sug.data.data.suggestions;
      for (const x of suggestions) say(`${x.kindLabel}: "${x.title}" (~${x.weeks} wk, ${x.feasibility.label})`);
      const toward = suggestions.find((x) => x.kind === "picture") ?? suggestions[0];
      const feas = (await call("check_feasibility", { intakeId, milestone: `${toward.kind}:${toward.step}` })).data.data;
      say(`${feas.verdict}: about ${feas.weeks} weeks to "${feas.milestone.title}"${feas.steppingStone ? `; closer stepping stone: "${feas.steppingStone.title}" (~${feas.steppingStone.weeks} wk)` : ""}`);
      const pick = feas.steppingStone ? feas.steppingStone.value : `${toward.kind}:${toward.step}`;
      if (feas.steppingStone) say("the learner takes the stepping stone; the picture stays the direction");
      const ms = (await call("set_milestone", { intakeId, milestone: pick })).data.data;
      const sk: string = ms.sk;
      say(`milestone "${ms.plan.milestone.title}" by ${ms.plan.milestone.targetDate} (${ms.plan.milestone.feasibility}); proof: ${ms.plan.milestone.proof}`);
      say(`practice mix ${ms.plan.mix.map((x: any) => `${x.category} ${x.share}%`).join(", ")}${ms.plan.mixReasons.length ? `, adjusted for ${ms.plan.mixReasons.join("; ")}` : ""}`);

      // the enrollment exists now: give this skill its own look, so the next skill's look doesn't replace it
      await call("set_theme", { themeId, scope: sk });
      say(`"${s.look.name}" now belongs to ${sk}; the next skill can change the default look without touching this one`);

      // (e) today and the session ---------------------------------------------------------------------------------
      step(`${model.name}: today`, "The server holds the plan. The agent reads what to do now and plans the session; every block says why it's there.");
      const today = (await call("get_today", { sk })).data.data;
      say(`${today.state}${today.message ? `: ${today.message.replace(/\.$/, "")}` : ""}; next: ${today.nextSession?.title ?? "none"}; reviews due ${today.reviewsDue.count}`);
      const plan = (await call("next_session", { sk })).data.data;
      say(`${plan.title}, ${plan.minutes} min:`);
      for (const b of plan.blocks.slice(0, 5)) say(`  ${b.kind} ${b.minutes} min: ${b.title} (why: ${b.reason})`);

      // (f) the studio ------------------------------------------------------------------------------------------------
      step(`${model.name}: open it`, "Recording, lessons and feedback live in the studio, in this skill's look.");
      const links = { today: link(`/app/today?sk=${encodeURIComponent(sk)}`), session: link(`/app/session/${encodeURIComponent(plan.sessionId)}`), theme: link(`/theme/${encodeURIComponent(themeId)}`) };
      say(`Today      ${links.today}`);
      say(`Session    ${links.session}`);
      say(`Look       ${links.theme}`);
      say(`Screens    ${link(`/snapshots?theme=${encodeURIComponent(themeId)}&screen=feedback`)} (sample data in this look; also screen=lesson, recording-movement)`);

      rows.push({ skill: model.name, engines: needs.filter((e) => e !== "self-report").join(" + "), theme: `${s.look.name} (${s.look.like})`, milestone: ms.plan.milestone.title, today: links.today });
    }

    // Summary -----------------------------------------------------------------------------------------------------
    section("Summary");
    console.log(table(["skill", "engines", "theme", "milestone", "studio link"], rows.map((r) => [r.skill, r.engines, r.theme, r.milestone, r.today])));
    console.log(`\n${toolCalls} tool calls, ${((Date.now() - started) / 1000).toFixed(1)} s. No line of LAS is specific to salsa, Rust or drawing: the models and looks above are data.`);
    console.log(`Three looks at once: open the three Today links side by side. More in demo/README.md.`);

    if (flags.wait) {
      console.log(bold(`\nThe studio is running at ${studio}. Press Enter to stop it.`));
      await new Promise<void>((done) => {
        const rl = createInterface({ input: process.stdin });
        rl.once("line", () => (rl.close(), done()));
        rl.once("close", () => done());
      });
    }
    await cleanup();
  } catch (e) {
    await cleanup();
    if (serverLog.trim()) console.error(`\nserver log (last lines):\n${serverLog.trim().split("\n").slice(-8).join("\n")}`);
    die((e as Error).message);
  }
}

/** The learner's answer to a level-check item: the model's own answer when they know it, a plausible miss otherwise. */
function quizAnswer(item: any, right: boolean): unknown {
  if (item.type === "order") return right ? item.items : [...item.items].reverse();
  if (Array.isArray(item.options) && typeof item.answer === "number") return right ? item.answer : (item.answer + 1) % item.options.length;
  return right ? item.answer : "not sure";
}

function table(head: string[], cells: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => "| " + c.map((v, i) => v.padEnd(w[i])).join(" | ") + " |";
  return [line(head), "|" + w.map((n) => "-".repeat(n + 2)).join("|") + "|", ...cells.map(line)].join("\n");
}

await main();
process.exit(0);

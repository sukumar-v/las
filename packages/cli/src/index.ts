import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { clientSession } from "./client-session.js";
import { checkin, doctor, enginesTest, modelValidate, serve, studio, type Out } from "./commands.js";
import { makeEnv, type Env } from "./env.js";
import { cliVersion, locateInstall, type InstallInfo } from "./install.js";
import { runSetup, type Io, type SetupOptions } from "./setup.js";

export { CLIENTS, detectClients, findClient, type ClientDef } from "./clients.js";
export { upsertConfig, type ConfigFormat, type ServerEntry } from "./configs.js";
export { unifiedDiff } from "./diff.js";
export { runSetup, hookCommand, type SetupOptions, type SetupResult } from "./setup.js";
export { COACH_ADAPTERS, findAdapter, wakeSummary, type CoachAdapter, type WakeCommand } from "./adapters.js";
export { clientSession, writeClientSession, listClientSessions, type ClientSessionRecord } from "./client-session.js";
export { makeEnv, type Env } from "./env.js";
export { locateInstall, type InstallInfo } from "./install.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `las-agents: set up and run Learn Any Skill

Usage: las-agents <command> [options]

  setup [--yes] [--dry-run] [--client <name>] [--no-skill] [--no-cli]
                          detect your agents, show each change, back up, ask, then install the server and skill
  serve [--no-studio]     run the MCP server on stdio (what agents launch)
  doctor [--json]         show which engines, runners and devices are available
  studio                  start only the local studio
  checkin                 run due check-ins
  coach --watch [--interval <s>] [--no-studio]
                          bring the live coach back when the learner acts and no coach is there; serves the studio
                          while its port is free
  coach --once            one watcher pass, then exit (for cron, like checkin)
  client-session [--client <id>] [--pid <n>]
                          (hook) record the agent's conversation id from SessionStart JSON on stdin; prints nothing
  engines test            run the engine and runner test projects (repository checkout only)
  model validate <file>   validate a skill model (JSON only)

Clients: claude-code, claude-desktop, codex, cursor, goose, opencode, continue, cline
`;

/** Terminal prompts through node:readline; closed input counts as "no". */
export function terminalIo(): Io {
  let rl: ReturnType<typeof createInterface> | undefined;
  let closed = false;
  return {
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
    async ask(q) {
      if (closed) return "";
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      const closing = new Promise<string>((r) =>
        rl!.once("close", () => {
          closed = true;
          r("");
        })
      );
      const answer = await Promise.race([rl.question(q), closing]);
      return answer;
    },
    run(command, args) {
      const r = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
      return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    now: () => new Date()
  };
}

export interface RunDeps {
  io?: Io;
  env?: Env;
  install?: InstallInfo;
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const io = deps.io ?? terminalIo();
  const o: Out = io;
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;
      case "--version":
      case "-v":
        io.out(cliVersion(HERE));
        return 0;
      case "setup": {
        const { values } = parseArgs({
          args: rest,
          options: {
            yes: { type: "boolean", short: "y" },
            "dry-run": { type: "boolean" },
            client: { type: "string", multiple: true },
            "no-skill": { type: "boolean" },
            "no-cli": { type: "boolean" },
            help: { type: "boolean", short: "h" }
          }
        });
        if (values.help) {
          io.out(HELP);
          return 0;
        }
        const opts: SetupOptions = { yes: !!values.yes, dryRun: !!values["dry-run"], clients: values.client ?? [], noSkill: !!values["no-skill"], noCli: !!values["no-cli"] };
        const env = deps.env ?? makeEnv();
        const result = await runSetup(opts, env, deps.install ?? locateInstall(HERE, env.platform), io);
        return result.exitCode;
      }
      case "serve":
        await serve(rest);
        return -1; // the server keeps the process alive; bin.ts must not exit
      case "doctor": {
        const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
        return await doctor(o, !!values.json, deps.env ?? makeEnv());
      }
      case "coach": {
        const { values } = parseArgs({ args: rest, options: { watch: { type: "boolean" }, once: { type: "boolean" }, interval: { type: "string" }, "no-studio": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
        if (values.help || (!values.watch && !values.once)) {
          (values.help ? io.out : io.err)("Usage: las coach --watch [--interval <seconds>] [--no-studio]\n       las coach --once");
          return values.help ? 0 : 2;
        }
        const intervalS = values.interval === undefined ? undefined : Number(values.interval);
        if (intervalS !== undefined && !(intervalS > 0)) {
          io.err("--interval takes a number of seconds");
          return 2;
        }
        const { coachCommand } = await import("./coach.js");
        return await coachCommand({ once: !!values.once, intervalS, studio: !values["no-studio"], log: io.err });
      }
      case "client-session":
        // a hook: stdout would become model context, so nothing is printed there, and it always exits 0
        return await clientSession(rest, { lasHome: (deps.env ?? makeEnv()).lasHome, err: process.env.LAS_DEBUG ? io.err : undefined });
      case "studio":
        return await studio(o);
      case "checkin":
        return await checkin(o);
      case "engines":
        if (rest[0] === "test") return enginesTest(o, rest.slice(1), HERE);
        io.err("Usage: las-agents engines test");
        return 2;
      case "model":
        if (rest[0] === "validate") return await modelValidate(o, rest[1]);
        io.err("Usage: las-agents model validate <file.json>");
        return 2;
      default:
        io.err(`Unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if ((e as any)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (e as any)?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      io.err((e as Error).message);
      return 2;
    }
    io.err(`las-agents: ${(e as Error).message}`);
    return 1;
  }
}

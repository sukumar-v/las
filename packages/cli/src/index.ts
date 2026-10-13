import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkin, doctor, enginesTest, modelValidate, serve, studio, type Out } from "./commands.js";
import { makeEnv, type Env } from "./env.js";
import { cliVersion, locateInstall, type InstallInfo } from "./install.js";
import { runSetup, type Io, type SetupOptions } from "./setup.js";

export { CLIENTS, detectClients, findClient, type ClientDef } from "./clients.js";
export { upsertConfig, type ConfigFormat, type ServerEntry } from "./configs.js";
export { unifiedDiff } from "./diff.js";
export { runSetup, type SetupOptions, type SetupResult } from "./setup.js";
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
        return await doctor(o, !!values.json);
      }
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

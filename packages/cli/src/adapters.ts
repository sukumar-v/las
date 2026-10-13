/**
 * How the watcher (`las coach --watch`, docs/design/live-coach.md §4.1) brings a coach back, one row per client.
 * Client ids match `clients.ts`. Adding a client is one row here, like `clients.ts` and the code runners' language
 * table (`packages/runners/src/languages.ts`).
 *
 * A row either resumes the client's conversation headlessly (`resume` builds the command; the summary goes on stdin,
 * never on the command line, so it doesn't show in the process list) or only notifies the learner.
 *
 * Findings behind the Claude Code row (checked 2026-10-13 against Claude Code 2.1.296 and its docs):
 *
 * 1. `claude -p --resume <id>` keeps the session id and appends to that conversation's transcript; only
 *    `--fork-session` makes a new id ("When resuming, create a new session ID instead of reusing the original",
 *    `claude --help` and https://code.claude.com/docs/en/cli-reference). It is NOT safe while an interactive window
 *    has the same conversation open: "If you resume the same session in two terminals without forking, messages
 *    from both interleave into one transcript" (https://code.claude.com/docs/en/sessions#branch-a-session). It does
 *    not fork on its own, so the watcher's alive-pid rule (notify instead) is what keeps it safe. A *background*
 *    session (`claude --bg`) that is still running is different: with `--output-format json` or piped input Claude
 *    Code "sends nothing and exits with status 1" (same page, "Resume a running background session"); the watcher
 *    treats a non-zero exit as a failed wake. Transcripts live at `~/.claude/projects/<project>/<session-id>.jsonl`,
 *    and `--resume` finds an id in any project on the machine. verified-from-docs; not run here (see 5).
 * 2. SessionStart hook: stdin JSON carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`
 *    (`startup|resume|clear|compact|fork`) (https://code.claude.com/docs/en/hooks#sessionstart). The command runs as
 *    `/bin/sh -c "<command>"` whose parent is the Claude Code process; a script started by that shell sees the
 *    `sh -c` process as its parent. verified-by-running (`claude --init-only --settings <hook>` printed
 *    sh(1840) -> claude(1800)). So `$PPID` written in the command string is expanded by `sh -c` and is Claude Code's
 *    pid; `process.ppid` inside `las-agents client-session` is the `sh -c` process (or npx's), which is why the
 *    subcommand takes `--pid "$PPID"` and also records its own ancestor chain. Plain-text stdout of a SessionStart
 *    hook "is added as context", so the subcommand prints nothing. On Windows the command runs in Git Bash or
 *    PowerShell, where `$PPID` is not the Windows pid, so setup leaves `--pid` out there and the subcommand walks
 *    its ancestors instead (still open: not run on Windows).
 * 3. `MCP_TOOL_TIMEOUT`: milliseconds, default 100000000 (about 28 h); stdio servers have no per-request timer; a
 *    per-server `timeout` in `.mcp.json` overrides it (https://code.claude.com/docs/en/env-vars,
 *    https://code.claude.com/docs/en/mcp). Settings files' `env` block is read directly ("they take effect no matter
 *    how claude was launched"). `MCP_TIMEOUT` is the server *startup* timeout, ms, default 30000. An MCP call still
 *    running after 2 minutes moves to a background task (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, default 120000),
 *    which a 55 s `coach_wait` never reaches. verified-from-docs. Because the env var applies to every MCP server
 *    and the default is already far above 55 s, setup writes 1800000 (30 min) when it is unset or below 120000,
 *    rather than 120000, which would lower the learner's other servers' limit.
 * 4. `--allowedTools` uses permission-rule syntax; `mcp__las` and `mcp__las__*` both match every tool of the `las`
 *    server; an unanchored glob like `mcp__*` is skipped for allow rules
 *    (https://code.claude.com/docs/en/permissions). The flag is variadic in `claude --help`
 *    (`--allowedTools <tools...>`), so it is followed by another flag, never by a positional. verified-from-docs.
 * 5. `--output-format json` includes `session_id` ("structured JSON with result, session ID, and metadata"; the docs'
 *    own example: `claude -p ... --output-format json | jq -r '.session_id'`, https://code.claude.com/docs/en/headless).
 *    Also `is_error`, `result`, `total_cost_usd`. verified-from-docs. Not run here: this container's Claude Code
 *    is itself a live session whose environment carries its own session id, and a test resume could write into it.
 *
 * Other rows: Codex `codex exec resume <SESSION_ID> [PROMPT]` reads the prompt from stdin when PROMPT is `-`
 * (codex-rs/exec/src/cli.rs, read 2026-10-13); `--json` prints JSONL events. OpenCode `opencode run --session <id>
 * [message..]` (packages/web/src/content/docs/cli.mdx); stdin is not documented, so the summary goes on argv (it
 * carries no learner text). Goose `goose run --resume --name <name> --instructions -` reads stdin
 * (documentation/docs/guides/goose-cli-commands.md); `run` has no `--session-id`. None of these limit the resumed
 * agent to LAS tools the way `--allowedTools` does, and session id discovery is still open for all three, so they
 * stay `verified: false`.
 */

export interface WakeCommand {
  command: string;
  args: string[];
  /** written to the child's stdin; the summary goes here, never in `args`, when the client reads stdin */
  stdin?: string;
}

export interface WakeResult {
  /** the conversation id the client reports after the run, when it reports one */
  sessionId?: string;
  isError?: boolean;
}

export type NotifyChannel = "push" | "os" | "none";

export interface CoachAdapter {
  /** a client id from clients.ts */
  id: string;
  name: string;
  /** builds the headless resume command; absent when the client has no headless mode */
  resume?: (sessionId: string, summary: string) => WakeCommand;
  /** reads the client's stdout after a run */
  parseResult?: (stdout: string) => WakeResult;
  /** how to tell the learner when the coach can't be resumed: studio Web Push (falls back to the OS notifier), OS only, or nothing */
  notify: NotifyChannel;
  /** what the notification says; never learner text */
  notifyText: string;
  /** whether the command and session-id capture were checked against the client's docs or by running it */
  verified: boolean;
  /** ⚠ what is still open */
  open?: string;
}

/** Claude Code's `--output-format json` result: one JSON object; tolerate leading noise and JSONL (the last object wins). */
export function parseClaudeJson(stdout: string): WakeResult {
  const text = stdout.trim();
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const c of candidates) {
    const s = c.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as { session_id?: unknown; is_error?: unknown };
      return { sessionId: typeof o.session_id === "string" && o.session_id ? o.session_id : undefined, isError: o.is_error === true };
    } catch {
      /* try the next candidate */
    }
  }
  return {};
}

/** Codex `exec --json` prints JSONL events; the thread id arrives in a `thread.started` event. ⚠ verify the event name. */
function parseCodexJsonl(stdout: string): WakeResult {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const o = JSON.parse(line) as { type?: string; thread_id?: string; session_id?: string };
      const id = o.thread_id ?? o.session_id;
      if (typeof id === "string" && id) return { sessionId: id };
    } catch {
      /* not JSON */
    }
  }
  return {};
}

export const COACH_ADAPTERS: CoachAdapter[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    resume: (sessionId, summary) => ({
      command: "claude",
      // --allowedTools is variadic: keep another flag after its value
      args: ["-p", "--resume", sessionId, "--allowedTools", "mcp__las__*", "--output-format", "json"],
      stdin: summary
    }),
    parseResult: parseClaudeJson,
    notify: "push",
    notifyText: "Your coach is waiting in Claude Code",
    verified: true,
    open: "the resume itself was verified from the docs, not by running it; Windows hook parent walk not run"
  },
  {
    id: "codex",
    name: "Codex",
    resume: (sessionId, summary) => ({ command: "codex", args: ["exec", "--json", "resume", sessionId, "-"], stdin: summary }),
    parseResult: parseCodexJsonl,
    notify: "push",
    notifyText: "Your coach is waiting in Codex",
    verified: false,
    open: "⚠ session id discovery (the agent's clientSessionId, or the newest session file for this folder); no LAS-only tool limit; --json event name for the thread id"
  },
  {
    id: "opencode",
    name: "OpenCode",
    // stdin isn't documented for `opencode run`; the summary carries no learner text, so argv is acceptable here
    resume: (sessionId, summary) => ({ command: "opencode", args: ["run", "--session", sessionId, summary] }),
    notify: "push",
    notifyText: "Your coach is waiting in OpenCode",
    verified: false,
    open: "⚠ session id discovery; whether `run` reads stdin; --format json output shape; no LAS-only tool limit"
  },
  {
    id: "goose",
    name: "Goose",
    // the "session id" Goose resumes by is the session name
    resume: (sessionName, summary) => ({ command: "goose", args: ["run", "--resume", "--name", sessionName, "--instructions", "-"], stdin: summary }),
    notify: "push",
    notifyText: "Your coach is waiting in Goose",
    verified: false,
    open: "⚠ session name discovery; no LAS-only tool limit"
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    notify: "os",
    notifyText: "Your coach is waiting in Claude Desktop: open it and type /las-session",
    verified: false,
    open: "⚠ whether a notification can open Claude Desktop with /las-session prefilled"
  },
  { id: "cursor", name: "Cursor", notify: "os", notifyText: "Your coach is waiting in Cursor: open it and type /las-session", verified: false, open: "⚠ no headless mode known" },
  { id: "continue", name: "Continue", notify: "os", notifyText: "Your coach is waiting in Continue: open it and type /las-session", verified: false, open: "⚠ no headless mode known" },
  { id: "cline", name: "Cline", notify: "os", notifyText: "Your coach is waiting in Cline: open it and type /las-session", verified: false, open: "⚠ no headless mode known" }
];

export function findAdapter(id: string | undefined, table: CoachAdapter[] = COACH_ADAPTERS): CoachAdapter | undefined {
  return id ? table.find((a) => a.id === id) : undefined;
}

/**
 * What a woken coach reads. Names the skill, the session and the event types, and says to call coach_wait.
 * Never the learner's words or any analysis: the coach reads those through coach_wait (live-coach §4, §13).
 */
export function wakeSummary(s: { skill?: string; sk: string; liveSessionId: string; eventTypes: string[] }): string {
  const counts = new Map<string, number>();
  for (const t of s.eventTypes) counts.set(t, (counts.get(t) ?? 0) + 1);
  const types = [...counts].map(([t, n]) => (n > 1 ? `${t} x${n}` : t)).join(", ");
  return [
    `LAS live coach: the learner is practicing${s.skill ? ` ${JSON.stringify(s.skill)}` : ""} (sk ${s.sk}, live session ${s.liveSessionId}) and acted while you were away: ${types || "new events"}.`,
    `Call coach_wait with sk "${s.sk}" now. It returns everything that happened, the state and the planner's suggestion. Then keep the coach loop going (coach_wait, coach_show) until coach_end.`,
    "Use LAS tools only."
  ].join("\n");
}

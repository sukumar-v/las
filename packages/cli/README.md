# las-agents

Sets up Learn Any Skill in your agent and runs it: `npx las-agents setup`. Run `las-agents help` for every command.

## Setup

`las-agents setup [--yes] [--dry-run] [--client <name>] [--no-skill] [--no-cli]` finds your agents. For each change it shows a diff, backs up the file and asks before writing. Clients are listed in `src/clients.ts`, one row each.

For Claude Code it also edits `~/.claude/settings.json` for the live coach, keeping every other key and hook:

```json
{
  "env": { "MCP_TOOL_TIMEOUT": "1800000" },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "las-agents client-session --client claude-code --pid $PPID", "timeout": 10 }] }
    ]
  }
}
```

- `MCP_TOOL_TIMEOUT` is written only when it is unset or below 120000 ms. A larger value is kept.
- The hook records the conversation id, so the watcher can resume that conversation later.
- On Windows the hook has no `--pid`.
- When `las-agents` isn't on PATH, the command starts with `npx -y las-agents`. From a repository checkout it is node plus `packages/cli/bin/las-agents.js`.

Codex and Goose get a per-server tool timeout (`tool_timeout_sec = 300`, `timeout: 300`).

## The live coach watcher

`las coach --watch [--interval <seconds>] [--no-studio]` checks the store every few seconds (3 by default, or the `coach.watchPollS` setting). It looks for live sessions where the learner acted and no coach is present. When it finds one, it brings the coach back through that client's row in `src/adapters.ts`:

- **Claude Code:** `claude -p --resume <id> --allowedTools "mcp__las__*" --output-format json`. The summary goes on stdin. It names the skill, the session and the event types, and never includes the learner's words.
- **While the coach's client is still open, or the client can't be resumed:** it sends a notification instead ("Your coach is waiting in Claude Code"). It tries studio Web Push first, then the OS notifier.
- **Limits:** one wake in flight per session, at most one every 2 minutes, and 5 per session (`coach.wakeMinIntervalS`, `coach.wakeMaxPerSession`).
- **Coach left on purpose:** no wake until the learner asks for the coach.

While the studio port is free, `--watch` also serves the studio. It retries every few seconds when another LAS process holds the port. Log lines go to stderr.

`las coach --once` does one pass and exits, for cron (like `las checkin`):

```cron
* * * * * las coach --once
```

The resumed agent runs detached. Its result is read on the next pass, which stores the new conversation id if it changed.

`las doctor` reports:

- whether `claude` is on PATH;
- the `MCP_TOOL_TIMEOUT` value;
- whether the session hook is installed;
- the client session files under `$LAS_HOME/clients`.

`las-agents client-session` is the hook itself. It reads the SessionStart JSON on stdin and writes `$LAS_HOME/clients/<client>/<pid>.json`. It prints nothing and deletes files older than a day.

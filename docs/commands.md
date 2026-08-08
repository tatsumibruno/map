# Command reference

Every command, flag, and exit code. For a guided walkthrough, start with the
[tutorial in the root README](../README.md).

## Global flags

| Flag | Meaning |
| --- | --- |
| `--project <name>` | operate on a registered project |
| `--path <directory>` | operate on the project rooted here, bypassing the registry |
| `--json` | machine-readable output |
| `-v, --version` | print the version |
| `-h, --help` | help for any command |

These work **before or after** any subcommand — `agentctl --project p agent list`
and `agentctl agent list --project p` are identical.

**How the project is chosen**, in order: `--path`, then `--project`, then the
nearest `.agentctl/` at or above the current directory, then the active project
from `agentctl project use`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | unexpected error (set `AGENTCTL_DEBUG=1` for a stack trace) |
| `2` | validation error — bad flag, unsupported model or effort |
| `3` | not found — unknown project, agent, task, or tmux session |
| `4` | conflict — duplicate id, session in use, runner already running, agent disabled |
| `5` | transport error — tmux failed |
| `6` | `task watch` ended in a non-`completed` state |
| `7` | `task watch` hit its own `--timeout` |
| `8` | `doctor` found a failing check |

---

## project

### `project init <name> [--path <directory>]`

Creates the project and its `.agentctl/` layout, and registers it in the
user-level registry. Defaults to `./<name>`. Fails if the directory already
hosts a project.

### `project list`

Lists registered projects; the active one is marked `*`.

### `project use <name> [--path <directory>]`

Sets the active project. Pass `--path` to register (or re-point) the project's
root first — useful after moving a directory.

### `project context add <file> [--as <name>] [--allow-outside-root]`

Copies a file into `.agentctl/context/`. Sources outside the project root are
refused unless `--allow-outside-root` is given.

### `project context list`

Lists shared context files and their sizes.

### `project model allow <provider> <model>`

Accepts a model id the built-in catalog does not know yet — how you use a model
newer than this release. See [providers.md](./providers.md).

### `project model list [--provider <provider>]`

Shows every model each provider accepts here, its reasoning-effort levels, and
whether it is `built-in` or allowed at the `project` level.

---

## session

### `session list`

Lists running tmux sessions and which agent, if any, is registered to each.
Works without a project selected.

---

## agent

### `agent register <name> …`

Registers an already-authenticated tmux session.

| Flag | Required | Meaning |
| --- | --- | --- |
| `--role coordinator\|agent` | yes | coordinators delegate; agents execute |
| `--provider codex\|claude-code` | yes | which client runs in the session |
| `--model <model>` | yes | provider model id |
| `--tmux <session>` | yes | an existing, authenticated session |
| `--reasoning-effort <level>` | no | only where the provider supports one |
| `--parent <agent>` | for `--role agent` | the owning coordinator |
| `--workdir <directory>` | no | defaults to the project root |
| `--display-name <name>` | no | human-readable label |

Fails clearly when the session does not exist, the provider is invalid, the
model is unsupported, the effort is unsupported for that provider/model, the
session is already attached to an active agent, or the parent is missing, in
another project, or not a coordinator. Cycles are rejected.

### `agent list`

Prints the hierarchy as a tree, with provider, model, effort, session, and
whether each agent is disabled.

### `agent status <agent>`

Registration, tmux session liveness, runner state and heartbeat, runner pid,
current task, children, and the last five messages.

### `agent configure <agent> [--model <m>] [--reasoning-effort <l>] [--clear-reasoning-effort]`

Changes the agent's defaults. **Future tasks only** — the change is recorded as
an event and never rewrites the snapshot on a task already in flight. Validated
through the provider adapter, exactly like registration.

### `agent enable <agent>` / `agent disable <agent>`

A disabled agent receives no new work; its mailbox and history stay readable,
and its tmux session is untouched.

### `agent remove <agent> [--purge-mailbox] [--yes]`

Removes the registration. Refuses while the agent still has children. The
mailbox and history are kept unless `--purge-mailbox` is given. Prompts for
confirmation; `--yes` skips it (required when non-interactive). The tmux session
is never closed.

---

## message

### `message send --from <agent> --to <agent> --type <type> --body <text> [--correlation-id <id>] [--context <ref...>]`

Sends one message. Types: `task`, `result`, `question`, `status`, `error`,
`cancel`, `ack`. Routing is checked against the hierarchy first.

### `message list <agent> [--box inbox|outbox|all] [--limit <n>]`

Shows an agent's traffic, newest last.

---

## task

### `task assign --from <coordinator> --to <agent> <text> …`

Creates a task and delivers it. The sender must be a coordinator and the
recipient must be its direct child and enabled.

| Flag | Meaning |
| --- | --- |
| `--context <ref...>` | context references (defaults to the project's shared context) |
| `--model <model>` | override the model **for this task only** |
| `--reasoning-effort <level>` | override the effort for this task only |
| `--timeout <ms>` | a running coordinator expires the task after this long |
| `--watch` | block until the task reaches a terminal state |

Overrides are validated through the provider adapter and recorded in the task's
execution snapshot.

### `task watch <correlation-id> [--interval <ms>] [--timeout <ms>]`

Follows a task, printing each state change, then the final result or error.
Exits `0` when completed, `6` for any other terminal state, `7` if `--timeout`
elapsed first.

### `task list [--state <state>]`

Every task with its state, participants, and the model and effort it ran with.

### `task cancel <correlation-id>`

Sends a `cancel`. The runner interrupts the session on its next poll.

---

## events

### `events [--follow] [--limit <n>] [--type <prefix>] [--correlation-id <id>]`

Reads the append-only event log. `--type` matches a prefix, so `--type task.`
selects the whole task lifecycle. `--follow` streams new events; `Ctrl-C` stops.

---

## runner

### `runner start <agent> [--poll-interval <ms>] [--response-timeout <ms>] [--force]`

Starts a detached runner for an agent and records its pid and log path.
`--force` replaces a runner that is already running. Defaults: 1500ms poll,
15-minute response timeout.

### `runner stop <agent>`

`SIGTERM`, then `SIGKILL` after 5s. Removes the record and writes a `stopped`
status.

### `runner status [<agent>]`

Pid, whether the process is actually alive, runner state, last heartbeat, and
current task — for one agent or all of them.

---

## coordinator

### `coordinator start [--poll-interval <ms>] [--supervise-children] [--no-enforce-timeouts]`

Runs the coordinator process in the foreground: consolidates child results into
task records, expires timed-out tasks, and — with `--supervise-children` —
starts runners for enabled children that have none.

---

## agent-worker

### `agent-worker start <agent> [--poll-interval <ms>] [--response-timeout <ms>] [--once]`

Runs the worker in the **foreground**. This is what `runner start` spawns
detached, and it is the right entry point inside a container (`--once` runs a
single poll cycle and exits, which is handy for scripting and debugging).

---

## doctor

### `doctor`

Validates Node, tmux, the state directory and its permissions, every
registration and its session, runner liveness, malformed JSON/JSONL, stale
locks, and the user-level registry. Exits `8` if any check fails.

---

## completion

### `completion bash|zsh|fish [--instructions]`

Prints a completion script, or the installation steps for that shell.
Completion covers commands, flags, enumerated values, provider-supported models
and reasoning efforts, project names, agent names, and live tmux sessions.

---

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENTCTL_HOME` | user-level registry location (default `~/.agentctl`) |
| `AGENTCTL_TMUX_BIN` | path to tmux |
| `AGENTCTL_CLI_ENTRY` | entry point re-exec'd for detached runners |
| `AGENTCTL_DEBUG=1` | stack traces instead of one-line errors |
| `NO_COLOR` / `AGENTCTL_NO_COLOR` | disable colour |

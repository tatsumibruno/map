# The filesystem protocol

Everything two agentctl processes say to each other is a file. This document is
the contract: the layout, the formats, the write rules, and the routing policy.

If you only remember one thing: **`.jsonl` files are append-only queues and logs;
`.json` files are current-state views replaced atomically.**

## Layout

```text
my-project/
├── .agentctl/
│   ├── project.json              project metadata + per-project model allow-list
│   ├── context/
│   │   ├── README.md             how to use this directory
│   │   └── shared.md             attached to every dispatch by default
│   ├── agents/
│   │   └── <agent-id>.json       one file per registered agent
│   ├── mailboxes/
│   │   └── <agent-id>/
│   │       ├── inbox.jsonl       append-only: messages addressed to this agent
│   │       ├── outbox.jsonl      append-only: messages this agent sent
│   │       ├── status.json       current runner state (overwritten)
│   │       ├── cursor.json       byte offset consumed from inbox.jsonl
│   │       └── work/
│   │           ├── <task>.envelope.md   instructions handed to the agent
│   │           └── <task>.response.md   the agent's answer
│   ├── tasks/<task-id>.json      task record incl. the execution snapshot
│   ├── runners/<agent-id>.json   pid, log path, poll interval
│   ├── logs/runner-<agent>.log   detached runner stdout/stderr
│   ├── events.jsonl              append-only event log
│   └── locks/                    advisory cross-process locks
└── your-source-code/
```

`tasks/`, `runners/`, `logs/`, and `cursor.json` extend the layout given in the
specification. They are required by it in substance: tasks must record the
configuration they ran with, runners must be supervisable, and a queue needs a
cursor to be resumable.

The user-level registry lives outside the project, at
`~/.agentctl/config.json` (override with `AGENTCTL_HOME`). It holds only the
list of known projects and which one is active — no project state, so deleting
it loses nothing but your shortcuts.

## Write rules

**Atomic replacement for `.json`.** Write to a temp file *in the same
directory*, `fsync`, then `rename`. Same directory matters: `rename` is only
atomic within a filesystem. A reader therefore sees either the old document or
the new one, never a truncated one.

**Locked appends for `.jsonl`.** Appends take a named lock under `locks/` first.
The lock is a directory created with `mkdir`, which is atomic on POSIX *and* on
the bind mounts Docker uses (unlike `flock`). Locks record their owner, time out
instead of hanging, and are broken when stale.

**Readers tolerate torn tails.** A reader asks for everything after a byte
offset and gets back complete lines only. A trailing partial line is left
unconsumed and picked up once it is whole. If the file is shorter than the
stored offset (truncated or replaced), the reader restarts from zero.

**Everything is schema-validated on read.** Corrupt state produces a clear error
naming the file and line, not a crash three layers away.

## Formats

### `project.json`

```json
{
  "id": "proj_mskuq7gwmqa5s1",
  "name": "product",
  "rootPath": "/home/you/product",
  "createdAt": "2026-08-08T00:00:00.000Z",
  "schemaVersion": 1,
  "providerModelOverrides": { "codex": ["gpt-6-preview"] }
}
```

`providerModelOverrides` is the escape hatch for model catalogs that age out of
a release — see [providers.md](./providers.md).

### `agents/<id>.json`

```json
{
  "id": "researcher",
  "displayName": "Researcher",
  "role": "agent",
  "provider": "claude-code",
  "model": "sonnet",
  "transport": "tmux",
  "tmuxSession": "research",
  "tmuxPane": {
    "paneId": "%7",
    "windowIndex": 0,
    "paneIndex": 0,
    "resolvedAt": "2026-08-08T00:00:01.000Z"
  },
  "parentId": "coordinator",
  "projectId": "proj_mskuq7gwmqa5s1",
  "workingDirectory": "/home/you/product",
  "registeredAt": "2026-08-08T00:00:00.000Z",
  "enabled": true
}
```

`reasoningEffort` appears only when the provider supports one. `tmuxPane` is
the last pane resolved for `tmuxSession` — set best-effort at `agent register`
and refreshed after every dispatch, so delivery can target the pane directly
instead of re-resolving `=tmuxSession` cold each time (see
[runtime.md](./runtime.md#pane-resolution) for why that matters). It is
absent until a pane has actually been resolved once. Note what else is *not*
here: nothing about credentials, tokens, or sessions beyond a name.

### A message (one line of `inbox.jsonl` / `outbox.jsonl`)

```json
{
  "id": "msg_mskuq8e3c8rd2m",
  "correlationId": "task_mskuq8e3c8rd2m",
  "from": "coordinator",
  "to": "researcher",
  "type": "task",
  "body": "Research persistence alternatives and recommend one.",
  "contextRefs": [".agentctl/context/shared.md"],
  "createdAt": "2026-08-08T20:54:11.466Z",
  "execution": { "provider": "claude-code", "model": "sonnet" }
}
```

Types: `task`, `result`, `question`, `status`, `error`, `cancel`, `ack`.

`correlationId` ties a whole exchange together — it is the task id, and it is
what `task watch` and `events --correlation-id` filter on.

Sending appends the **same message** to the recipient's `inbox.jsonl` and the
sender's `outbox.jsonl`, so each mailbox is a complete record of one agent's
traffic without needing to read anyone else's.

### `tasks/<id>.json`

```json
{
  "id": "task_mskuq8e3c8rd2m",
  "projectId": "proj_mskuq7gwmqa5s1",
  "from": "coordinator",
  "to": "researcher",
  "body": "Research persistence alternatives and recommend one.",
  "state": "completed",
  "execution": { "provider": "claude-code", "model": "sonnet" },
  "createdAt": "2026-08-08T20:54:11.466Z",
  "updatedAt": "2026-08-08T20:54:12.302Z",
  "dispatchedAt": "2026-08-08T20:54:11.900Z",
  "completedAt": "2026-08-08T20:54:12.302Z",
  "attempts": 1,
  "result": "SQLite with WAL.",
  "delivery": {
    "paneId": "%7",
    "resolvedVia": "pane-id",
    "queuedAt": "2026-08-08T20:54:11.700Z",
    "pastedAt": "2026-08-08T20:54:11.750Z",
    "submittedAt": "2026-08-08T20:54:11.900Z"
  }
}
```

`execution` is a **snapshot taken at assignment time**. `agent configure` later
changes the agent's default; it never rewrites this. That is the guarantee
behind "every task records the effective configuration."

`delivery` is telemetry for the most recent tmux delivery attempt —
`resolvedVia` is one of `pane-id` (the cached fast path), `qualified-fallback`
(`=session:0.0`), or `rediscovered` (a full `list-panes -a` scan). On a failed
attempt it instead carries `lastError` and a `paneTail` capture, and
`submittedAt` (sometimes `pastedAt` too) is absent — see
[runtime.md](./runtime.md#executing-a-task).

States: `pending` → `dispatched` → `in_progress` → one of `completed`,
`failed`, `cancelled`, `timed_out`. A tmux notification failure does **not**
move a task to `failed`: it is recorded on `delivery`/`error` and the task
stays in its current (non-terminal) state so `agentctl task redeliver <id>`
can retry it without creating a duplicate task or envelope.

### `status.json` and `cursor.json`

```json
{ "agentId": "researcher", "runnerState": "busy",
  "lastHeartbeatAt": "2026-08-08T20:54:41.604Z",
  "currentCorrelationId": "task_mskuq8e3c8rd2m", "pid": 5089,
  "updatedAt": "2026-08-08T20:54:41.604Z" }
```

```json
{ "agentId": "researcher", "offset": 412,
  "lastMessageId": "msg_mskuq8e3c8rd2m",
  "updatedAt": "2026-08-08T20:54:12.302Z" }
```

Runner states: `starting`, `idle`, `busy`, `waiting_input`, `error`, `stopped`.

`offset` is a **byte** offset into `inbox.jsonl`. This is why a restart never
reprocesses or drops a message, and why the queue survives an unclean kill.

### `events.jsonl`

```json
{ "id": "evt_...", "type": "task.completed", "projectId": "proj_...",
  "actor": "researcher", "subject": "coordinator",
  "correlationId": "task_...", "at": "2026-08-08T20:54:12.302Z",
  "data": { "state": "completed", "resultBytes": 42 } }
```

Event types: `project.created`, `project.context.added`, `agent.registered`,
`agent.configured`, `agent.enabled`, `agent.disabled`, `agent.removed`,
`message.sent`, `message.received`, `task.created`, `task.dispatched`,
`task.progress`, `task.completed`, `task.failed`, `task.cancelled`,
`task.timed_out`, `envelope.created`, `notification.failed`,
`notification.delivered`, `runner.started`, `runner.heartbeat`,
`runner.state`, `runner.stopped`, `runner.error`.

`envelope.created`, `notification.failed`, and `notification.delivered` are
the three states of one tmux delivery attempt: the envelope file is written
(at most once per task, even across retries), then the paste-buffer delivery
either fails (pane not found, or the paste/submit itself failed — task stays
non-terminal) or succeeds. See
[runtime.md](./runtime.md#executing-a-task).

**Redaction is unconditional.** Before an event is written, any key matching
token / secret / password / credential / api-key / authorization / cookie is
replaced with `[redacted]`, recursively. A careless caller cannot leak a secret
into the log.

## Routing policy

Enforced in `domain/hierarchy.ts`, checked before any file is touched:

| From → To | Allowed? |
| --- | --- |
| Coordinator → its **direct** child | yes |
| Any agent → its own parent | yes (this is how results travel up) |
| Agent → itself | yes (self-notes, retries) |
| Coordinator → a **grandchild** | no — relay through the child coordinator |
| Sibling → sibling | no |
| Anything across projects | no, always |

Additional invariants:

- A parent must be a **coordinator** and must be in the same project.
- Cycles are rejected at registration time, by walking up from the prospective
  parent and refusing if the child appears.
- One agent per tmux session, while that agent is enabled.
- A **disabled** agent receives no new work, but its mailbox and history stay
  readable.

## The task envelope

Rather than typing a wall of text into a TUI, the runner writes a markdown
envelope to `mailboxes/<agent>/work/<task>.envelope.md` and types **one line**
pointing at it. One line matters: multi-line input submits early in most
interactive clients.

The envelope carries exactly what the specification requires of every delivery:
the objective, the sender's identity, the working directory, the relevant
context references, and the instruction to return a structured response. It also
names the exact response path, forbids credentials in the answer, and states
that a written failure is a valid result while silence is not.

Context is passed **by reference plus a short summary**, never by copying large
blocks into every message.

## Reading the state by hand

```bash
cd my-project/.agentctl

cat project.json | jq
ls agents/
cat mailboxes/researcher/status.json | jq

# the queue, newest last
tail -n 5 mailboxes/researcher/inbox.jsonl | jq -c '{type,from,correlationId}'

# everything about one task
jq -c 'select(.correlationId=="task_abc")' events.jsonl

# what the agent was actually told, and what it answered
cat mailboxes/researcher/work/task_abc.envelope.md
cat mailboxes/researcher/work/task_abc.response.md
```

`agentctl doctor` automates the health-check version of this: malformed JSON or
JSONL, stale heartbeats, dead runners, missing sessions, and stale locks.

## Compatibility

`schemaVersion` in `project.json` is `1`. Readers refuse a version they do not
understand rather than guessing, so a future format change cannot silently
corrupt an old project.

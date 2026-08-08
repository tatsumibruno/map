# Architecture

How the codebase is organised, what each layer is allowed to know, and why the
boundaries sit where they do.

## The central constraint

Everything else follows from one decision: **the filesystem is the only message
bus and the only durable state.** There is no daemon, no socket, no database,
no in-memory queue that matters. Two processes coordinate if and only if they
can see the same `.agentctl/` directory.

That buys three properties the specification demands:

- **Restartability.** Kill anything at any moment; queues are files with byte
  offsets, so work resumes exactly where it stopped.
- **Inspectability.** Every question ("what did the coordinator send?", "why is
  this stuck?") is answered with `cat`, not with a debugger.
- **Topology independence.** Host processes, containers, or a mix — the protocol
  does not change, because a bind mount is just a directory.

And it imposes one cost: **every write must be crash-safe and concurrency-safe**,
which is why `infra/fs/` exists and is used by everything above it.

## Layers

```text
      ┌─────────────────────────────────────────────────────┐
 cli/ │ commander wiring · output formatting · completion   │
      └───────────────────────────┬─────────────────────────┘
                                  │ depends on
      ┌───────────────────────────▼─────────────────────────┐
 app/ │ services: projects · agents · message bus · tasks   │
      │           runner supervisor · event log · doctor    │
      └──────┬──────────────────────────────────┬───────────┘
             │                                  │
   ┌─────────▼─────────┐              ┌─────────▼──────────┐
   │  domain/          │              │  infra/  providers/│
   │  pure rules       │              │  fs · tmux · codex │
   │  zod schemas      │              │  claude-code       │
   │  NO I/O           │              │  the outside world │
   └───────────────────┘              └────────────────────┘

 runner/ (agent worker · coordinator) sits beside cli/ — both are entry points
 that compose app/ services. Neither is imported by app/ or domain/.
```

The rule that keeps this honest: **dependencies point inward.** `domain/`
imports nothing from `app/`, `infra/`, or `cli/`. `app/` never imports `cli/`.
Messaging and hierarchy rules are therefore testable without touching a disk or
spawning tmux — and reusable if the transport is ever something other than tmux.

## What each directory owns

### `src/domain/` — the rules

Pure, synchronous, dependency-free.

- **`types.ts`** — the vocabulary: `Project`, `Agent`, `Message`, `Task`,
  `AgentEvent`, `RunnerRecord`, plus the state enums. Optional properties are
  declared `?: T | undefined` deliberately, so they line up with what zod infers
  under `exactOptionalPropertyTypes`.
- **`schemas.ts`** — a zod schema for every persisted shape. Nothing enters the
  system unvalidated. Two schemas are load-bearing for security:
  `identifierSchema` (ids become directory names, so no `..`, no separators) and
  `tmuxSessionSchema` (a positive allow-list, since the value reaches a
  subprocess argument).
- **`hierarchy.ts`** — parent-link validation with cycle detection, and
  `canSendMessage`, which encodes the routing policy: a coordinator may address
  its *direct* children, any agent may reply to its parent, everything else must
  be relayed. Project isolation is enforced here too.

`ExecutionConfig` (provider + model + optional reasoning effort) is its own type
for one reason: it gets **snapshotted onto every task**, so `agent configure`
can never retroactively rewrite how finished work was executed.

### `src/core/` — small shared primitives

Ids (prefixed, time-sortable, collision-resistant across processes sharing a
volume), a `Clock` seam, `sleep` with `AbortSignal` support, and the error
hierarchy.

Errors carry a `hint` and an `exitCode`. That is a deliberate UX choice: the CLI
prints `message` plus `↳ hint` and exits with a meaningful code instead of
dumping a stack. Every "this failed" path in the spec (missing session,
unsupported model, wrong parent, session already taken) surfaces as a
`ValidationError`/`NotFoundError`/`ConflictError` with the fix in the hint.

### `src/infra/fs/` — making the filesystem trustworthy

The whole crash-safety story lives in four small modules:

- **`atomic.ts`** — `writeFileAtomic` writes to a temp file *in the destination
  directory* (same filesystem, so `rename` is atomic rather than `EXDEV`),
  `fsync`s it, then renames. A reader never observes a half-written document.
- **`jsonl.ts`** — append-only logs. `readJsonlFrom(file, schema, offset)`
  returns complete lines only and reports the new byte offset; a trailing
  partial line (a writer caught mid-append) is left unconsumed until it is
  whole. It also detects truncation and restarts from zero. `readJsonlLenient`
  is the `doctor` variant that reports bad lines instead of throwing.
- **`lock.ts`** — a `mkdir`-based advisory mutex. `mkdir` is atomic on POSIX
  *and* on Docker bind mounts, which `flock` is not reliably. Locks carry owner
  metadata, time out rather than hang, and are breakable when stale.
- **`paths.ts`** — the single source of truth for the layout. Nothing else
  builds a path by string concatenation, and `isInside()` backs the rule that
  context files stay under the project root.

### `src/infra/tmux/` — the transport

`ExecaTmuxClient` wraps the binary behind a `TmuxClient` interface. Two details
matter:

1. **Every call uses an argv array**, never a shell string, and session names
   are re-validated at the boundary even though registration already checked
   them. Nothing user-supplied is ever interpolated into a shell.
2. **`sendText` uses `send-keys -l`**, which types the payload *literally*, so
   a task body containing `C-c`, `Enter`, or `$(...)` is text and not a control
   sequence. Submission is a separate explicit `Enter`.

The interface is what makes the test suite fast and hermetic: `FakeTmuxClient`
implements it in memory, with an `onDispatch` hook that stands in for the AI
client reacting to a prompt.

### `src/providers/` — what each AI client needs

A `ProviderAdapter` owns three things the CLI deliberately does not:

- **Validation** of models and reasoning-effort levels. The CLI never hard-codes
  a catalog, so a provider shipping a new model doesn't require a release —
  `project model allow` extends the list per project.
- **The envelope**: the markdown instructions written to disk for a task.
- **The dispatch line and interrupt keys**: how to hand work to *this* client
  and how to stop it.

Claude Code returns `[]` from `listReasoningEfforts` and rejects
`--reasoning-effort` outright, which is how the spec's "omit when unsupported"
rule is enforced without special-casing anything in the CLI.

See [providers.md](./providers.md) to add one.

### `src/app/` — the services

Each service owns one part of the state directory and is the only writer of it:

| Service | Owns |
| --- | --- |
| `ProjectStore` / `ContextStore` | `project.json`, `context/` |
| `AgentRegistry` | `agents/*.json`, mailbox creation |
| `MessageBus` | `mailboxes/*/{inbox,outbox}.jsonl`, `status.json`, `cursor.json` |
| `TaskService` | `tasks/*.json` |
| `EventLog` | `events.jsonl` |
| `RunnerSupervisor` | `runners/*.json`, `logs/` |
| `GlobalConfigStore` | `~/.agentctl/config.json` (the project registry) |

`Workspace` is the composition root. It resolves *which* project is in scope —
`--path`, then `--project`, then a walk up from the current directory, then the
active project — loads it, and hands back every service already bound to it.
Commands take a `Workspace`; they never build paths themselves.

`EventLog.emit` redacts before writing. Any key matching token / secret /
password / credential / api-key / authorization / cookie becomes `[redacted]`,
recursively. That is defence in depth: even a careless caller cannot leak a
secret into the log.

### `src/runner/` — the two process modes

- **`AgentWorker`** (`agent-worker start`) polls exactly one mailbox and drives
  exactly one tmux session. It never reads another agent's mailbox.
- **`CoordinatorProcess`** (`coordinator start`) consolidates children's results
  into task records, expires timed-out tasks, and optionally keeps child runners
  alive. It never touches a child's terminal — only the shared directory.

Both are plain classes with an injectable logger, an `AbortSignal`, and a
`once: true` mode, which is what makes them directly unit-testable without
spawning a process.

See [runtime.md](./runtime.md) for the tick-by-tick behaviour.

### `src/cli/` — the surface

`commander` wiring, one module per command group. Two non-obvious pieces:

- **`propagateGlobalOptions`** re-declares `--project`, `--path`, and `--json`
  on every subcommand. Commander only parses root options *before* the
  subcommand name, but the documented usage puts them after
  (`agent register x --project product`). They are declared without defaults so
  an unset child option cannot shadow the root value in `optsWithGlobals()`.
- **`__complete`** is a hidden command that the generated shell scripts call for
  dynamic values (projects, agents, live tmux sessions, models, efforts). It
  swallows every error and prints nothing on failure — completion must never
  spew an error into the user's prompt.

## Two design decisions worth knowing

### The runner is a sidecar, not a session guest

The specification says the runner is "started in the registered TMUX session."
It cannot literally be: that session is occupied by your interactive AI client,
which owns the terminal.

So `runner start` spawns a **detached sibling process** that drives the session
from outside via `send-keys`, recording its pid and log path under
`.agentctl/runners/`. The interactive client keeps its terminal; the runner
keeps its own stdout (a log file).

This is also what makes the container topology work unchanged — a coordinator
never needs access to an agent's terminal, only to the shared directory.

### Results come back through a file, not the screen

Scraping `capture-pane` for an answer is brittle: output wraps, scrollback is
bounded, TUIs repaint, and a long answer can be observed half-rendered.

Instead the envelope tells the agent to write its final answer to a specific
path, and the runner reads that file only after **two identical stat
snapshots** (size + mtime), so a partially-written answer is never consumed.
Sentinel-delimited terminal capture (`<<<AGENTCTL_RESULT_BEGIN` …
`AGENTCTL_RESULT_END>>>`) remains as a bounded fallback for clients that could
not write the file.

## Adding things without breaking the protocol

- **A new provider** → implement `ProviderAdapter`, register it. Nothing else
  changes. ([providers.md](./providers.md))
- **A new transport** (Docker exec, SSH, a local API) → implement `TmuxClient`'s
  shape as a new interface and inject it into `Workspace`. The mailbox format,
  the hierarchy rules, and the CLI are untouched.
- **A new message type** → add it to `MessageType` and `messageTypeSchema`, then
  handle it in `AgentWorker.handleMessage`. The `switch` there is exhaustive, so
  the compiler will point at what is missing.
- **A new persisted field** → add it to the type *and* its zod schema. Loading
  is schema-validated, so an unvalidated field simply will not survive a
  round-trip.

## Source map

```text
src/
  bin/agentctl.ts        executable entry point
  index.ts               public API for embedding agentctl in another program
  core/                  ids · clock · errors
  domain/                types · schemas · hierarchy rules      (pure)
  infra/fs/              atomic writes · JSONL · locks · paths
  infra/tmux/            the tmux transport adapter
  providers/             adapter interface · codex · claude-code · envelope
  app/                   workspace · project · agents · bus · tasks
                         events · runner supervisor · doctor
  runner/                agent worker · coordinator · response capture
  cli/                   program · commands/ · output · completion/
```

# agentctl — Multi-Agent Protocol (MAP)

Orchestrate AI agents that are **already authenticated** in TMUX sessions.

`agentctl` never logs you in, never reads a credential file, and never stores a
token. You open a TMUX session, run `codex` or `claude` in it, and sign in
yourself. `agentctl` then registers that session as a coordinator or an agent,
and coordinates work between them — using the filesystem as the only message bus
and the only durable state.

```text
Host
  ├── tmux session "coord"    →  codex     (you signed in here)
  └── tmux session "research" →  claude    (you signed in here)
              ▲                        ▲
              │ send-keys              │ send-keys
        agentctl runner          agentctl runner
              └────────►  .agentctl/  ◄────────┘
                     (mailboxes, tasks, events)
```

This README is a **tutorial**: work through it top to bottom and you will end up
with a coordinator delegating real work to a second agent. For explanations of
how it works internally, see [`docs/`](./docs/README.md).

---

## Contents

- [Part 0 — Install](#part-0--install)
- [Part 1 — Authenticate your agents (you do this by hand)](#part-1--authenticate-your-agents-you-do-this-by-hand)
- [Part 2 — Create a project](#part-2--create-a-project)
- [Part 3 — Register your first agent](#part-3--register-your-first-agent)
- [Part 4 — Add a worker agent](#part-4--add-a-worker-agent)
- [Part 5 — Start the runner](#part-5--start-the-runner)
- [Part 6 — Delegate your first task](#part-6--delegate-your-first-task)
- [Part 7 — Watch what happened](#part-7--watch-what-happened)
- [Part 8 — Shared context](#part-8--shared-context)
- [Part 9 — Changing models mid-flight](#part-9--changing-models-mid-flight)
- [Part 10 — Cancelling, disabling, cleaning up](#part-10--cancelling-disabling-cleaning-up)
- [Part 11 — Shell completion](#part-11--shell-completion)
- [Part 12 — Running in containers](#part-12--running-in-containers-optional)
- [Troubleshooting](#troubleshooting)
- [Where to go next](#where-to-go-next)

---

## Part 0 — Install

You need **Node.js 18.18+**, **tmux 3.0+**, and at least one AI CLI you already
use (`codex` and/or `claude`).

```bash
git clone <this-repo> && cd map
npm install
npm run build
npm link            # puts `agentctl` on your PATH
```

Check it:

```bash
agentctl --version
agentctl doctor
```

`doctor` is your friend throughout this tutorial — run it any time something
looks wrong. Right now it should confirm Node and tmux, and tell you no project
is selected yet. That is expected.

> Full build details, packaging, and Docker images: [`docs/building.md`](./docs/building.md).

---

## Part 1 — Authenticate your agents (you do this by hand)

**`agentctl` has no login command, on purpose.** It never touches credentials.
You authenticate once, yourself, inside a tmux session — and that session stays
alive holding the authenticated process.

Open a terminal and create the first session:

```bash
tmux new -s coord
```

Inside it, start your client and complete the sign-in:

```bash
codex
```

Once you are signed in and at the client's prompt, detach with **`Ctrl-b d`**.
The session keeps running in the background.

Now do the same for a second agent:

```bash
tmux new -s research
```

Inside it:

```bash
claude
```

Sign in, then detach with **`Ctrl-b d`**.

Verify both are alive:

```bash
agentctl session list
```

```text
SESSION   WINDOWS  ATTACHED  AGENT
────────  ───────  ────────  ─────────────
coord     1        no        (unregistered)
research  1        no        (unregistered)
```

Two authenticated sessions, neither registered yet. That is what we fix next.

---

## Part 2 — Create a project

A **project** is a work unit: a directory, some shared context, a set of agents,
and their message history. Projects are fully isolated — messages never cross
between them.

```bash
agentctl project init product --path ./product
```

```text
✔ Created project product (proj_mskuq7gwmqa5s1)
  state directory: /home/you/product/.agentctl
```

Everything agentctl knows now lives under `./product/.agentctl/`. Have a look:

```bash
ls product/.agentctl/
# agents  context  events.jsonl  locks  logs  mailboxes  project.json  runners  tasks
```

Nothing is hidden in a database or a daemon. You can read all of it with `cat`.

The project you just created is now the **active** one:

```bash
agentctl project list
```

```text
   NAME     ROOT
─  ───────  ──────────────────
*  product  /home/you/product
```

Because of that, and because running from inside `./product` also works, most
commands below omit `--project`. Add `--project product` any time you are
somewhere else.

---

## Part 3 — Register your first agent

Registering tells agentctl: *this existing, already-authenticated session is now
an agent.* Nothing is launched, nothing is logged into.

Start with the **coordinator** — the agent that receives high-level work and
delegates it:

```bash
agentctl agent register coordinator \
  --project product \
  --role coordinator \
  --provider codex \
  --model gpt-5-codex \
  --reasoning-effort medium \
  --tmux coord
```

```text
✔ Registered coordinator in project "product"
role:              coordinator
provider:          codex
model:             gpt-5-codex
reasoning effort:  medium
tmux session:      coord
parent:            (root)
working directory: /home/you/product
```

What each flag does:

| Flag | Meaning |
| --- | --- |
| `--role coordinator` | this agent delegates work; only coordinators can own children |
| `--provider codex` | which client is running in that session |
| `--model gpt-5-codex` | the model this agent uses by default |
| `--reasoning-effort medium` | only where the provider supports it (Codex does; Claude Code does not) |
| `--tmux coord` | the session you authenticated in Part 1 |

**If the session name is wrong, registration fails loudly** — it will not create
a broken agent:

```text
error tmux session "coordinator" does not exist
  ↳ Create it and sign in first:  tmux new -s coordinator  then run `codex` inside it.
```

That is the general pattern: every failure names the problem and the fix.

---

## Part 4 — Add a worker agent

Now register the second session as an **agent** — an executor — and attach it to
the coordinator with `--parent`:

```bash
agentctl agent register researcher \
  --project product \
  --role agent \
  --provider claude-code \
  --model sonnet \
  --tmux research \
  --parent coordinator
```

Note there is **no `--reasoning-effort`**. Claude Code does not expose a
selectable one, and passing it is an error:

```text
error Claude Code does not expose a selectable reasoning effort
  ↳ Omit --reasoning-effort. Ask for deeper thinking in the task text instead.
```

Each provider adapter owns its own validation, so the CLI never lies to you
about what a model supports.

Look at the hierarchy:

```bash
agentctl agent list
```

```text
Project product
coordinator  coordinator · codex/gpt-5-codex · effort=medium · tmux=coord
└── researcher  agent · claude-code/sonnet · tmux=research
```

**The rules of the tree**, which agentctl enforces:

- Each agent has at most one parent, which must be a coordinator.
- A coordinator may message its **direct** children; deeper routing goes through
  the intermediate coordinator.
- Any agent may reply to its parent — that is how results travel back up.
- Cycles are rejected at registration time.
- Nothing crosses a project boundary, ever.

---

## Part 5 — Start the runner

Registration records *where* an agent lives. The **runner** is the process that
actually watches its mailbox and drives its tmux session:

```bash
agentctl runner start researcher
```

```text
✔ Runner for researcher started (pid 5089)
log: /home/you/product/.agentctl/logs/runner-researcher.log
```

It runs detached, so you get your terminal back. Check on it:

```bash
agentctl runner status
```

```text
AGENT        PID   PROCESS  STATE    LAST HEARTBEAT            TASK
───────────  ────  ───────  ───────  ────────────────────────  ────
coordinator  —     stopped  unknown  —                         —
researcher   5089  alive    idle     2026-08-08T20:54:41.604Z  —
```

`researcher` is `idle` — polling its mailbox, nothing to do yet. `coordinator`
has no runner, which is fine: for this tutorial *you* are the coordinator's
brain, assigning work from the command line. Start one for it too if you want it
driven by its own client.

> The runner is a **sidecar** process, not something typed into your session.
> Your interactive client keeps its terminal; the runner drives it from outside
> via `send-keys`. See [`docs/runtime.md`](./docs/runtime.md).

---

## Part 6 — Delegate your first task

```bash
agentctl task assign \
  --from coordinator \
  --to researcher \
  "Research persistence alternatives for a small CLI tool and recommend one."
```

```text
✔ Assigned task task_mskuq8e3c8rd2m to researcher
model:            sonnet
reasoning effort: (not applicable)
context refs:     .agentctl/context/shared.md

Watch it with: agentctl task watch task_mskuq8e3c8rd2m
```

Two things just happened that are worth understanding:

1. **The task recorded the model it will run with** (`sonnet`). That snapshot is
   permanent — changing the agent's model later never rewrites it.
2. **The message went into a file**, not a socket:
   `product/.agentctl/mailboxes/researcher/inbox.jsonl`.

Watch it finish:

```bash
agentctl task watch task_mskuq8e3c8rd2m
```

```text
2026-08-08T20:54:11.466Z  pending
2026-08-08T20:54:11.900Z  dispatched
2026-08-08T20:54:12.100Z  in_progress
2026-08-08T20:54:12.468Z  completed

Task task_mskuq8e3c8rd2m — completed
from → to:        coordinator → researcher
model:            sonnet
reasoning effort: (not applicable)
attempts:         1
completed at:     2026-08-08T20:54:12.302Z

Result
SQLite with WAL mode. …
```

You can also do both at once with `agentctl task assign … --watch`.

### What the runner actually did

1. Wrote a markdown **envelope** to
   `mailboxes/researcher/work/<task>.envelope.md` with the objective, the sender,
   the working directory, context references, and where to put the answer.
2. Typed **one line** into the `research` session pointing at that envelope, then
   pressed Enter. (One line matters — most interactive clients submit on the
   first newline.)
3. Waited for the agent to write its answer to
   `mailboxes/researcher/work/<task>.response.md`, reading it only once the file
   stopped changing.
4. Appended a `result` message to the **coordinator's** inbox and moved the task
   to `completed`.

Read the envelope yourself — it is just a file:

```bash
cat product/.agentctl/mailboxes/researcher/work/task_*.envelope.md
```

---

## Part 7 — Watch what happened

Every state transition is recorded in an append-only log:

```bash
agentctl events
```

```text
2026-08-08T20:54:10.269Z  project.created      cli → product {"rootPath":"/home/you/product"}
2026-08-08T20:54:10.532Z  agent.registered     cli → coordinator {"role":"coordinator","provider":"codex",…}
2026-08-08T20:54:10.757Z  agent.registered     cli → researcher {"role":"agent","provider":"claude-code",…}
2026-08-08T20:54:11.440Z  runner.started       researcher {"pid":5089,"pollIntervalMs":1500,"mode":"agent"}
2026-08-08T20:54:11.466Z  task.created         coordinator → researcher [task_…] {"model":"sonnet",…}
2026-08-08T20:54:12.302Z  task.completed       researcher → coordinator [task_…] {"state":"completed",…}
```

Useful variants:

```bash
agentctl events --follow                       # stream live (Ctrl-C to stop)
agentctl events --type task.                   # only the task lifecycle
agentctl events --correlation-id task_abc123   # everything about one task
agentctl --json events                         # machine-readable
```

Per-agent views:

```bash
agentctl agent status researcher     # session, runner state, heartbeat, recent traffic
agentctl message list researcher     # its inbox and outbox
agentctl task list                   # every task, with the model each ran with
```

Secrets never reach these logs: any field that looks like a token, password, or
API key is written as `[redacted]` before the event is stored.

---

## Part 8 — Shared context

Rather than pasting the same background into every task, put it in the project's
shared context. Agents receive **references**, not copies.

```bash
agentctl project context list
```

```text
REF                          BYTES
───────────────────────────  ─────
.agentctl/context/README.md  327
.agentctl/context/shared.md  135
```

Edit `product/.agentctl/context/shared.md` to describe your project,
conventions, and anything every agent should know. It is attached to every
dispatch by default.

Add more files:

```bash
agentctl project context add ./docs/api-conventions.md
agentctl project context add ./ADR-003.md --as decisions.md
```

Context files are restricted to the project root unless you explicitly pass
`--allow-outside-root` — a guard against pulling in something you did not mean
to share.

To scope one task to specific references:

```bash
agentctl task assign --from coordinator --to researcher \
  --context .agentctl/context/decisions.md \
  "Given ADR-003, does our persistence choice still hold?"
```

Keep context files short and focused. They are read by every agent, so they are
the wrong place for anything sensitive.

---

## Part 9 — Changing models mid-flight

Change an agent's default:

```bash
agentctl agent configure researcher --model opus
```

```text
✔ Updated researcher
model:            sonnet → opus
reasoning effort: (none) → (none)
Tasks already in progress keep the configuration they were dispatched with.
```

That last line is a guarantee, not a nicety: each task carries a snapshot of the
model and effort it was dispatched with, so `task list` remains an honest record
of what actually ran.

Override for a single task without touching the default:

```bash
agentctl task assign --from coordinator --to researcher \
  --model haiku \
  "Quick sanity check: list the three options in one line each."
```

### Using a model newer than this release

Built-in model lists are a convenience, not a hard-coded catalog. When a
provider ships something new:

```bash
agentctl project model allow codex gpt-6-preview
agentctl agent configure coordinator --model gpt-6-preview
```

See what is accepted here:

```bash
agentctl project model list
```

```text
PROVIDER     MODEL          REASONING EFFORTS        SOURCE
───────────  ─────────────  ───────────────────────  ────────
codex        gpt-5-codex    minimal,low,medium,high  built-in
codex        gpt-5          minimal,low,medium,high  built-in
claude-code  sonnet         —                        built-in
claude-code  haiku          —                        built-in
codex        gpt-6-preview  minimal,low,medium,high  project
```

(abridged — the real listing includes every built-in model.) Anything marked
`project` came from `project model allow`.

---

## Part 10 — Cancelling, disabling, cleaning up

**Stop a task that is going nowhere:**

```bash
agentctl task cancel task_abc123
```

The runner interrupts the session on its next poll and reports back.

**Take an agent out of rotation** without losing its history:

```bash
agentctl agent disable researcher
```

```text
✔ researcher is now disabled
Its history stays available; it simply receives no new work.
```

Any attempt to assign work to it now fails with exit code `4`. Re-enable with
`agentctl agent enable researcher`.

**Stop a runner:**

```bash
agentctl runner stop researcher
```

**Remove a registration:**

```bash
agentctl agent remove researcher
```

You will be asked to confirm. The mailbox and message history are kept unless
you pass `--purge-mailbox`, and **your tmux session is never closed** — agentctl
does not own it.

A coordinator with children cannot be removed until they are removed or
re-parented.

---

## Part 11 — Shell completion

Completion knows your projects, your agents, your live tmux sessions, and each
provider's models and reasoning-effort levels.

```bash
# bash
agentctl completion bash | sudo tee /etc/bash_completion.d/agentctl >/dev/null

# zsh
agentctl completion zsh > "${fpath[1]}/_agentctl" && autoload -Uz compinit && compinit

# fish
agentctl completion fish > ~/.config/fish/completions/agentctl.fish
```

`agentctl completion <shell> --instructions` prints the steps for your shell.
Then:

```bash
agentctl agent register x --provider codex --model <TAB>
# gpt-5-codex  gpt-5  gpt-5-mini  o4-mini

agentctl agent register x --tmux <TAB>
# coord  research
```

---

## Part 12 — Running in containers (optional)

The protocol does not care where a process runs, only that every process sees
the same `.agentctl/` directory. So a coordinator and its workers can live in
separate containers sharing one volume.

```bash
npm run build
docker compose build
docker compose up
```

```yaml
services:
  coordinator:
    build: .
    command: [coordinator, start, --path=/work, --poll-interval=2000]
    volumes: ['./product:/work']

  researcher:
    build: .
    command: [agent-worker, start, researcher, --path=/work, --poll-interval=2000]
    volumes: ['./product:/work']
```

Each agent container still needs its own authenticated session — attach and sign
in by hand, exactly as in Part 1:

```bash
docker compose exec researcher tmux new -s research
# run `claude`, sign in, Ctrl-b d
```

Two things to know:

- **Prefer polling.** Filesystem events are unreliable across bind mounts, so
  `--poll-interval` is the universal delivery mechanism.
- **The coordinator never needs an agent's terminal.** It only reads the shared
  directory and writes to mailboxes — which is exactly why this split works.

---

## Troubleshooting

Run `agentctl doctor` first. It checks Node, tmux, the state directory and its
permissions, every registration and its session, runner liveness, malformed
files, and stale locks.

**`tmux session "x" does not exist`**
The session died or was never created. Recreate it and sign in again:
`tmux new -s x`, then run `codex` / `claude`.

**A task sits in `dispatched` or `in_progress`**
Attach and look: `tmux attach -t research`. The client is usually waiting on a
confirmation prompt. Answer it, or `agentctl task cancel <id>` and reassign.

**`No response captured after Ns`**
The client never wrote the response file. Check it can write to
`.agentctl/mailboxes/<agent>/work/`, and read the envelope in that directory to
confirm the instructions arrived.

**`A runner for "x" is already running`**
`agentctl runner stop x`, or pass `--force` to replace it.

**Runner started but nothing happens**
Read `.agentctl/logs/runner-<agent>.log`. Common causes: a stale `dist/`
(rebuild), or tmux not on the runner's PATH (set `AGENTCTL_TMUX_BIN`).

**`Timed out waiting for lock`**
A process died holding a lock. Confirm nothing is running, then remove the stale
directory under `.agentctl/locks/`. `doctor` reports these.

**Nothing is picked up in Docker**
Filesystem events do not cross the volume. Lower `--poll-interval`.

**`No project selected`**
Run from inside the project, pass `--project <name>`, or set the active one with
`agentctl project use <name>`.

Set `AGENTCTL_DEBUG=1` for stack traces.

---

## Where to go next

| | |
| --- | --- |
| [`docs/example-rails-team.md`](./docs/example-rails-team.md) | a worked three-agent run across two containers |
| [`docs/commands.md`](./docs/commands.md) | every command, flag, and exit code |
| [`docs/architecture.md`](./docs/architecture.md) | how the codebase is laid out and why |
| [`docs/protocol.md`](./docs/protocol.md) | the on-disk formats and routing rules |
| [`docs/runtime.md`](./docs/runtime.md) | runners and coordinators, tick by tick |
| [`docs/providers.md`](./docs/providers.md) | adding a third provider |
| [`docs/building.md`](./docs/building.md) | building, packaging, releasing |
| [`docs/testing.md`](./docs/testing.md) | the test suite and how to extend it |

## Security model in one screen

- No credential is ever read, copied, logged, or stored. There is no login
  command.
- Model ids and reasoning efforts are configuration, validated by the provider
  adapter — never treated as credentials.
- Context files stay inside the project root unless you opt out explicitly.
- All JSON and JSONL is schema-validated before use.
- tmux is invoked with argv arrays, never a shell string, and session names are
  validated against a positive allow-list — nothing is interpolated into a
  shell.
- Event data is redacted: anything resembling a token, secret, password,
  credential, API key, authorization header, or cookie is stored as
  `[redacted]`.
- Destructive commands warn first and require `--yes` when non-interactive.

## License

MIT — see [LICENSE](./LICENSE).

# Worked example: a three-agent team across two containers

This walks a complete, non-trivial run: a **Product Manager** coordinating from
one container, and a **Tech Lead** plus a **Developer** working in another. The
product is a Rails 8.1 + SQLite expense tracker.

It is the smallest setup that exercises everything interesting at once —
multi-level hierarchy, delegation between agents, and a split-container topology
where the only thing the two sides share is a directory.

## What this assumes

You already have two running containers. This document does not build them.
Each one needs:

| | |
| --- | --- |
| **both containers** | `tmux`, `agentctl` on `PATH`, and the **same directory** mounted at `/work` |
| **pm container** | a signed-in AI client (`claude` or `codex`) |
| **team container** | a signed-in AI client, plus Ruby 3.3, Rails 8.1 and `sqlite3` |

The shared mount is not a convenience — it is the entire transport. There is no
network protocol, broker, or socket between the two sides. If `/work` in the PM
container is not the same directory as `/work` in the team container, nothing
will be delivered.

Throughout, commands are tagged **[PM]** or **[TEAM]** for the container they
must run in.

## The topology

```
┌─ pm container ──────────┐        ┌─ team container ─────────────────┐
│                         │        │                                  │
│  tmux: pm               │        │  tmux: techlead    tmux: dev     │
│    └─ claude (opus)     │        │    └─ codex          └─ claude    │
│                         │        │                                  │
│  agentctl coordinator   │        │  runner tech-lead  runner dev    │
└───────────┬─────────────┘        └───────────────┬──────────────────┘
            │                                      │
            └──────────► /work/.agentctl ◄─────────┘
                        (shared mount)
```

Agent hierarchy: `pm` → `tech-lead` → `developer`.

## 1. Create the project

Once, from either container:

```bash
# [PM]
cd /work
agentctl project init expenses --path /work
```

This creates `/work/.agentctl/` — agents, mailboxes, tasks, events, locks. Both
containers read and write here.

Run everything from inside `/work` from now on; the CLI discovers the project by
walking up from the working directory. From anywhere else, pass `--path /work`.

## 2. Open and authenticate one tmux session per agent

An agent *is* a tmux session with an AI client already signed in. `agentctl`
never authenticates anything — see [the security model](../README.md#security-model-in-one-screen).

```bash
# [PM]
tmux new -s pm
claude            # sign in interactively
# Ctrl-b d to detach, leaving the client running
```

```bash
# [TEAM]
tmux new -s techlead
codex             # sign in interactively
# Ctrl-b d

tmux new -s dev
claude            # sign in interactively
# Ctrl-b d
```

Confirm with `tmux ls`: `pm` in one container, `techlead` and `dev` in the other.

## 3. Register the agents — each in the container that owns its session

Registration verifies the tmux session exists, so you cannot register
`tech-lead` from the PM container.

```bash
# [PM] — the root coordinator
agentctl agent register pm \
  --role coordinator \
  --provider claude-code --model opus \
  --tmux pm \
  --display-name "Product Manager"
```

```bash
# [TEAM] — the tech lead is also a coordinator, so that it can delegate
agentctl agent register tech-lead \
  --role coordinator \
  --provider codex --model gpt-5-codex --reasoning-effort high \
  --tmux techlead \
  --parent pm \
  --display-name "Tech Lead"

# [TEAM] — the developer is an executor
agentctl agent register developer \
  --role agent \
  --provider claude-code --model sonnet \
  --tmux dev \
  --parent tech-lead \
  --display-name "Developer"
```

Check the result from either container:

```bash
agentctl agent list
# pm
# └── tech-lead
#     └── developer
```

Routing is level-respecting: `pm` may address `tech-lead`, and `tech-lead` may
address both `pm` and `developer`. A direct `pm → developer` message is
rejected by design — see the messaging rules in
[protocol.md](./protocol.md).

## 4. Give the team its shared context

This step is what turns three isolated agents into a team. Without it the tech
lead receives a task but has no idea it is allowed to delegate.

```bash
# [TEAM]
cat > /tmp/protocol.md <<'EOF'
# Product
A Rails 8.1 + SQLite personal expense tracker.
Models: Expense (amount decimal, description, spent_on date, category:references),
Category (name, color). Full CRUD, plus a monthly report grouped by category.
Live in /work/expense-tracker. Database: SQLite (the Rails 8 default).

# Environment
Ruby 3.3, Rails 8.1 and sqlite3 are available in this container.
Use `bin/rails` from inside /work/expense-tracker.

# Team protocol
You are part of a team orchestrated by agentctl.

- Tech Lead: break the PM's request into steps and DELEGATE the implementation:
    agentctl task assign "<detailed instruction>" --from tech-lead --to developer --path /work
  Track it with:
    agentctl task list --path /work
  Only answer the PM once the developer has returned a result.

- Developer: implement it, run the migrations and tests, and return a concise
  summary of what changed and which files were touched.

- Everyone: your final answer goes in THE FILE named in the task envelope.
  Printing it to the terminal is not enough.
EOF

agentctl project context add /tmp/protocol.md --as protocol.md
agentctl project context list
```

Every task envelope now references this file. The envelope format is documented
in [providers.md](./providers.md).

## 5. Start the runners

One runner per agent, **in the container that owns its tmux session**:

```bash
# [TEAM]
agentctl runner start tech-lead --poll-interval 2000
agentctl runner start developer --poll-interval 2000
agentctl runner status
```

```bash
# [PM] — the coordinator process consolidates results into tasks
agentctl coordinator start --poll-interval 2000
```

Two things to get right here:

**Do not pass `--supervise-children` to the PM's coordinator.** It would try to
start runners for `tech-lead` and `developer` inside the PM container, where the
`techlead` and `dev` tmux sessions do not exist. In a split-container topology,
each container supervises only its own runners.

**Filesystem events do not cross a bind mount reliably.** The `--poll-interval`
is the actual delivery mechanism. 2000 ms is a reasonable starting point; see
the tuning notes in [runtime.md](./runtime.md).

## 6. Assign the first task

`coordinator start` runs in the foreground, so use a second shell in the PM
container:

```bash
# [PM]
agentctl task assign \
  "Create a Rails 8.1 project at /work/expense-tracker using SQLite. \
Generate the Category and Expense models with migrations, full CRUD scaffolding, \
seeds with 5 categories, and verify that 'bin/rails db:migrate' and 'bin/rails test' pass. \
Delegate the implementation to the developer per the team protocol." \
  --from pm --to tech-lead \
  --timeout 1800000 \
  --watch
```

What happens next:

1. The `tech-lead` runner writes the envelope to
   `/work/.agentctl/mailboxes/tech-lead/work/`, types one dispatch line into the
   `techlead` tmux session, and waits for the response file.
2. The tech lead reads `protocol.md`, and runs `agentctl task assign … --to developer`.
3. The `developer` runner picks that up from the shared mount and dispatches it
   into the `dev` tmux session.
4. The developer's result travels back up to the tech lead, whose answer is
   consolidated by the PM's coordinator process into the original task.

## 7. Watch it run

From either container:

```bash
agentctl events --follow                  # live stream
agentctl events --type task. --limit 50   # just the task lifecycle
agentctl task list
agentctl task watch <task_id>
agentctl agent status tech-lead
agentctl runner status
```

To watch an agent actually work, attach to its session:

```bash
# [TEAM]
tmux attach -t dev
```

## 8. When it gets stuck

```bash
agentctl doctor                                      # tmux, sessions, runners, heartbeats, locks
cat /work/.agentctl/logs/runner-developer.log
cat /work/.agentctl/mailboxes/developer/work/*.md    # the envelope it received
agentctl task cancel <task_id>
```

Failure modes specific to this topology:

| Symptom | Cause |
| --- | --- |
| Nothing is ever delivered | The two containers are not on the same mount, or `--poll-interval` is too high |
| `No response captured after Ns` | The AI client never wrote the response file — attach to its tmux and look for a confirmation prompt it is waiting on |
| `Agent "x" is not registered` in the other container | The registration used a different `--path` |
| `A runner for "x" is already running` | A previous runner survived; `agentctl runner stop x` or pass `--force` |

[runtime.md](./runtime.md) has the full runner state table and the general
stuck-task procedure.

## 9. Shut down

```bash
# [TEAM]
agentctl runner stop developer
agentctl runner stop tech-lead

# [PM]
# Ctrl-C the coordinator
```

All state is on disk. Restarting the containers, re-authenticating the tmux
sessions, and starting the runners again resumes exactly where you left off.

## Adapting this

- **Single container.** Drop the [PM]/[TEAM] split and run everything in one
  place. Then `--supervise-children` *is* useful on the coordinator.
- **Flat team.** Register the tech lead with `--role agent` instead; it can no
  longer delegate, and the PM drives every worker directly.
- **More workers.** Add siblings under `tech-lead` with `--parent tech-lead`.
  The tech lead can fan work out to all of them; they cannot talk to each other.
- **Different models per role.** Any registered agent can be re-pointed with
  `agentctl agent configure <id> --model … --reasoning-effort …`, and any single
  task can override both with the same flags on `task assign`.

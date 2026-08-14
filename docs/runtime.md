# Runtime: runners, coordinators, and the task lifecycle

What the two long-lived process modes actually do, in order, and what each state
means when you are staring at a stuck task.

## The two modes

| | `agent-worker` | `coordinator` |
| --- | --- | --- |
| Started by | `runner start <agent>` (detached) or `agent-worker start <agent>` (foreground) | `coordinator start` |
| Watches | exactly one mailbox | every coordinator mailbox + all task records |
| Talks to tmux | yes — its own agent's session only | never |
| Writes | its own mailbox, its tasks, events | task records, child mailboxes, events |

They are process roles, not machine roles. Both can run on the host, in
separate containers, or mixed — the only thing they share is the `.agentctl/`
directory.

## Agent worker: one tick

`AgentWorker.tick()` runs every `--poll-interval` milliseconds (default 1500):

1. **Reload the agent record.** If it is `enabled: false`, write a
   `waiting_input` heartbeat and stop there — a disabled agent accepts no work.
2. **Read the inbox from the stored cursor.** Complete lines only, starting at
   the byte offset in `cursor.json`. Nothing new → `idle` heartbeat, done.
3. **Handle each new message in order.** A `task` is executed; a `cancel` marks
   its task cancelled; other types are logged. Every message emits
   `message.received`.
4. **Advance the cursor** to the offset actually consumed. A partial drain
   (worker stopped mid-batch) rewinds to the last message genuinely processed,
   so the rest is redelivered on the next start.

Failures inside a message are contained: the worker writes an `error` status,
emits `runner.error`, fails the task, and replies upward with an `error`
message. One bad task never kills the loop.

## Executing a task

```text
task message ──► write envelope (idempotent) ──► resolve pane ──► paste-buffer + C-m
                                                        │                 │
                                                        │                 ├─ wait: response file stable?
                                        notification.failed   ├─ wait: sentinel block in pane?
                                    (task stays retriable)    ├─ wait: cancel arrived?
                                                                └─ wait: deadline passed?
                                                                ▼
                              result / error message ◄── task transition ◄── outcome
```

Step by step:

1. **Resolve the execution config.** From the message's snapshot, falling back
   to the task record, then to the agent's defaults. The snapshot wins — that is
   what makes "tasks already in progress keep the configuration they were
   dispatched with" true.
2. **Write the envelope** to `work/<task>.envelope.md` — but only if it does not
   already exist. A redelivery after a failed notification (below) must not
   re-announce a new envelope for work the agent may already be reading; it
   reuses the one already on disk and emits `envelope.created` at most once per
   task. Also **delete any stale response file** from a previous attempt —
   skipping that deletion would let an old answer be read as the new one.
3. **Resolve a live pane** for the agent's tmux session (see "Pane resolution"
   below). Failure here — the session is gone, renamed, or every pane in it is
   dead — is recorded (`notification.failed`, `task.error`, `task.delivery`,
   a pane-tail capture) but does **not** fail the task. It stays in whatever
   state it was in, so `agentctl task redeliver <id>` can retry it without
   creating a duplicate task or envelope.
4. **Status → `busy`.**
5. **Deliver the dispatch line via the tmux paste buffer**: `set-buffer`, then
   `paste-buffer -d` into the resolved pane, then wait the provider's
   `submitDelayMs` (~150–200ms — some TUIs debounce paste-like input and
   swallow an immediate submit), then send `C-m` separately. Never a raw
   `send-keys -l` for the dispatch line — see "Why the paste buffer" below.
   Only once `C-m` itself succeeds is the notification considered delivered
   (`notification.delivered`, `task.delivery.submittedAt` set); the task then
   moves `dispatched` → `in_progress`.
6. **Wait** for the outcome.
7. **On success** the task goes `completed` with the result, and a `result`
   message is appended to the *sender's* inbox. On timeout or cancel, the
   provider's interrupt keys are sent (to the resolved pane) and an `error`
   message goes back instead.

### Pane resolution

The transport targets a tmux **pane id** (`%7`), not the bare session name.
`=session` (tmux's exact-match target syntax) resolves fine for
`has-session`/`display-message` but — depending on the tmux build — does
**not** reliably resolve to a pane for `send-keys`/`paste-buffer`, failing
with `can't find pane: =session` even though the session plainly exists. This
is the exact failure this transport was built to route around; `agentctl
doctor` and `agent register` no longer trust a bare `=session` target for
delivery.

`AgentWorker` resolves a pane in three steps (`resolvePane` in
`src/infra/tmux/paneResolution.ts`), each tried until one yields a live pane:

1. **The cached pane id** (`Agent.tmuxPane.paneId`), set by `agent register`
   and refreshed after every dispatch. Rejected if dead, or if it now belongs
   to a different session — the latter guards against a tmux server restart,
   which resets pane ids from `%0`, so a stale hint can coincidentally match
   an unrelated live pane.
2. **The qualified fallback** `=session:0.0` — unambiguous, and (unlike the
   bare form) actually resolves to a pane.
3. **A full `tmux list-panes -a` scan**, matched by session name, preferring
   the lowest window/pane index among live panes. Covers a renamed/rebuilt
   window or a session recreated after a restart.

If none of the three find a live pane, the error names the expected session
and lists every pane currently on the server (id, session, window, pane,
dead-flag), so there is never a need to guess from a bare tmux error string.

### Why the paste buffer

`send-keys -l` types text as literal keystrokes. For a single short line that
is fine, but it is the wrong primitive for anything long, multi-line, or
containing shell-special characters typed into a TUI that treats fast input
as paste (many do, and can swallow or mis-render it). `set-buffer` +
`paste-buffer -d` loads the payload in one shot and hands it to the pane
verbatim — newlines, quotes, and control characters survive exactly — and
`C-m` is sent as a separate, explicit step afterward. A message is only ever
marked delivered once *both* the paste and the `C-m` succeeded; a failure at
either stage is recorded with which stage got as far as it did
(`task.delivery.queuedAt`/`pastedAt`/`submittedAt`), never silently treated as
delivered.

### How the answer is captured

Two channels, in priority order:

**The response file (primary).** The runner stats the path each poll and reads
it only after **two identical snapshots** (same size, same mtime). A long answer
being written slowly is never read half-finished.

**The terminal sentinel (fallback).** If no file has appeared, the runner takes
a bounded `capture-pane` and looks for the last complete block between
`<<<AGENTCTL_RESULT_BEGIN` and `AGENTCTL_RESULT_END>>>`. Bounded and
delimited — not unbounded screen scraping.

Capture failures are swallowed; the file remains authoritative.

### Cancellation while busy

A `cancel` that arrives mid-task cannot wait for the main loop, which is blocked
waiting for an answer. So the wait loop **peeks past the cursor** each poll for a
`cancel` matching the running `correlationId`. When it finds one it records the
message id as already handled (so the main loop will not reprocess it), sends the
interrupt keys, marks the task `cancelled`, and replies upward.

### Timeouts

Two independent mechanisms:

- **`--response-timeout` on the runner** (default 15 min) bounds one dispatch.
  On expiry: interrupt, task → `timed_out`, error message upward naming the
  session to attach to.
- **`--timeout` on the task** is enforced by a running coordinator, measured
  from `dispatchedAt` (or `createdAt`). This is the one that survives a runner
  that died entirely.

## Heartbeats

`status.json` is refreshed at most every `heartbeatMs` (default 15s) to avoid
event spam, and a `runner.heartbeat` event is emitted alongside. `doctor` flags
a heartbeat older than 120 seconds while the state is not `stopped` — that is
the signature of a wedged or killed runner.

State meanings:

| State | Means |
| --- | --- |
| `starting` | process came up, has not polled yet |
| `idle` | polling, nothing queued |
| `busy` | dispatched a task, waiting for the answer |
| `waiting_input` | not accepting work (agent disabled) |
| `error` | last message threw; details in `detail` |
| `stopped` | shut down cleanly (or was stopped) |

## Coordinator: one tick

`CoordinatorProcess.tick()` every `--poll-interval` (default 2000ms):

1. **For each coordinator**, read new inbox entries and **consolidate**: a
   `result` moves its task to `completed` with the body as the result, an
   `error` moves it to `failed`. Already-terminal tasks are left alone.
2. **Expire overdue tasks** (unless `--no-enforce-timeouts`): anything
   non-terminal past its `timeoutMs` becomes `timed_out`.
3. **Supervise children** (only with `--supervise-children`): for each enabled
   direct child with no live runner, start one. Failures are logged, not fatal.

The coordinator reads the shared directory and writes mailboxes. It never opens
a child's terminal — which is exactly why the container split works.

## Process supervision

`runner start` spawns a **detached** `node dist/bin/agentctl.js agent-worker
start …`, with stdout and stderr redirected to
`.agentctl/logs/runner-<agent>.log`, and records pid + log path + poll interval
in `.agentctl/runners/<agent>.json`.

Liveness is `process.kill(pid, 0)` — an existence/permission check that delivers
no signal. `EPERM` counts as alive (the process exists, owned by someone else).

`runner stop` sends `SIGTERM`, waits up to 5s, then `SIGKILL`, removes the
record, and writes a `stopped` status. Both runner modes install signal handlers
that abort the loop so they can write that final status themselves.

Because the pid file and the process are separate facts, they can disagree —
`doctor` and `runner status` report "recorded but not running" rather than
pretending.

## Debugging a stuck task

```bash
agentctl runner status                  # is a runner alive? recent heartbeat?
agentctl agent status researcher        # session present? current task?
agentctl events --follow --correlation-id task_abc
```

Then, in order of likelihood:

1. **The client is waiting on a confirmation prompt.**
   `tmux attach -t research` and look. This is by far the most common cause;
   the runner state will be `busy` with a fresh heartbeat.
2. **The notification failed to reach the pane at all.** Check
   `agentctl task list --state pending` / the task's `delivery`/`error` fields
   (`--json task list` shows both), and look for `notification.failed` in
   `agentctl events`. This means the pane could not be resolved or the paste/
   submit itself failed — see "Diagnosing pane resolution" below. The task is
   *not* marked `failed` for this; it stays retriable.
3. **The client never got the prompt despite a successful notification.** Read
   `mailboxes/<agent>/work/<task>.envelope.md` — it exists once the envelope
   is written (before any tmux call). Check the pane for the typed line; the
   task's `delivery.submittedAt` confirms `C-m` was actually sent.
4. **The client answered but could not write the file.** Check permissions on
   `mailboxes/<agent>/work/`, and look for the sentinel block in the pane.
5. **The runner is dead.** `runner status` shows a recorded pid that is not
   alive; the log at `.agentctl/logs/runner-<agent>.log` has the reason.
6. **Nothing is polling at all** (common in Docker). Filesystem events do not
   cross bind mounts reliably; lower `--poll-interval`.

`agentctl task cancel <id>` unblocks the queue; the task can then be reassigned.

### Diagnosing pane resolution

```bash
# Does the session exist at all, and which pane does tmux itself say is
# the session's current one?
tmux display-message -p -t '=research' '#{pane_id}'      # often empty/fails — see above
tmux display-message -p -t '=research:0.0' '#{pane_id}'  # the qualified fallback agentctl uses

# Every pane on the server, with liveness — the same table agentctl prints
# in a "no live tmux pane found" error:
tmux list-panes -a -F '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_dead}'

# What agentctl currently has cached for the agent:
agentctl --json agent status researcher | grep -A4 tmuxPane
```

If the cached pane id in the agent record no longer appears in `list-panes`,
or belongs to a different session than expected, the tmux server was likely
restarted (pane ids reset) or the session was torn down and recreated. The
next dispatch (or `task redeliver`) re-resolves and re-caches it automatically
— no manual repair needed beyond making sure the session and its AI client
exist again.

### Retrying only the delivery of an existing task

A tmux notification failure (pane resolution, paste, or submit) never marks a
task `failed` and never creates a duplicate — the same task and envelope are
reused. To retry delivery once the underlying problem (dead session, wrong
pane, tmux restart) is fixed:

```bash
agentctl task redeliver <task-id>          # one attempt, reuses task + envelope
agentctl task redeliver <task-id> --watch  # ... then follow it to a terminal state
```

This does not require a running sidecar runner — it performs the attempt (and,
with `--watch`, the wait for a response) in the foreground. Running it
concurrently with a live sidecar runner for the same agent can race and
deliver the prompt twice; stop the runner first, or only use `task redeliver`
for agents you are driving manually.

`agentctl events --correlation-id <task-id>` shows the full delivery history
for one task: `envelope.created` (once), then any number of
`notification.failed`/`notification.delivered` pairs across retries.

## Tuning the poll interval

| Setting | Good for |
| --- | --- |
| 200–500ms | interactive local work, short tasks |
| 1500ms (default) | normal local use |
| 2000–5000ms | containers, many agents, long-running tasks |

The interval is the *floor* on how fast a task is noticed and how fast a
response is detected — not a rate limit on the agent itself. Lower means more
`stat` calls; it does not mean more work for the AI client.

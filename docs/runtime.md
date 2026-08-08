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
task message ──► write envelope ──► send-keys (one line, literal)
                                         │
                                         ├─ wait: response file stable?
                                         ├─ wait: sentinel block in pane?
                                         ├─ wait: cancel arrived?
                                         └─ wait: deadline passed?
                                         ▼
      result / error message ◄── task transition ◄── outcome
```

Step by step:

1. **Resolve the execution config.** From the message's snapshot, falling back
   to the task record, then to the agent's defaults. The snapshot wins — that is
   what makes "tasks already in progress keep the configuration they were
   dispatched with" true.
2. **Write the envelope** to `work/<task>.envelope.md`, and **delete any stale
   response file** from a previous attempt. Skipping that deletion would let an
   old answer be read as the new one.
3. **Verify the tmux session still exists.** If it is gone, fail loudly with the
   session name and the client to restart — do not silently retry.
4. **Status → `busy`**, task → `dispatched` (increments `attempts`).
5. **Type the dispatch line literally** (`send-keys -l`), wait the provider's
   `submitDelayMs`, then send `Enter` separately. The delay exists because some
   TUIs debounce paste-like input and swallow an immediate submit.
6. **Task → `in_progress`**, then wait.
7. **On success** the task goes `completed` with the result, and a `result`
   message is appended to the *sender's* inbox. On timeout or cancel, the
   provider's interrupt keys are sent and an `error` message goes back instead.

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
2. **The client never got the prompt.** Read
   `mailboxes/<agent>/work/<task>.envelope.md` — it exists if the runner
   dispatched. Check the pane for the typed line.
3. **The client answered but could not write the file.** Check permissions on
   `mailboxes/<agent>/work/`, and look for the sentinel block in the pane.
4. **The runner is dead.** `runner status` shows a recorded pid that is not
   alive; the log at `.agentctl/logs/runner-<agent>.log` has the reason.
5. **Nothing is polling at all** (common in Docker). Filesystem events do not
   cross bind mounts reliably; lower `--poll-interval`.

`agentctl task cancel <id>` unblocks the queue; the task can then be reassigned.

## Tuning the poll interval

| Setting | Good for |
| --- | --- |
| 200–500ms | interactive local work, short tasks |
| 1500ms (default) | normal local use |
| 2000–5000ms | containers, many agents, long-running tasks |

The interval is the *floor* on how fast a task is noticed and how fast a
response is detected — not a rate limit on the agent itself. Lower means more
`stat` calls; it does not mean more work for the AI client.

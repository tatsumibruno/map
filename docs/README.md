# agentctl documentation

The [root README](../README.md) is the **tutorial**: install it, authenticate,
and drive a two-agent hierarchy end to end. These documents are the
**explanations** — how the thing actually works, and how to change it.

Read them in whatever order suits you; each stands on its own.

| Document | What it answers |
| --- | --- |
| [architecture.md](./architecture.md) | How is the codebase laid out, what does each layer own, and why? |
| [protocol.md](./protocol.md) | What exactly lives in `.agentctl/`, and what are the on-disk formats and rules? |
| [runtime.md](./runtime.md) | What do the runner and coordinator processes actually do, tick by tick? |
| [providers.md](./providers.md) | How does a provider adapter work, and how do I add a third one? |
| [building.md](./building.md) | How do I build, link, package, and ship the CLI? |
| [testing.md](./testing.md) | How is the test suite organised, and how do I add to it? |
| [commands.md](./commands.md) | Full reference for every command, flag, and exit code. |
| [example-rails-team.md](./example-rails-team.md) | A worked end-to-end run: a PM, a tech lead and a developer across two containers. |

## The one-paragraph version

You authenticate `codex` or `claude` by hand inside a tmux session. `agentctl`
registers that session as an **agent** in a **project**, and from then on all
coordination happens through files under the project's `.agentctl/` directory:
append-only JSONL mailboxes carry messages, atomically-replaced JSON files carry
current state, and an append-only `events.jsonl` records everything that
happened. A **runner** process watches one mailbox, types a single line into its
agent's tmux session pointing at a task envelope on disk, and publishes whatever
the agent writes back. No credential is ever read, stored, or transmitted.

## Where to start, by goal

- **"I just want to use it."** → [root README](../README.md), then
  [commands.md](./commands.md).
- **"Show me a real, multi-container team."** →
  [example-rails-team.md](./example-rails-team.md).
- **"Something is stuck and I need to debug it."** → [runtime.md](./runtime.md)
  (task lifecycle and runner states), then [protocol.md](./protocol.md) to read
  the state directory by hand.
- **"I want to add a provider."** → [providers.md](./providers.md).
- **"I want to change the internals."** → [architecture.md](./architecture.md),
  then [testing.md](./testing.md).
- **"I need a binary/image to distribute."** → [building.md](./building.md).

# Provider adapters

A provider adapter is the only thing that knows how one AI client behaves. Add
one and the rest of the system — mailboxes, hierarchy, CLI, runners — is
unchanged.

## What an adapter owns

```ts
interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly expectedCommand: string;      // 'codex' | 'claude' — for diagnostics only

  listModels(): readonly ModelDescriptor[];
  supportsReasoningEffort(model: string, options?: ValidateOptions): boolean;
  listReasoningEfforts(model: string, options?: ValidateOptions): readonly string[];
  validateExecutionConfig(config, options?): void;   // throws ValidationError

  buildEnvelope(context: DispatchContext): string;   // markdown written to disk
  buildDispatchLine(context: DispatchContext): string; // ONE line typed into tmux

  readonly interruptKeys: readonly string[];         // e.g. ['Escape']
  readonly submitDelayMs: number;
}
```

Four responsibilities, in plain terms:

1. **Which models and reasoning efforts are valid**, and a clear error when they
   are not. The CLI never hard-codes this.
2. **How to phrase the work** — the envelope on disk.
3. **How to hand it over** — the single line typed into the session.
4. **How to stop it** — the interrupt keys.

`expectedCommand` is used only by `doctor` and error hints. agentctl never
launches or logs into anything.

## The two built-ins

| | `codex` | `claude-code` |
| --- | --- | --- |
| Command you run manually | `codex` | `claude` |
| Reasoning effort | `minimal`, `low`, `medium`, `high` | none — rejected |
| Interrupt keys | `Escape` `Escape` | `Escape` |
| Submit delay | 150ms | 200ms |

Claude Code selects thinking depth from the prompt rather than a discrete
parameter, so its adapter returns `[]` from `listReasoningEfforts` and rejects
`--reasoning-effort` with a hint to ask for depth in the task text. That is how
the "omit when unsupported" rule is enforced — as adapter behaviour, not as a
special case in the CLI.

## Model catalogs age; the design accounts for it

Each adapter ships a list of known model ids. That list is a **convenience for
validation and completion, not a source of truth** — provider catalogs move
faster than releases.

When a provider ships something newer:

```bash
agentctl project model allow codex gpt-6-preview
agentctl project model list
agentctl agent register x --provider codex --model gpt-6-preview ...
```

The allow-list is stored per project in `project.json` under
`providerModelOverrides` and reaches adapters as `ValidateOptions.extraModels`.
So an unknown model still fails loudly by default — with the exact fix in the
error hint — but never blocks you waiting for a release:

```text
error Model "gpt-6-preview" is not a known Codex model
  ↳ Known models: gpt-5-codex, gpt-5, gpt-5-mini, o4-mini. If Codex added a
    newer model, allow it with: agentctl project model allow codex gpt-6-preview
```

## Writing a new adapter

### 1. Add the id

`src/domain/types.ts`:

```ts
export type ProviderId = 'codex' | 'claude-code' | 'my-provider';
```

`src/domain/schemas.ts`:

```ts
export const providerIdSchema = z.enum(['codex', 'claude-code', 'my-provider']);
```

Keeping the type and the schema in step matters — persisted agents are validated
on every read.

### 2. Implement the adapter

`src/providers/myProvider.ts`:

```ts
import { ValidationError } from '../core/errors.js';
import { buildSharedEnvelope } from './envelope.js';
import type { DispatchContext, ModelDescriptor, ProviderAdapter, ValidateOptions } from './types.js';

const EFFORTS = ['low', 'high'] as const;

const MODELS: readonly ModelDescriptor[] = [
  { id: 'my-model-1', label: 'My Model 1', reasoningEfforts: EFFORTS },
];

export class MyProviderAdapter implements ProviderAdapter {
  readonly id = 'my-provider' as const;
  readonly displayName = 'My Provider';
  readonly expectedCommand = 'myclient';
  readonly interruptKeys = ['C-c'] as const;
  readonly submitDelayMs = 150;

  listModels() { return MODELS; }

  private known(model: string, options?: ValidateOptions) {
    return (
      MODELS.find((m) => m.id === model) ??
      (options?.extraModels?.includes(model)
        ? { id: model, label: model, reasoningEfforts: EFFORTS }
        : undefined)
    );
  }

  supportsReasoningEffort(model: string, options?: ValidateOptions) {
    return (this.known(model, options)?.reasoningEfforts.length ?? 0) > 0;
  }

  listReasoningEfforts(model: string, options?: ValidateOptions) {
    return this.known(model, options)?.reasoningEfforts ?? EFFORTS;
  }

  validateExecutionConfig(config, options?) {
    const descriptor = this.known(config.model, options);
    if (!descriptor) {
      throw new ValidationError(
        `Model "${config.model}" is not a known My Provider model`,
        `Known models: ${MODELS.map((m) => m.id).join(', ')}. ` +
          `To use a newer id: agentctl project model allow my-provider ${config.model}`,
      );
    }
    if (config.reasoningEffort === undefined) return;
    if (!descriptor.reasoningEfforts.includes(config.reasoningEffort)) {
      throw new ValidationError(
        `Reasoning effort "${config.reasoningEffort}" is not supported by "${config.model}"`,
        `Supported levels: ${descriptor.reasoningEfforts.join(', ')}.`,
      );
    }
  }

  buildEnvelope(context: DispatchContext) {
    return buildSharedEnvelope(context, [
      'You are running inside a My Provider session registered with agentctl.',
    ]);
  }

  buildDispatchLine(context: DispatchContext) {
    return (
      `[agentctl] New task ${context.correlationId} from ${context.from}. ` +
      `Read ${context.envelopePath} and follow it exactly, then write your ` +
      `final answer to ${context.responsePath}.`
    );
  }
}
```

### 3. Register it

`src/providers/registry.ts`:

```ts
const adapters = new Map<ProviderId, ProviderAdapter>([
  ['codex', new CodexAdapter()],
  ['claude-code', new ClaudeCodeAdapter()],
  ['my-provider', new MyProviderAdapter()],
]);
```

That is the whole integration. `PROVIDER_IDS` drives CLI validation, help text,
and shell completion automatically.

### 4. Test it

Add cases to `test/providers/adapters.test.ts` covering: a valid config, an
unknown model (assert the **hint** names `project model allow`), an unsupported
effort, an allow-listed model, and that `buildDispatchLine` returns exactly one
line.

Then exercise it through the worker with `FakeTmuxClient` — see
[testing.md](./testing.md).

## Rules for `buildDispatchLine`

**It must be a single line.** Most interactive clients submit on the first
newline, so a multi-line prompt gets truncated or fires early. Put the detail in
the envelope and point at it.

**Include absolute paths.** The client's working directory is not guaranteed to
be the project root.

**Say what to do with the answer.** The runner's primary capture path is the
response file; the line should reinforce what the envelope already says.

## Rules for `buildEnvelope`

Use `buildSharedEnvelope(context, notes)`. It already emits everything the
protocol requires — objective, sender, working directory, context references,
the exact response path, the sentinel fallback, and the constraint that a
written failure is a valid result while silence is not — plus the standing
instruction never to include credentials.

Your `notes` are the provider-specific addenda, e.g. "use the Write tool rather
than echoing into the terminal."

## Interrupt keys

Sent when a task is cancelled or times out. Use whatever genuinely stops your
client mid-turn without killing the process or logging it out — `Escape` for
Claude Code, `Escape` twice for Codex, `C-c` for a plain REPL.

They must be **tmux key names**, since they are passed to `send-keys` without
`-l`.

## Things an adapter must never do

- Read, write, or inspect credentials — no exceptions.
- Launch or automate a login.
- Depend on unbounded terminal scraping for results.
- Emit multi-line dispatch lines.
- Hard-code a model list as the *only* accepted set (always honour
  `extraModels`).

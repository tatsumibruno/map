import { type Agent, type ExecutionConfig, type ProviderId } from '../domain/types.js';

export interface ModelDescriptor {
  id: string;
  label: string;
  /** Reasoning-effort levels valid for this model; empty means unsupported. */
  reasoningEfforts: readonly string[];
}

/** Everything an adapter needs to phrase one unit of work for its client. */
export interface DispatchContext {
  agent: Agent;
  execution: ExecutionConfig;
  from: string;
  correlationId: string;
  messageId: string;
  body: string;
  workingDirectory: string;
  /** Absolute path of the markdown envelope written for this task. */
  envelopePath: string;
  /** Absolute path the agent must write its final answer to. */
  responsePath: string;
  /** Project-relative context file references. */
  contextRefs: readonly string[];
  contextDir: string;
}

export interface ValidateOptions {
  /** Extra model ids the user declared valid for this provider. */
  extraModels?: readonly string[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  /**
   * Command the user is expected to have started manually in the tmux session.
   * Used by `doctor` for diagnostics only — agentctl never launches a login.
   */
  readonly expectedCommand: string;

  listModels(): readonly ModelDescriptor[];
  supportsReasoningEffort(model: string, options?: ValidateOptions): boolean;
  listReasoningEfforts(model: string, options?: ValidateOptions): readonly string[];

  /**
   * Throws a ValidationError when the model or reasoning effort is not usable
   * with this provider. The adapter — not the CLI — owns the catalog.
   */
  validateExecutionConfig(
    config: { model: string; reasoningEffort?: string | undefined },
    options?: ValidateOptions,
  ): void;

  /** Full markdown instructions persisted next to the mailbox. */
  buildEnvelope(context: DispatchContext): string;

  /**
   * The single line typed into the terminal. Kept to one line on purpose:
   * multi-line input submits early in most interactive TUIs.
   */
  buildDispatchLine(context: DispatchContext): string;

  /** Keys that cancel whatever the client is currently doing. */
  readonly interruptKeys: readonly string[];

  /**
   * Milliseconds to wait between typing the prompt and pressing Enter. Some
   * TUIs debounce paste-like input and swallow an immediate submit.
   */
  readonly submitDelayMs: number;
}

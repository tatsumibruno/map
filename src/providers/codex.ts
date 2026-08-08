import { ValidationError } from '../core/errors.js';
import { buildSharedEnvelope } from './envelope.js';
import {
  type DispatchContext,
  type ModelDescriptor,
  type ProviderAdapter,
  type ValidateOptions,
} from './types.js';

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

/**
 * Known-good model ids. This list is a convenience for validation and
 * autocomplete, not a source of truth: provider catalogs move faster than
 * releases, so unknown ids are accepted once declared on the project via
 * `agentctl project model allow`.
 */
const MODELS: readonly ModelDescriptor[] = [
  { id: 'gpt-5-codex', label: 'GPT-5 Codex', reasoningEfforts: EFFORTS },
  { id: 'gpt-5', label: 'GPT-5', reasoningEfforts: EFFORTS },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', reasoningEfforts: EFFORTS },
  { id: 'o4-mini', label: 'o4-mini', reasoningEfforts: EFFORTS },
];

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly expectedCommand = 'codex';
  readonly interruptKeys = ['Escape', 'Escape'] as const;
  readonly submitDelayMs = 150;

  listModels(): readonly ModelDescriptor[] {
    return MODELS;
  }

  private known(model: string, options?: ValidateOptions): ModelDescriptor | undefined {
    const found = MODELS.find((m) => m.id === model);
    if (found) return found;
    if (options?.extraModels?.includes(model)) {
      return { id: model, label: model, reasoningEfforts: EFFORTS };
    }
    return undefined;
  }

  supportsReasoningEffort(model: string, options?: ValidateOptions): boolean {
    return (this.known(model, options)?.reasoningEfforts.length ?? 0) > 0;
  }

  listReasoningEfforts(model: string, options?: ValidateOptions): readonly string[] {
    return this.known(model, options)?.reasoningEfforts ?? EFFORTS;
  }

  validateExecutionConfig(
    config: { model: string; reasoningEffort?: string | undefined },
    options?: ValidateOptions,
  ): void {
    const descriptor = this.known(config.model, options);
    if (!descriptor) {
      throw new ValidationError(
        `Model "${config.model}" is not a known Codex model`,
        `Known models: ${MODELS.map((m) => m.id).join(', ')}. ` +
          `If Codex added a newer model, allow it with: agentctl project model allow codex ${config.model}`,
      );
    }
    if (config.reasoningEffort === undefined) return;
    if (descriptor.reasoningEfforts.length === 0) {
      throw new ValidationError(
        `Codex model "${config.model}" does not support a reasoning effort`,
        'Omit --reasoning-effort for this model.',
      );
    }
    if (!descriptor.reasoningEfforts.includes(config.reasoningEffort)) {
      throw new ValidationError(
        `Reasoning effort "${config.reasoningEffort}" is not supported by Codex model "${config.model}"`,
        `Supported levels: ${descriptor.reasoningEfforts.join(', ')}.`,
      );
    }
  }

  buildEnvelope(context: DispatchContext): string {
    return buildSharedEnvelope(context, [
      'You are running inside a Codex session registered with agentctl.',
      'Prefer `apply_patch`/file edits over pasting large blocks into the terminal.',
    ]);
  }

  buildDispatchLine(context: DispatchContext): string {
    return (
      `[agentctl] New task ${context.correlationId} from ${context.from}. ` +
      `Read ${context.envelopePath} and follow it exactly, then write your final answer to ${context.responsePath}.`
    );
  }
}

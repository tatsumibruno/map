import { ValidationError } from '../core/errors.js';
import { buildSharedEnvelope } from './envelope.js';
import {
  type DispatchContext,
  type ModelDescriptor,
  type ProviderAdapter,
  type ValidateOptions,
} from './types.js';

/**
 * Claude Code selects thinking depth from the prompt rather than from a
 * discrete API parameter, so no model here advertises reasoning-effort levels
 * and `--reasoning-effort` is rejected for this provider.
 *
 * As with Codex, the list is a convenience: newer ids are accepted once
 * declared via `agentctl project model allow`.
 */
const MODELS: readonly ModelDescriptor[] = [
  { id: 'opus', label: 'Claude Opus (alias)', reasoningEfforts: [] },
  { id: 'sonnet', label: 'Claude Sonnet (alias)', reasoningEfforts: [] },
  { id: 'haiku', label: 'Claude Haiku (alias)', reasoningEfforts: [] },
  { id: 'claude-opus-5', label: 'Claude Opus 5', reasoningEfforts: [] },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', reasoningEfforts: [] },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', reasoningEfforts: [] },
];

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly expectedCommand = 'claude';
  readonly interruptKeys = ['Escape'] as const;
  readonly submitDelayMs = 200;

  listModels(): readonly ModelDescriptor[] {
    return MODELS;
  }

  private known(model: string, options?: ValidateOptions): ModelDescriptor | undefined {
    const found = MODELS.find((m) => m.id === model);
    if (found) return found;
    if (options?.extraModels?.includes(model))
      return { id: model, label: model, reasoningEfforts: [] };
    return undefined;
  }

  supportsReasoningEffort(_model: string, _options?: ValidateOptions): boolean {
    return false;
  }

  listReasoningEfforts(_model: string, _options?: ValidateOptions): readonly string[] {
    return [];
  }

  validateExecutionConfig(
    config: { model: string; reasoningEffort?: string | undefined },
    options?: ValidateOptions,
  ): void {
    if (!this.known(config.model, options)) {
      throw new ValidationError(
        `Model "${config.model}" is not a known Claude Code model`,
        `Known models: ${MODELS.map((m) => m.id).join(', ')}. ` +
          `To use a newer model id: agentctl project model allow claude-code ${config.model}`,
      );
    }
    if (config.reasoningEffort !== undefined) {
      throw new ValidationError(
        'Claude Code does not expose a selectable reasoning effort',
        'Omit --reasoning-effort. Ask for deeper thinking in the task text instead.',
      );
    }
  }

  buildEnvelope(context: DispatchContext): string {
    return buildSharedEnvelope(context, [
      'You are running inside a Claude Code session registered with agentctl.',
      'Use the Write tool to produce the response file; do not echo it into the terminal.',
    ]);
  }

  buildDispatchLine(context: DispatchContext): string {
    return (
      `[agentctl] New task ${context.correlationId} from ${context.from}. ` +
      `Read ${context.envelopePath} and follow it exactly, then write your final answer to ${context.responsePath}.`
    );
  }
}

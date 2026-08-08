import { ValidationError } from '../core/errors.js';
import { type Project, type ProviderId } from '../domain/types.js';
import { ClaudeCodeAdapter } from './claudeCode.js';
import { CodexAdapter } from './codex.js';
import { type ProviderAdapter, type ValidateOptions } from './types.js';

const adapters: ReadonlyMap<ProviderId, ProviderAdapter> = new Map<ProviderId, ProviderAdapter>([
  ['codex', new CodexAdapter()],
  ['claude-code', new ClaudeCodeAdapter()],
]);

export const PROVIDER_IDS: readonly ProviderId[] = [...adapters.keys()];

export function getProvider(id: string): ProviderAdapter {
  const adapter = adapters.get(id as ProviderId);
  if (!adapter) {
    throw new ValidationError(
      `Unknown provider "${id}"`,
      `Supported providers: ${PROVIDER_IDS.join(', ')}.`,
    );
  }
  return adapter;
}

export function listProviders(): readonly ProviderAdapter[] {
  return [...adapters.values()];
}

/** Per-project model allow-list, so a stale catalog never blocks a user. */
export function validateOptionsForProject(
  project: Pick<Project, 'providerModelOverrides'>,
  provider: ProviderId,
): ValidateOptions {
  const extra = project.providerModelOverrides?.[provider];
  return extra && extra.length > 0 ? { extraModels: extra } : {};
}

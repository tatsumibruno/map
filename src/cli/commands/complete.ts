import { Command } from 'commander';

import { GlobalConfigStore } from '../../app/globalConfig.js';
import { Workspace } from '../../app/workspace.js';
import { type ProviderId } from '../../domain/types.js';
import { PROVIDER_IDS, getProvider, listProviders } from '../../providers/registry.js';
import { COMMAND_TREE, TOP_LEVEL } from '../completion/scripts.js';
import { tmux } from '../context.js';

/** Reads `--flag value` out of the tokens the shell has typed so far. */
export function flagValue(tokens: readonly string[], flag: string): string | undefined {
  const index = tokens.lastIndexOf(flag);
  if (index !== -1 && index + 1 < tokens.length) {
    const value = tokens[index + 1];
    if (value !== undefined && !value.startsWith('-')) return value;
  }
  const inline = tokens.find((token) => token.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

/** Subcommand names valid after the already-typed positional tokens. */
export function subcommandsFor(tokens: readonly string[]): string[] {
  const positional = tokens.filter((token) => !token.startsWith('-'));
  for (let depth = Math.min(positional.length, 2); depth >= 1; depth -= 1) {
    const key = positional.slice(0, depth).join(' ');
    const found = COMMAND_TREE[key];
    if (found) return [...found];
  }
  return [...TOP_LEVEL];
}

/** Every option flag declared on the command path the user has typed. */
export function flagsFor(program: Command, tokens: readonly string[]): string[] {
  let current: Command = program;
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    const next: Command | undefined = current.commands.find(
      (candidate) => candidate.name() === token || candidate.aliases().includes(token),
    );
    if (!next) break;
    current = next;
  }
  const flags = new Set<string>();
  for (const command of [program, current]) {
    for (const option of command.options) {
      if (option.long) flags.add(option.long);
    }
  }
  return [...flags].sort();
}

async function agentIds(tokens: readonly string[]): Promise<string[]> {
  try {
    const workspace = await Workspace.resolve(
      {
        project: flagValue(tokens, '--project'),
        path: flagValue(tokens, '--path'),
        cwd: process.cwd(),
      },
      tmux(),
    );
    return (await workspace.agents.list()).map((agent) => agent.id);
  } catch {
    return [];
  }
}

async function modelIds(tokens: readonly string[]): Promise<string[]> {
  const providerId = flagValue(tokens, '--provider');
  const adapters = providerId ? [safeProvider(providerId)] : listProviders();
  const ids = new Set<string>();
  for (const adapter of adapters) {
    if (!adapter) continue;
    for (const model of adapter.listModels()) ids.add(model.id);
  }
  // Project-level allow-listed models complete too.
  try {
    const workspace = await Workspace.resolve(
      {
        project: flagValue(tokens, '--project'),
        path: flagValue(tokens, '--path'),
        cwd: process.cwd(),
      },
      tmux(),
    );
    const overrides = workspace.project.providerModelOverrides ?? {};
    for (const [provider, models] of Object.entries(overrides)) {
      if (providerId && provider !== providerId) continue;
      for (const model of models ?? []) ids.add(model);
    }
  } catch {
    // Completion must never fail loudly.
  }
  return [...ids].sort();
}

function safeProvider(id: string) {
  try {
    return getProvider(id);
  } catch {
    return undefined;
  }
}

async function effortLevels(tokens: readonly string[]): Promise<string[]> {
  const providerId = flagValue(tokens, '--provider');
  const model = flagValue(tokens, '--model');
  const adapters = providerId ? [safeProvider(providerId)] : listProviders();
  const levels = new Set<string>();
  for (const adapter of adapters) {
    if (!adapter) continue;
    if (model) {
      for (const level of adapter.listReasoningEfforts(model)) levels.add(level);
    } else {
      for (const descriptor of adapter.listModels()) {
        for (const level of descriptor.reasoningEfforts) levels.add(level);
      }
    }
  }
  return [...levels];
}

/**
 * Hidden completion backend. Everything is best-effort: on any failure it
 * prints nothing so the shell simply offers no suggestions.
 */
export function completeCommand(program: () => Command): Command {
  return new Command('__complete')
    .argument('<kind>', 'projects|agents|sessions|providers|roles|models|efforts|subcommands|flags')
    .argument('[tokens...]', 'command words typed so far')
    .allowUnknownOption(true)
    .helpOption(false)
    .description('Internal: emit completion candidates')
    .action(async (kind: string, tokens: string[] = []) => {
      const values = await candidates(kind, tokens, program);
      if (values.length > 0) process.stdout.write(`${values.join('\n')}\n`);
    });
}

export async function candidates(
  kind: string,
  tokens: readonly string[],
  program: () => Command,
): Promise<string[]> {
  try {
    switch (kind) {
      case 'projects':
        return (await new GlobalConfigStore().listProjects()).map((p) => p.name);
      case 'agents':
        return agentIds(tokens);
      case 'sessions':
        return (await tmux().listSessions()).map((s) => s.name);
      case 'providers':
        return [...PROVIDER_IDS] as ProviderId[];
      case 'roles':
        return ['coordinator', 'agent'];
      case 'models':
        return modelIds(tokens);
      case 'efforts':
        return effortLevels(tokens);
      case 'subcommands':
        return subcommandsFor(tokens);
      case 'flags':
        return flagsFor(program(), tokens);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

import { Command } from 'commander';

import { ValidationError } from '../../core/errors.js';
import { childrenOf, formatTree } from '../../domain/hierarchy.js';
import { type AgentRole, type ProviderId } from '../../domain/types.js';
import { RunnerSupervisor } from '../../app/runnerSupervisor.js';
import { PROVIDER_IDS } from '../../providers/registry.js';
import { globalOptions, openWorkspace } from '../context.js';
import { keyValues, print, printJson, style, table } from '../output.js';

interface RegisterOptions {
  project?: string;
  role: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  tmux: string;
  parent?: string;
  workdir?: string;
  displayName?: string;
}

export function agentCommand(): Command {
  const agent = new Command('agent').description('Register and manage agents');

  agent
    .command('register')
    .argument('<name>', 'agent identifier, unique inside the project')
    .requiredOption('--role <role>', 'coordinator|agent')
    .requiredOption('--provider <provider>', PROVIDER_IDS.join('|'))
    .requiredOption('--model <model>', 'provider model identifier')
    .requiredOption('--tmux <session>', 'name of an existing, already authenticated tmux session')
    .option('--reasoning-effort <level>', 'reasoning effort, when the provider supports one')
    .option('--parent <agent>', 'parent coordinator (required for --role agent)')
    .option('--workdir <directory>', 'working directory (defaults to the project root)')
    .option('--display-name <name>', 'human-readable label')
    .description('Register an already-authenticated tmux session as an agent')
    .action(async (name: string, options: RegisterOptions, command: Command) => {
      if (options.role !== 'coordinator' && options.role !== 'agent') {
        throw new ValidationError(
          `Invalid --role "${options.role}"`,
          'Valid roles: coordinator, agent.',
        );
      }
      if (!PROVIDER_IDS.includes(options.provider as ProviderId)) {
        throw new ValidationError(
          `Invalid --provider "${options.provider}"`,
          `Valid providers: ${PROVIDER_IDS.join(', ')}.`,
        );
      }

      const workspace = await openWorkspace(command);
      const registered = await workspace.agents.register({
        id: name,
        role: options.role as AgentRole,
        provider: options.provider as ProviderId,
        model: options.model,
        tmuxSession: options.tmux,
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
        ...(options.parent === undefined ? {} : { parentId: options.parent }),
        ...(options.workdir === undefined ? {} : { workingDirectory: options.workdir }),
        ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
      });

      await workspace.events.emit({
        type: 'agent.registered',
        actor: 'cli',
        subject: registered.id,
        data: {
          role: registered.role,
          provider: registered.provider,
          model: registered.model,
          ...(registered.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: registered.reasoningEffort }),
          tmuxSession: registered.tmuxSession,
          ...(registered.parentId === undefined ? {} : { parentId: registered.parentId }),
        },
      });

      if (globalOptions(command).json === true) {
        printJson(registered);
        return;
      }
      print(
        `${style.green('✔')} Registered ${style.bold(registered.id)} in project "${workspace.project.name}"`,
      );
      print(
        keyValues([
          ['role', registered.role],
          ['provider', registered.provider],
          ['model', registered.model],
          ['reasoning effort', registered.reasoningEffort ?? '(not applicable)'],
          ['tmux session', registered.tmuxSession],
          ['parent', registered.parentId ?? '(root)'],
          ['working directory', registered.workingDirectory],
        ]),
      );
      print('');
      print(`Start its runner with: ${style.cyan(`agentctl runner start ${registered.id}`)}`);
    });

  agent
    .command('list')
    .description('List agents in the project as a hierarchy')
    .action(async (_options: unknown, command: Command) => {
      const workspace = await openWorkspace(command);
      const agents = await workspace.agents.list();

      if (globalOptions(command).json === true) {
        printJson(agents);
        return;
      }
      if (agents.length === 0) {
        print('No agents registered. Register one with `agentctl agent register <name> ...`.');
        return;
      }
      print(style.bold(`Project ${workspace.project.name}`));
      for (const line of formatTree(agents, (a) => {
        const flags = [a.role, `${a.provider}/${a.model}`];
        if (a.reasoningEffort) flags.push(`effort=${a.reasoningEffort}`);
        flags.push(`tmux=${a.tmuxSession}`);
        if (!a.enabled) flags.push(style.yellow('disabled'));
        return `${style.bold(a.id)}  ${style.dim(flags.join(' · '))}`;
      })) {
        print(line);
      }
    });

  agent
    .command('status')
    .argument('<agent>', 'agent identifier')
    .description('Show an agent registration, runner state, and recent traffic')
    .action(async (agentId: string, _options: unknown, command: Command) => {
      const workspace = await openWorkspace(command);
      const record = await workspace.agents.get(agentId);
      const status = await workspace.bus.readStatus(agentId);
      const runner = await new RunnerSupervisor(workspace).status(agentId);
      const sessionAlive = await workspace.tmux.hasSession(record.tmuxSession).catch(() => false);
      const history = await workspace.bus.history(agentId);
      const children = childrenOf(await workspace.agents.list(), agentId);

      if (globalOptions(command).json === true) {
        printJson({
          agent: record,
          status: status ?? null,
          runner: runner.record ? { ...runner.record, alive: runner.alive } : null,
          tmuxSessionAlive: sessionAlive,
          children: children.map((c) => c.id),
          messageCount: history.length,
        });
        return;
      }

      print(
        keyValues([
          ['agent', `${record.displayName} (${record.id})`],
          ['role', record.role],
          ['enabled', record.enabled ? style.green('yes') : style.yellow('no')],
          ['provider', `${record.provider}/${record.model}`],
          ['reasoning effort', record.reasoningEffort ?? '(not applicable)'],
          [
            'tmux session',
            `${record.tmuxSession} ${sessionAlive ? style.green('(running)') : style.red('(missing)')}`,
          ],
          ['parent', record.parentId ?? '(root)'],
          ['children', children.length > 0 ? children.map((c) => c.id).join(', ') : '(none)'],
          ['runner state', status?.runnerState ?? 'unknown'],
          ['last heartbeat', status?.lastHeartbeatAt ?? '(never)'],
          [
            'runner process',
            runner.record
              ? `pid ${runner.record.pid} ${runner.alive ? style.green('alive') : style.red('not running')}`
              : '(not started)',
          ],
          ['current task', status?.currentCorrelationId ?? '(none)'],
          ['messages', String(history.length)],
        ]),
      );

      const recent = history.slice(-5);
      if (recent.length > 0) {
        print('');
        print(style.bold('Recent messages'));
        print(
          table(
            ['WHEN', 'TYPE', 'FROM', 'TO', 'CORRELATION'],
            recent.map((m) => [m.createdAt, m.type, m.from, m.to, m.correlationId]),
          ),
        );
      }
    });

  agent
    .command('configure')
    .argument('<agent>', 'agent identifier')
    .option('--model <model>', 'new model identifier')
    .option('--reasoning-effort <level>', 'new reasoning effort')
    .option('--clear-reasoning-effort', 'remove the reasoning effort setting', false)
    .description('Change an agent model or reasoning effort (applies to future tasks only)')
    .action(
      async (
        agentId: string,
        options: { model?: string; reasoningEffort?: string; clearReasoningEffort?: boolean },
        command: Command,
      ) => {
        if (
          options.model === undefined &&
          options.reasoningEffort === undefined &&
          options.clearReasoningEffort !== true
        ) {
          throw new ValidationError(
            'Nothing to change',
            'Pass --model, --reasoning-effort, or --clear-reasoning-effort.',
          );
        }
        const workspace = await openWorkspace(command);
        const { before, after } = await workspace.agents.configure(agentId, {
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort }),
          clearReasoningEffort: options.clearReasoningEffort === true,
        });

        await workspace.events.emit({
          type: 'agent.configured',
          actor: 'cli',
          subject: after.id,
          data: {
            fromModel: before.model,
            toModel: after.model,
            fromReasoningEffort: before.reasoningEffort ?? null,
            toReasoningEffort: after.reasoningEffort ?? null,
          },
        });

        if (globalOptions(command).json === true) {
          printJson(after);
          return;
        }
        print(`${style.green('✔')} Updated ${style.bold(after.id)}`);
        print(
          keyValues([
            ['model', `${before.model} → ${after.model}`],
            [
              'reasoning effort',
              `${before.reasoningEffort ?? '(none)'} → ${after.reasoningEffort ?? '(none)'}`,
            ],
          ]),
        );
        print(
          style.dim('Tasks already in progress keep the configuration they were dispatched with.'),
        );
      },
    );

  for (const [verb, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    agent
      .command(verb)
      .argument('<agent>', 'agent identifier')
      .description(
        `${enabled ? 'Allow' : 'Stop'} the agent ${enabled ? 'to receive' : 'from receiving'} new work`,
      )
      .action(async (agentId: string, _options: unknown, command: Command) => {
        const workspace = await openWorkspace(command);
        const updated = await workspace.agents.setEnabled(agentId, enabled);
        await workspace.events.emit({
          type: enabled ? 'agent.enabled' : 'agent.disabled',
          actor: 'cli',
          subject: agentId,
        });

        if (globalOptions(command).json === true) {
          printJson(updated);
          return;
        }
        print(
          `${style.green('✔')} ${style.bold(agentId)} is now ${enabled ? style.green('enabled') : style.yellow('disabled')}`,
        );
        if (!enabled)
          print(style.dim('Its history stays available; it simply receives no new work.'));
      });
  }

  agent
    .command('remove')
    .argument('<agent>', 'agent identifier')
    .option('--purge-mailbox', 'also delete the mailbox and its history', false)
    .option('--yes', 'skip the confirmation prompt', false)
    .description('Remove an agent registration')
    .action(
      async (
        agentId: string,
        options: { purgeMailbox?: boolean; yes?: boolean },
        command: Command,
      ) => {
        const workspace = await openWorkspace(command);
        const target = await workspace.agents.get(agentId);

        if (options.yes !== true) {
          const confirmed = await confirm(
            `Remove agent "${agentId}" from project "${workspace.project.name}"?` +
              (options.purgeMailbox === true
                ? ' Its mailbox and message history will be deleted permanently.'
                : ' Its mailbox and message history will be kept.'),
          );
          if (!confirmed) {
            print('Aborted.');
            return;
          }
        }

        await new RunnerSupervisor(workspace).stop(agentId).catch(() => false);
        const removed = await workspace.agents.remove(agentId, {
          purgeMailbox: options.purgeMailbox === true,
        });
        await workspace.events.emit({
          type: 'agent.removed',
          actor: 'cli',
          subject: agentId,
          data: { purgedMailbox: options.purgeMailbox === true, tmuxSession: target.tmuxSession },
        });

        if (globalOptions(command).json === true) {
          printJson(removed);
          return;
        }
        print(`${style.green('✔')} Removed ${style.bold(agentId)}`);
        print(
          style.dim(
            `The tmux session "${target.tmuxSession}" was left untouched — agentctl never closes your sessions.`,
          ),
        );
      },
    );

  return agent;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new ValidationError(
      'Refusing to run a destructive command without confirmation',
      'Re-run with --yes when scripting.',
    );
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${style.yellow('?')} ${question} [y/N] `))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

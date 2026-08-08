import { Command } from 'commander';

import { NotFoundError, ValidationError } from '../../core/errors.js';
import { sleep } from '../../core/time.js';
import { isTerminal } from '../../app/taskService.js';
import { getProvider, validateOptionsForProject } from '../../providers/registry.js';
import { globalOptions, openWorkspace } from '../context.js';
import { keyValues, print, printJson, style, table } from '../output.js';

export function taskCommand(): Command {
  const task = new Command('task').description('Assign, watch and cancel tasks');

  task
    .command('assign')
    .argument('<text>', 'the task description')
    .requiredOption('--from <coordinator>', 'sending coordinator')
    .requiredOption('--to <agent>', 'receiving agent')
    .option('--context <ref...>', 'project-relative context references')
    .option('--model <model>', 'override the model for this task only')
    .option('--reasoning-effort <level>', 'override the reasoning effort for this task only')
    .option('--timeout <ms>', 'mark the task timed out after this many milliseconds')
    .option('--watch', 'block until the task reaches a terminal state', false)
    .description('Create a task and deliver it to an agent mailbox')
    .action(
      async (
        text: string,
        options: {
          from: string;
          to: string;
          context?: string[];
          model?: string;
          reasoningEffort?: string;
          timeout?: string;
          watch?: boolean;
        },
        command: Command,
      ) => {
        const workspace = await openWorkspace(command);
        const sender = await workspace.agents.get(options.from);
        const target = await workspace.agents.requireEnabled(options.to);

        if (sender.role !== 'coordinator') {
          throw new ValidationError(
            `"${sender.id}" has role "${sender.role}" and cannot assign tasks`,
            'Only coordinators assign work. Use `agentctl message send` for other message types.',
          );
        }

        // Per-task overrides are validated by the provider adapter, exactly
        // like the agent-level defaults.
        if (options.model !== undefined || options.reasoningEffort !== undefined) {
          getProvider(target.provider).validateExecutionConfig(
            {
              model: options.model ?? target.model,
              ...(options.reasoningEffort === undefined
                ? target.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: target.reasoningEffort }
                : { reasoningEffort: options.reasoningEffort }),
            },
            validateOptionsForProject(workspace.project, target.provider),
          );
        }

        const contextRefs = options.context ?? (await workspace.context.defaultRefs());
        const timeoutMs =
          options.timeout === undefined ? undefined : Number.parseInt(options.timeout, 10);
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          throw new ValidationError(
            `Invalid --timeout "${options.timeout}"`,
            'Pass a positive number of milliseconds.',
          );
        }

        const { task: created } = await workspace.tasks.assign(
          await workspace.agents.index(),
          target,
          {
            from: options.from,
            to: options.to,
            body: text,
            contextRefs,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(options.model === undefined && options.reasoningEffort === undefined
              ? {}
              : {
                  execution: {
                    ...(options.model === undefined ? {} : { model: options.model }),
                    ...(options.reasoningEffort === undefined
                      ? {}
                      : { reasoningEffort: options.reasoningEffort }),
                  },
                }),
          },
        );

        if (globalOptions(command).json === true && options.watch !== true) {
          printJson(created);
          return;
        }

        if (globalOptions(command).json !== true) {
          print(`${style.green('✔')} Assigned task ${style.bold(created.id)} to ${options.to}`);
          print(
            keyValues([
              ['model', created.execution.model],
              ['reasoning effort', created.execution.reasoningEffort ?? '(not applicable)'],
              ['context refs', created.contextRefs?.join(', ') ?? '(none)'],
            ]),
          );
          print('');
          print(`Watch it with: ${style.cyan(`agentctl task watch ${created.id}`)}`);
        }

        if (options.watch === true) await watchTask(command, created.id);
      },
    );

  task
    .command('watch')
    .argument('<correlation-id>', 'task / correlation id')
    .option('--interval <ms>', 'poll interval', '1000')
    .option('--timeout <ms>', 'stop watching after this long')
    .description('Follow a task until it reaches a terminal state')
    .action(
      async (
        correlationId: string,
        options: { interval: string; timeout?: string },
        command: Command,
      ) => {
        await watchTask(command, correlationId, {
          intervalMs: Number.parseInt(options.interval, 10) || 1000,
          ...(options.timeout === undefined
            ? {}
            : { timeoutMs: Number.parseInt(options.timeout, 10) }),
        });
      },
    );

  task
    .command('list')
    .option('--state <state>', 'filter by state')
    .description('List tasks in the project')
    .action(async (options: { state?: string }, command: Command) => {
      const workspace = await openWorkspace(command);
      const all = await workspace.tasks.list();
      const tasks = options.state ? all.filter((t) => t.state === options.state) : all;

      if (globalOptions(command).json === true) {
        printJson(tasks);
        return;
      }
      if (tasks.length === 0) {
        print('No tasks yet.');
        return;
      }
      print(
        table(
          ['ID', 'STATE', 'FROM', 'TO', 'MODEL', 'EFFORT', 'CREATED'],
          tasks.map((t) => [
            t.id,
            colorState(t.state),
            t.from,
            t.to,
            t.execution.model,
            t.execution.reasoningEffort ?? '—',
            t.createdAt,
          ]),
        ),
      );
    });

  task
    .command('cancel')
    .argument('<correlation-id>', 'task / correlation id')
    .description('Ask the executing agent to stop working on a task')
    .action(async (correlationId: string, _options: unknown, command: Command) => {
      const workspace = await openWorkspace(command);
      const target = await workspace.tasks.get(correlationId);
      if (isTerminal(target.state)) {
        throw new ValidationError(
          `Task ${correlationId} already finished with state "${target.state}"`,
        );
      }

      await workspace.bus.send(await workspace.agents.index(), {
        from: target.from,
        to: target.to,
        type: 'cancel',
        body: `Cancel task ${correlationId}.`,
        correlationId,
      });

      if (globalOptions(command).json === true) {
        printJson({ correlationId, requested: true });
        return;
      }
      print(`${style.green('✔')} Cancellation requested for ${style.bold(correlationId)}`);
      print(style.dim('The runner interrupts the session on its next poll.'));
    });

  return task;
}

async function watchTask(
  command: Command,
  correlationId: string,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const workspace = await openWorkspace(command);
  const intervalMs = options.intervalMs ?? 1000;
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  const json = globalOptions(command).json === true;

  const initial = await workspace.tasks.find(correlationId);
  if (!initial) {
    throw new NotFoundError(
      `Task "${correlationId}" not found`,
      'Check the correlation id printed by `agentctl task assign`.',
    );
  }

  let lastState = '';
  for (;;) {
    const current = await workspace.tasks.get(correlationId);
    if (current.state !== lastState) {
      lastState = current.state;
      if (!json) print(`${new Date().toISOString()}  ${colorState(current.state)}`);
    }

    if (isTerminal(current.state)) {
      if (json) {
        printJson(current);
        return;
      }
      print('');
      print(style.bold(`Task ${current.id} — ${colorState(current.state)}`));
      print(
        keyValues([
          ['from → to', `${current.from} → ${current.to}`],
          ['model', current.execution.model],
          ['reasoning effort', current.execution.reasoningEffort ?? '(not applicable)'],
          ['attempts', String(current.attempts)],
          ['completed at', current.completedAt ?? '—'],
        ]),
      );
      if (current.result) {
        print('');
        print(style.bold('Result'));
        print(current.result);
      }
      if (current.error) {
        print('');
        print(style.red(`Error: ${current.error}`));
      }
      process.exitCode = current.state === 'completed' ? 0 : 6;
      return;
    }

    if (deadline !== undefined && Date.now() > deadline) {
      if (json) printJson({ ...current, watchTimedOut: true });
      else print(style.yellow(`Stopped watching; task is still "${current.state}".`));
      process.exitCode = 7;
      return;
    }

    await sleep(intervalMs);
  }
}

function colorState(state: string): string {
  if (state === 'completed') return style.green(state);
  if (state === 'failed' || state === 'timed_out') return style.red(state);
  if (state === 'cancelled') return style.yellow(state);
  return style.cyan(state);
}

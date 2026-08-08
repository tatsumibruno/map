import { Command } from 'commander';

import { RunnerSupervisor } from '../../app/runnerSupervisor.js';
import { AgentWorker } from '../../runner/agentWorker.js';
import { CoordinatorProcess } from '../../runner/coordinator.js';
import { globalOptions, openWorkspace } from '../context.js';
import { keyValues, print, printJson, style, table } from '../output.js';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Ctrl-C / SIGTERM aborts the loop so the runner can write a final status. */
function abortOnSignals(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
}

export function runnerCommand(): Command {
  const runner = new Command('runner').description('Start and stop agent runners');

  runner
    .command('start')
    .argument('<agent>', 'agent identifier')
    .option('--poll-interval <ms>', 'mailbox poll interval', '1500')
    .option('--response-timeout <ms>', 'give up on a task after this long')
    .option('--force', 'replace a runner that is already running', false)
    .description('Start a background runner process for an agent')
    .action(
      async (
        agentId: string,
        options: { pollInterval: string; responseTimeout?: string; force?: boolean },
        command: Command,
      ) => {
        const workspace = await openWorkspace(command);
        const supervisor = new RunnerSupervisor(workspace);
        const record = await supervisor.start(agentId, {
          pollIntervalMs: parsePositiveInt(options.pollInterval, 1500),
          ...(options.responseTimeout === undefined
            ? {}
            : { responseTimeoutMs: parsePositiveInt(options.responseTimeout, 900_000) }),
          force: options.force === true,
        });

        if (globalOptions(command).json === true) {
          printJson(record);
          return;
        }
        print(`${style.green('✔')} Runner for ${style.bold(agentId)} started (pid ${record.pid})`);
        print(style.dim(`log: ${record.logPath}`));
      },
    );

  runner
    .command('stop')
    .argument('<agent>', 'agent identifier')
    .description('Stop the background runner for an agent')
    .action(async (agentId: string, _options: unknown, command: Command) => {
      const workspace = await openWorkspace(command);
      const stopped = await new RunnerSupervisor(workspace).stop(agentId);

      if (globalOptions(command).json === true) {
        printJson({ agentId, stopped });
        return;
      }
      print(
        stopped
          ? `${style.green('✔')} Runner for ${style.bold(agentId)} stopped`
          : `No runner was registered for "${agentId}".`,
      );
    });

  runner
    .command('status')
    .argument('[agent]', 'agent identifier; omit to list every runner')
    .description('Show runner processes and their heartbeats')
    .action(async (agentId: string | undefined, _options: unknown, command: Command) => {
      const workspace = await openWorkspace(command);
      const supervisor = new RunnerSupervisor(workspace);
      const ids = agentId ? [agentId] : (await workspace.agents.list()).map((a) => a.id);

      const rows = [];
      for (const id of ids) {
        const { record, alive } = await supervisor.status(id);
        const status = await workspace.bus.readStatus(id);
        rows.push({
          agentId: id,
          pid: record?.pid ?? null,
          alive,
          state: status?.runnerState ?? 'unknown',
          lastHeartbeatAt: status?.lastHeartbeatAt ?? null,
          currentCorrelationId: status?.currentCorrelationId ?? null,
        });
      }

      if (globalOptions(command).json === true) {
        printJson(rows);
        return;
      }
      if (rows.length === 0) {
        print('No agents registered.');
        return;
      }
      print(
        table(
          ['AGENT', 'PID', 'PROCESS', 'STATE', 'LAST HEARTBEAT', 'TASK'],
          rows.map((r) => [
            r.agentId,
            r.pid === null ? '—' : String(r.pid),
            r.alive ? style.green('alive') : style.dim('stopped'),
            r.state,
            r.lastHeartbeatAt ?? '—',
            r.currentCorrelationId ?? '—',
          ]),
        ),
      );
    });

  return runner;
}

/**
 * The foreground worker. `runner start` re-execs the CLI into this command;
 * running it directly is the supported way to drive an agent inside its own
 * container.
 */
export function agentWorkerCommand(): Command {
  const worker = new Command('agent-worker').description('Run an agent worker in the foreground');

  worker
    .command('start')
    .argument('<agent>', 'agent identifier')
    .option('--poll-interval <ms>', 'mailbox poll interval', '1500')
    .option('--response-timeout <ms>', 'give up on a task after this long', '900000')
    .option('--once', 'run a single poll cycle and exit', false)
    .description('Poll one mailbox and drive the agent tmux session')
    .action(
      async (
        agentId: string,
        options: { pollInterval: string; responseTimeout: string; once?: boolean },
        command: Command,
      ) => {
        const workspace = await openWorkspace(command);
        await new AgentWorker(workspace, agentId, {
          pollIntervalMs: parsePositiveInt(options.pollInterval, 1500),
          responseTimeoutMs: parsePositiveInt(options.responseTimeout, 900_000),
          once: options.once === true,
          signal: abortOnSignals(),
        }).run();
      },
    );

  return worker;
}

export function coordinatorCommand(): Command {
  const coordinator = new Command('coordinator').description('Run a coordinator process');

  coordinator
    .command('start')
    .option('--poll-interval <ms>', 'state poll interval', '2000')
    .option('--supervise-children', 'start runners for child agents that have none', false)
    .option('--no-enforce-timeouts', 'do not expire tasks that exceeded their timeout')
    .option('--once', 'run a single cycle and exit', false)
    .description('Consolidate child results and keep the hierarchy running')
    .action(
      async (
        options: {
          pollInterval: string;
          superviseChildren?: boolean;
          enforceTimeouts?: boolean;
          once?: boolean;
        },
        command: Command,
      ) => {
        const workspace = await openWorkspace(command);
        if (globalOptions(command).json !== true) {
          print(
            keyValues([
              ['project', workspace.project.name],
              ['state directory', workspace.paths.state],
              ['poll interval', `${options.pollInterval}ms`],
              ['supervising children', options.superviseChildren === true ? 'yes' : 'no'],
            ]),
          );
          print('');
        }
        await new CoordinatorProcess(workspace, {
          pollIntervalMs: parsePositiveInt(options.pollInterval, 2000),
          superviseChildren: options.superviseChildren === true,
          enforceTimeouts: options.enforceTimeouts !== false,
          once: options.once === true,
          signal: abortOnSignals(),
        }).run();
      },
    );

  return coordinator;
}

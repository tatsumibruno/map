import { Command } from 'commander';

import { runDoctor } from '../../app/doctor.js';
import { type AgentEvent } from '../../domain/types.js';
import { sleep } from '../../core/time.js';
import { ValidationError } from '../../core/errors.js';
import { completionScript, installInstructions, type Shell } from '../completion/scripts.js';
import { globalOptions, openWorkspace, selectorFrom, tmux } from '../context.js';
import { print, printErr, printJson, statusIcon, style, table, truncate } from '../output.js';

export function sessionCommand(): Command {
  const session = new Command('session').description('Inspect tmux sessions');

  session
    .command('list')
    .description('List running tmux sessions and which agent uses each one')
    .action(async (_options: unknown, command: Command) => {
      const sessions = await tmux().listSessions();

      // The session list is useful even without a project selected.
      let usage = new Map<string, string>();
      try {
        const workspace = await openWorkspace(command);
        usage = new Map((await workspace.agents.list()).map((a) => [a.tmuxSession, a.id]));
      } catch {
        // No project in scope; show the raw session list.
      }

      if (globalOptions(command).json === true) {
        printJson(sessions.map((s) => ({ ...s, agentId: usage.get(s.name) ?? null })));
        return;
      }
      if (sessions.length === 0) {
        print('No tmux sessions are running.');
        print(style.dim('Create one and sign in first:  tmux new -s coord'));
        return;
      }
      print(
        table(
          ['SESSION', 'WINDOWS', 'ATTACHED', 'AGENT'],
          sessions.map((s) => [
            s.name,
            String(s.windows),
            s.attached ? 'yes' : 'no',
            usage.get(s.name) ?? style.dim('(unregistered)'),
          ]),
        ),
      );
    });

  return session;
}

export function eventsCommand(): Command {
  return new Command('events')
    .option('--follow', 'stream new events as they are appended', false)
    .option('--limit <n>', 'show at most this many past events', '30')
    .option('--type <type>', 'filter by event type prefix, e.g. "task."')
    .option('--correlation-id <id>', 'only events for one task')
    .description('Read the append-only project event log')
    .action(
      async (
        options: { follow?: boolean; limit: string; type?: string; correlationId?: string },
        command: Command,
      ) => {
        const workspace = await openWorkspace(command);
        const json = globalOptions(command).json === true;
        const limit = Number.parseInt(options.limit, 10) || 30;

        const matches = (event: AgentEvent) =>
          (options.type === undefined || event.type.startsWith(options.type)) &&
          (options.correlationId === undefined || event.correlationId === options.correlationId);

        const all = (await workspace.events.readAll()).filter(matches);
        const initial = all.slice(-limit);

        if (json && options.follow !== true) {
          printJson(initial);
          return;
        }
        for (const event of initial) print(formatEvent(event));

        if (options.follow !== true) return;

        let offset = (await workspace.events.readFrom(0)).offset;
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        while (!controller.signal.aborted) {
          const { entries, offset: next } = await workspace.events.readFrom(offset);
          offset = next;
          for (const event of entries.filter(matches)) {
            if (json) printJson(event);
            else print(formatEvent(event));
          }
          await sleep(500, controller.signal);
        }
      },
    );
}

function formatEvent(event: AgentEvent): string {
  const target = event.subject ? ` → ${event.subject}` : '';
  const correlation = event.correlationId ? style.dim(` [${event.correlationId}]`) : '';
  const data =
    event.data && Object.keys(event.data).length > 0
      ? style.dim(` ${truncate(JSON.stringify(event.data), 100)}`)
      : '';
  return `${style.dim(event.at)}  ${style.cyan(event.type.padEnd(20))} ${event.actor}${target}${correlation}${data}`;
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Validate the installation, state directory, sessions and runners')
    .action(async (_options: unknown, command: Command) => {
      const report = await runDoctor(selectorFrom(globalOptions(command)), tmux());

      if (globalOptions(command).json === true) {
        printJson(report);
      } else {
        for (const check of report.checks) {
          print(`${statusIcon(check.status)} ${style.bold(check.name.padEnd(24))} ${check.detail}`);
          if (check.hint) print(`  ${style.dim(`↳ ${check.hint}`)}`);
        }
        print('');
        print(
          report.ok
            ? style.green('All critical checks passed.')
            : style.red('Some checks failed; see the hints above.'),
        );
      }
      if (!report.ok) process.exitCode = 8;
    });
}

export function completionCommand(binName: string): Command {
  return new Command('completion')
    .argument('<shell>', 'bash|zsh|fish')
    .option('--instructions', 'print installation instructions instead of the script', false)
    .description('Generate a shell completion script')
    .action((shell: string, options: { instructions?: boolean }) => {
      if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
        throw new ValidationError(
          `Unsupported shell "${shell}"`,
          'Supported shells: bash, zsh, fish.',
        );
      }
      if (options.instructions === true) {
        print(installInstructions(shell as Shell, binName));
        return;
      }
      process.stdout.write(completionScript(shell as Shell, binName));
      printErr('');
      printErr(style.dim(`# Install with: ${binName} completion ${shell} --instructions`));
    });
}

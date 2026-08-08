import { Command } from 'commander';

import { isAgentctlError } from '../core/errors.js';
import { agentCommand } from './commands/agent.js';
import { completeCommand } from './commands/complete.js';
import { messageCommand } from './commands/message.js';
import {
  completionCommand,
  doctorCommand,
  eventsCommand,
  sessionCommand,
} from './commands/misc.js';
import { projectCommand } from './commands/project.js';
import { agentWorkerCommand, coordinatorCommand, runnerCommand } from './commands/runner.js';
import { taskCommand } from './commands/task.js';
import { installStreamErrorHandlers, printErr, style } from './output.js';

export const BIN_NAME = 'agentctl';
export const VERSION = '0.1.0';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name(BIN_NAME)
    .description(
      'Orchestrate AI agents that are already authenticated in tmux sessions.\n' +
        'agentctl never handles credentials: you sign in yourself, it coordinates the work.',
    )
    .version(VERSION, '-v, --version')
    .option('--project <name>', 'project to operate on')
    .option('--path <directory>', 'project root, bypassing the project registry')
    .option('--json', 'emit machine-readable JSON', false)
    .showHelpAfterError('(run with --help for usage)');

  program.addCommand(projectCommand());
  program.addCommand(sessionCommand());
  program.addCommand(agentCommand());
  program.addCommand(agentWorkerCommand());
  program.addCommand(messageCommand());
  program.addCommand(taskCommand());
  program.addCommand(eventsCommand());
  program.addCommand(runnerCommand());
  program.addCommand(coordinatorCommand());
  program.addCommand(doctorCommand());
  program.addCommand(completionCommand(BIN_NAME));
  program.addCommand(
    completeCommand(() => program),
    { hidden: true },
  );

  program.addHelpText(
    'after',
    `
Quick start:
  1. tmux new -s coord      # then sign in to your AI client manually
  2. ${BIN_NAME} project init product --path ./product
  3. ${BIN_NAME} agent register coordinator --role coordinator --provider codex \\
       --model gpt-5-codex --reasoning-effort medium --tmux coord
  4. ${BIN_NAME} runner start coordinator
  5. ${BIN_NAME} task assign --from coordinator --to researcher "..."
`,
  );

  propagateGlobalOptions(program);
  return program;
}

/**
 * Commander only parses root options before the subcommand name, but the
 * documented usage puts them after (`agent register x --project product`).
 * Re-declaring them on every subcommand accepts both spellings; they are
 * declared without defaults so an unset child option cannot shadow the root
 * value in `optsWithGlobals()`.
 */
function propagateGlobalOptions(program: Command): void {
  const inherited = [
    ['--project <name>', 'project to operate on'],
    ['--path <directory>', 'project root, bypassing the project registry'],
    ['--json', 'emit machine-readable JSON'],
  ] as const;

  const visit = (command: Command): void => {
    for (const child of command.commands) {
      if (child.name() === '__complete') continue;
      const existing = new Set(child.options.map((option) => option.long));
      for (const [flags, description] of inherited) {
        const long = flags.split(' ')[0];
        if (long !== undefined && !existing.has(long)) child.option(flags, description);
      }
      visit(child);
    }
  };
  visit(program);
}

export async function run(argv: readonly string[] = process.argv): Promise<number> {
  installStreamErrorHandlers();
  const program = buildProgram();
  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    if (isAgentctlError(error)) {
      printErr(`${style.red('error')} ${error.message}`);
      if (error.hint) printErr(`${style.dim(`  ↳ ${error.hint}`)}`);
      return error.exitCode;
    }
    if (isCommanderExit(error)) {
      return error.exitCode;
    }
    printErr(`${style.red('error')} ${error instanceof Error ? error.message : String(error)}`);
    if (process.env['AGENTCTL_DEBUG'] === '1' && error instanceof Error && error.stack) {
      printErr(style.dim(error.stack));
    } else {
      printErr(style.dim('  ↳ Set AGENTCTL_DEBUG=1 for a stack trace.'));
    }
    return 1;
  }
}

interface CommanderExit {
  code: string;
  exitCode: number;
}

function isCommanderExit(error: unknown): error is CommanderExit {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<CommanderExit>;
  return (
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('commander.') &&
    typeof candidate.exitCode === 'number'
  );
}

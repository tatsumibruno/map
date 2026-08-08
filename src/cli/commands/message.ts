import { Command } from 'commander';

import { ValidationError } from '../../core/errors.js';
import { type MessageType } from '../../domain/types.js';
import { globalOptions, openWorkspace } from '../context.js';
import { print, printJson, style, table, truncate } from '../output.js';

const TYPES: readonly MessageType[] = [
  'task',
  'result',
  'question',
  'status',
  'error',
  'cancel',
  'ack',
];

export function messageCommand(): Command {
  const message = new Command('message').description('Send and inspect messages');

  message
    .command('send')
    .requiredOption('--from <agent>', 'sender agent id')
    .requiredOption('--to <agent>', 'recipient agent id')
    .requiredOption('--type <type>', TYPES.join('|'))
    .requiredOption('--body <text>', 'message body')
    .option('--correlation-id <id>', 'attach the message to an existing task')
    .option('--context <ref...>', 'project-relative context references')
    .description('Send a message from one agent to another')
    .action(
      async (
        options: {
          from: string;
          to: string;
          type: string;
          body: string;
          correlationId?: string;
          context?: string[];
        },
        command: Command,
      ) => {
        if (!TYPES.includes(options.type as MessageType)) {
          throw new ValidationError(
            `Invalid --type "${options.type}"`,
            `Valid types: ${TYPES.join(', ')}.`,
          );
        }

        const workspace = await openWorkspace(command);
        // Both parties must exist; `requireEnabled` additionally refuses work
        // addressed at a disabled agent.
        await workspace.agents.get(options.from);
        if (options.type === 'task') await workspace.agents.requireEnabled(options.to);
        else await workspace.agents.get(options.to);

        const sent = await workspace.bus.send(await workspace.agents.index(), {
          from: options.from,
          to: options.to,
          type: options.type as MessageType,
          body: options.body,
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          ...(options.context === undefined ? {} : { contextRefs: options.context }),
        });

        if (globalOptions(command).json === true) {
          printJson(sent);
          return;
        }
        print(`${style.green('✔')} Sent ${sent.type} ${style.bold(sent.id)} to ${options.to}`);
        print(style.dim(`correlation id: ${sent.correlationId}`));
      },
    );

  message
    .command('list')
    .argument('<agent>', 'agent whose mailbox to read')
    .option('--box <box>', 'inbox|outbox|all', 'all')
    .option('--limit <n>', 'show at most this many messages', '20')
    .description('List messages in an agent mailbox')
    .action(async (agentId: string, options: { box: string; limit: string }, command: Command) => {
      const workspace = await openWorkspace(command);
      await workspace.agents.get(agentId);

      const messages =
        options.box === 'inbox'
          ? await workspace.bus.readInbox(agentId)
          : options.box === 'outbox'
            ? await workspace.bus.readOutbox(agentId)
            : await workspace.bus.history(agentId);

      const limit = Number.parseInt(options.limit, 10);
      const shown = Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages;

      if (globalOptions(command).json === true) {
        printJson(shown);
        return;
      }
      if (shown.length === 0) {
        print(`No messages for "${agentId}".`);
        return;
      }
      print(
        table(
          ['WHEN', 'TYPE', 'FROM', 'TO', 'CORRELATION', 'BODY'],
          shown.map((m) => [
            m.createdAt,
            m.type,
            m.from,
            m.to,
            m.correlationId,
            truncate(m.body, 60),
          ]),
        ),
      );
    });

  return message;
}

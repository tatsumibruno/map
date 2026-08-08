import { newMessageId, newTaskId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { assertCanSendMessage, type AgentIndex } from '../domain/hierarchy.js';
import { mailboxCursorSchema, mailboxStatusSchema, messageSchema } from '../domain/schemas.js';
import {
  type ExecutionConfig,
  type MailboxCursor,
  type MailboxStatus,
  type Message,
  type MessageType,
  type Project,
  type RunnerState,
} from '../domain/types.js';
import { ensureDir, readJsonFileIfExists, writeJsonAtomic } from '../infra/fs/atomic.js';
import { appendJsonl, readAllJsonl, readJsonlFrom } from '../infra/fs/jsonl.js';
import { mailboxPaths, projectPaths, type ProjectPaths } from '../infra/fs/paths.js';
import { type EventLog } from './eventLog.js';

export interface SendMessageInput {
  from: string;
  to: string;
  type: MessageType;
  body: string;
  correlationId?: string;
  contextRefs?: readonly string[];
  execution?: ExecutionConfig;
  meta?: Record<string, string | number | boolean>;
}

/**
 * The message bus is the only writer of mailbox files. Everything it does is
 * append-only except `status.json` and `cursor.json`, which are current-state
 * views written atomically.
 */
export class MessageBus {
  private readonly paths: ProjectPaths;

  constructor(
    private readonly project: Project,
    private readonly events: EventLog,
  ) {
    this.paths = projectPaths(project.rootPath);
  }

  /**
   * Appends to the recipient's inbox and the sender's outbox. Authorization is
   * checked against the hierarchy first, so a message can never cross a
   * project boundary or skip a coordination level.
   */
  async send(index: AgentIndex, input: SendMessageInput): Promise<Message> {
    assertCanSendMessage(index, input.from, input.to);

    const message: Message = {
      id: newMessageId(),
      correlationId: input.correlationId ?? newTaskId(),
      from: input.from,
      to: input.to,
      type: input.type,
      body: input.body,
      ...(input.contextRefs && input.contextRefs.length > 0
        ? { contextRefs: [...input.contextRefs] }
        : {}),
      createdAt: nowIso(),
      ...(input.execution === undefined ? {} : { execution: input.execution }),
      ...(input.meta === undefined ? {} : { meta: input.meta }),
    };

    await this.appendRaw(message);
    return message;
  }

  /**
   * Appends a pre-built message without re-checking the hierarchy. Used by the
   * runner to publish results the worker already authorized.
   */
  async appendRaw(message: Message): Promise<Message> {
    const validated = messageSchema.parse(message);
    const toMailbox = mailboxPaths(this.project.rootPath, validated.to);
    const fromMailbox = mailboxPaths(this.project.rootPath, validated.from);
    await ensureDir(toMailbox.dir);
    await ensureDir(fromMailbox.dir);

    await appendJsonl(toMailbox.inbox, this.paths.locksDir, validated, `mbx-${validated.to}-inbox`);
    if (validated.from !== validated.to) {
      await appendJsonl(
        fromMailbox.outbox,
        this.paths.locksDir,
        validated,
        `mbx-${validated.from}-outbox`,
      );
    }

    await this.events.emit({
      type: 'message.sent',
      actor: validated.from,
      subject: validated.to,
      correlationId: validated.correlationId,
      data: { messageId: validated.id, messageType: validated.type, bytes: validated.body.length },
    });

    return validated;
  }

  async readInbox(agentId: string): Promise<Message[]> {
    return readAllJsonl(mailboxPaths(this.project.rootPath, agentId).inbox, messageSchema);
  }

  async readOutbox(agentId: string): Promise<Message[]> {
    return readAllJsonl(mailboxPaths(this.project.rootPath, agentId).outbox, messageSchema);
  }

  /** Reads new inbox entries starting at the persisted cursor offset. */
  async readInboxFromCursor(agentId: string): Promise<{ messages: Message[]; offset: number }> {
    const cursor = await this.readCursor(agentId);
    const { entries, offset } = await readJsonlFrom(
      mailboxPaths(this.project.rootPath, agentId).inbox,
      messageSchema,
      cursor?.offset ?? 0,
    );
    return { messages: entries, offset };
  }

  async readCursor(agentId: string): Promise<MailboxCursor | undefined> {
    return readJsonFileIfExists(
      mailboxPaths(this.project.rootPath, agentId).cursor,
      mailboxCursorSchema,
    );
  }

  async writeCursor(agentId: string, offset: number, lastMessageId?: string): Promise<void> {
    const cursor: MailboxCursor = {
      agentId,
      offset,
      ...(lastMessageId === undefined ? {} : { lastMessageId }),
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(mailboxPaths(this.project.rootPath, agentId).cursor, cursor);
  }

  async readStatus(agentId: string): Promise<MailboxStatus | undefined> {
    return readJsonFileIfExists(
      mailboxPaths(this.project.rootPath, agentId).status,
      mailboxStatusSchema,
    );
  }

  async writeStatus(
    agentId: string,
    state: RunnerState,
    extra: { correlationId?: string; pid?: number; detail?: string } = {},
  ): Promise<MailboxStatus> {
    const status: MailboxStatus = {
      agentId,
      runnerState: state,
      lastHeartbeatAt: nowIso(),
      ...(extra.correlationId === undefined ? {} : { currentCorrelationId: extra.correlationId }),
      ...(extra.pid === undefined ? {} : { pid: extra.pid }),
      ...(extra.detail === undefined ? {} : { detail: extra.detail.slice(0, 2000) }),
      updatedAt: nowIso(),
    };
    const mailbox = mailboxPaths(this.project.rootPath, agentId);
    await ensureDir(mailbox.dir);
    await writeJsonAtomic(mailbox.status, status);
    return status;
  }

  /** All messages addressed to or sent by `agentId`, ordered by creation. */
  async history(agentId: string): Promise<Message[]> {
    const [inbox, outbox] = await Promise.all([this.readInbox(agentId), this.readOutbox(agentId)]);
    const seen = new Set<string>();
    return [...inbox, ...outbox]
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

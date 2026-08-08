/**
 * Domain types. This module is pure: it must not import anything from
 * `infra/` or `cli/`, and must not touch the filesystem or child processes.
 */

export const SCHEMA_VERSION = 1;

export type AgentRole = 'coordinator' | 'agent';

export type ProviderId = 'codex' | 'claude-code';

export type TransportId = 'tmux';

export type MessageType = 'task' | 'result' | 'question' | 'status' | 'error' | 'cancel' | 'ack';

export type RunnerState = 'starting' | 'idle' | 'busy' | 'waiting_input' | 'error' | 'stopped';

export type TaskState =
  'pending' | 'dispatched' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  schemaVersion: number;
  /** Extra model identifiers the user declared as valid for a provider. */
  providerModelOverrides?: Partial<Record<ProviderId, string[]>> | undefined;
}

/**
 * The provider configuration effectively used to execute one unit of work.
 * Snapshotted onto every task so later `agent configure` calls cannot rewrite
 * the history of work already in flight.
 */
export interface ExecutionConfig {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string | undefined;
}

export interface Agent {
  id: string;
  displayName: string;
  role: AgentRole;
  provider: ProviderId;
  model: string;
  reasoningEffort?: string | undefined;
  transport: TransportId;
  tmuxSession: string;
  parentId?: string | undefined;
  projectId: string;
  workingDirectory: string;
  registeredAt: string;
  updatedAt?: string | undefined;
  enabled: boolean;
}

export interface Message {
  id: string;
  correlationId: string;
  from: string;
  to: string;
  type: MessageType;
  body: string;
  contextRefs?: string[] | undefined;
  createdAt: string;
  /** Present on task messages: the config snapshot used for dispatch. */
  execution?: ExecutionConfig | undefined;
  /** Free-form, non-secret annotations (exit status, durations, ...). */
  meta?: Record<string, string | number | boolean> | undefined;
}

export interface MailboxStatus {
  agentId: string;
  runnerState: RunnerState;
  lastHeartbeatAt: string;
  currentCorrelationId?: string | undefined;
  pid?: number | undefined;
  detail?: string | undefined;
  updatedAt: string;
}

export interface MailboxCursor {
  agentId: string;
  /** Byte offset consumed from inbox.jsonl. */
  offset: number;
  lastMessageId?: string | undefined;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  from: string;
  to: string;
  body: string;
  state: TaskState;
  execution: ExecutionConfig;
  contextRefs?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string | undefined;
  completedAt?: string | undefined;
  timeoutMs?: number | undefined;
  attempts: number;
  result?: string | undefined;
  error?: string | undefined;
}

export type EventType =
  | 'project.created'
  | 'project.context.added'
  | 'agent.registered'
  | 'agent.configured'
  | 'agent.enabled'
  | 'agent.disabled'
  | 'agent.removed'
  | 'message.sent'
  | 'message.received'
  | 'task.created'
  | 'task.dispatched'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.timed_out'
  | 'runner.started'
  | 'runner.heartbeat'
  | 'runner.state'
  | 'runner.stopped'
  | 'runner.error';

export interface AgentEvent {
  id: string;
  type: EventType;
  projectId: string;
  actor: string;
  subject?: string | undefined;
  correlationId?: string | undefined;
  at: string;
  data?: Record<string, unknown> | undefined;
}

export interface RunnerRecord {
  agentId: string;
  pid: number;
  startedAt: string;
  logPath: string;
  pollIntervalMs: number;
  /** How the runner process is hosted: a plain detached child, or a tmux session. */
  host: 'process' | 'tmux';
  tmuxSession?: string | undefined;
}

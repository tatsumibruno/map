import { z } from 'zod';

import { SCHEMA_VERSION } from './types.js';

/**
 * Identifiers double as directory names, so they are deliberately narrow:
 * no path separators, no leading dots, no shell metacharacters.
 */
export const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
  )
  .refine((value) => value !== '.' && value !== '..', 'must not be "." or ".."');

/**
 * tmux session names are validated against a positive allow-list rather than a
 * deny-list: tmux treats ":" and "." as target separators, and anything with
 * whitespace, control characters or shell metacharacters has no business being
 * passed to a subprocess.
 */
export const tmuxSessionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_@%+=,-]*$/,
    'must start with a letter or digit and use only letters, digits and "_ - @ % + = ,"',
  );

export const providerIdSchema = z.enum(['codex', 'claude-code']);
export const agentRoleSchema = z.enum(['coordinator', 'agent']);
export const transportSchema = z.enum(['tmux']);

export const messageTypeSchema = z.enum([
  'task',
  'result',
  'question',
  'status',
  'error',
  'cancel',
  'ack',
]);

export const runnerStateSchema = z.enum([
  'starting',
  'idle',
  'busy',
  'waiting_input',
  'error',
  'stopped',
]);

export const taskStateSchema = z.enum([
  'pending',
  'dispatched',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export const isoDateSchema = z.string().datetime({ offset: true });

export const executionConfigSchema = z.object({
  provider: providerIdSchema,
  model: z.string().min(1).max(200),
  reasoningEffort: z.string().min(1).max(64).optional(),
});

export const projectSchema = z.object({
  id: identifierSchema,
  name: identifierSchema,
  rootPath: z.string().min(1),
  createdAt: isoDateSchema,
  schemaVersion: z.number().int().positive().max(SCHEMA_VERSION),
  providerModelOverrides: z.record(providerIdSchema, z.array(z.string().min(1))).optional(),
});

/** tmux pane ids look like `%7`: a `%` followed by the server-wide counter. */
export const tmuxPaneIdSchema = z
  .string()
  .regex(/^%\d+$/, 'must look like a tmux pane id, e.g. "%7"');

export const tmuxPaneRefSchema = z.object({
  paneId: tmuxPaneIdSchema,
  windowIndex: z.number().int().nonnegative(),
  paneIndex: z.number().int().nonnegative(),
  resolvedAt: isoDateSchema,
});

export const agentSchema = z.object({
  id: identifierSchema,
  displayName: z.string().min(1).max(200),
  role: agentRoleSchema,
  provider: providerIdSchema,
  model: z.string().min(1).max(200),
  reasoningEffort: z.string().min(1).max(64).optional(),
  transport: transportSchema,
  tmuxSession: tmuxSessionSchema,
  tmuxPane: tmuxPaneRefSchema.optional(),
  parentId: identifierSchema.optional(),
  projectId: identifierSchema,
  workingDirectory: z.string().min(1),
  registeredAt: isoDateSchema,
  updatedAt: isoDateSchema.optional(),
  enabled: z.boolean(),
});

export const messageSchema = z.object({
  id: z.string().min(1).max(128),
  correlationId: z.string().min(1).max(128),
  from: identifierSchema,
  to: identifierSchema,
  type: messageTypeSchema,
  body: z.string(),
  contextRefs: z.array(z.string().min(1)).optional(),
  createdAt: isoDateSchema,
  execution: executionConfigSchema.optional(),
  meta: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const mailboxStatusSchema = z.object({
  agentId: identifierSchema,
  runnerState: runnerStateSchema,
  lastHeartbeatAt: isoDateSchema,
  currentCorrelationId: z.string().min(1).max(128).optional(),
  pid: z.number().int().positive().optional(),
  detail: z.string().max(2000).optional(),
  updatedAt: isoDateSchema,
});

export const mailboxCursorSchema = z.object({
  agentId: identifierSchema,
  offset: z.number().int().nonnegative(),
  lastMessageId: z.string().min(1).max(128).optional(),
  updatedAt: isoDateSchema,
});

export const deliveryTelemetrySchema = z.object({
  paneId: tmuxPaneIdSchema,
  resolvedVia: z.enum(['pane-id', 'qualified-fallback', 'rediscovered']),
  queuedAt: isoDateSchema,
  pastedAt: isoDateSchema.optional(),
  submittedAt: isoDateSchema.optional(),
  lastError: z.string().optional(),
  paneTail: z.string().optional(),
});

export const taskSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: identifierSchema,
  from: identifierSchema,
  to: identifierSchema,
  body: z.string(),
  state: taskStateSchema,
  execution: executionConfigSchema,
  contextRefs: z.array(z.string().min(1)).optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  dispatchedAt: isoDateSchema.optional(),
  completedAt: isoDateSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  attempts: z.number().int().nonnegative(),
  result: z.string().optional(),
  error: z.string().optional(),
  delivery: deliveryTelemetrySchema.optional(),
});

export const eventTypeSchema = z.enum([
  'project.created',
  'project.context.added',
  'agent.registered',
  'agent.configured',
  'agent.enabled',
  'agent.disabled',
  'agent.removed',
  'message.sent',
  'message.received',
  'task.created',
  'task.dispatched',
  'task.progress',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.timed_out',
  'envelope.created',
  'notification.failed',
  'notification.delivered',
  'runner.started',
  'runner.heartbeat',
  'runner.state',
  'runner.stopped',
  'runner.error',
]);

export const agentEventSchema = z.object({
  id: z.string().min(1).max(128),
  type: eventTypeSchema,
  projectId: identifierSchema,
  actor: z.string().min(1).max(128),
  subject: z.string().min(1).max(128).optional(),
  correlationId: z.string().min(1).max(128).optional(),
  at: isoDateSchema,
  data: z.record(z.unknown()).optional(),
});

export const runnerRecordSchema = z.object({
  agentId: identifierSchema,
  pid: z.number().int().positive(),
  startedAt: isoDateSchema,
  logPath: z.string().min(1),
  pollIntervalMs: z.number().int().positive(),
  host: z.enum(['process', 'tmux']),
  tmuxSession: tmuxSessionSchema.optional(),
});

export const globalConfigSchema = z.object({
  schemaVersion: z.number().int().positive().max(SCHEMA_VERSION),
  activeProject: identifierSchema.optional(),
  projects: z.array(
    z.object({
      name: identifierSchema,
      rootPath: z.string().min(1),
      registeredAt: isoDateSchema,
    }),
  ),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

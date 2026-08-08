import { newEventId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { agentEventSchema } from '../domain/schemas.js';
import { type AgentEvent, type EventType } from '../domain/types.js';
import { appendJsonl, readAllJsonl, readJsonlFrom } from '../infra/fs/jsonl.js';
import { projectPaths, type ProjectPaths } from '../infra/fs/paths.js';

/** Keys whose values are never written to the event log. */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|credential|api[-_]?key|authorization|cookie|session[-_]?key)/i;

/**
 * Defence in depth for §15/§16: even if a caller passes something sensitive as
 * event data, it is redacted before it reaches disk.
 */
export function redact(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? redact(value as Record<string, unknown>)
        : value;
  }
  return out;
}

export interface EmitEventInput {
  type: EventType;
  actor: string;
  subject?: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}

export class EventLog {
  private readonly paths: ProjectPaths;

  constructor(
    rootPath: string,
    private readonly projectId: string,
  ) {
    this.paths = projectPaths(rootPath);
  }

  async emit(input: EmitEventInput): Promise<AgentEvent> {
    const data = redact(input.data);
    const event: AgentEvent = {
      id: newEventId(),
      type: input.type,
      projectId: this.projectId,
      actor: input.actor,
      at: nowIso(),
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(data === undefined ? {} : { data }),
    };
    await appendJsonl(this.paths.eventsFile, this.paths.locksDir, event, 'events');
    return event;
  }

  async readAll(): Promise<AgentEvent[]> {
    return readAllJsonl(this.paths.eventsFile, agentEventSchema);
  }

  async readFrom(offset: number): Promise<{ entries: AgentEvent[]; offset: number }> {
    return readJsonlFrom(this.paths.eventsFile, agentEventSchema, offset);
  }

  get file(): string {
    return this.paths.eventsFile;
  }
}

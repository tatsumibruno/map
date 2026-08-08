import fs from 'node:fs/promises';
import path from 'node:path';

import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js';
import { nowIso } from '../core/time.js';
import { assertParentLinkIsValid, getAgentOrThrow, indexAgents } from '../domain/hierarchy.js';
import { agentSchema, identifierSchema, tmuxSessionSchema } from '../domain/schemas.js';
import { type Agent, type AgentRole, type ProviderId, type Project } from '../domain/types.js';
import { getProvider, validateOptionsForProject } from '../providers/registry.js';
import {
  ensureDir,
  formatZodIssues,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from '../infra/fs/atomic.js';
import { withLock } from '../infra/fs/lock.js';
import { agentFile, mailboxPaths, projectPaths, type ProjectPaths } from '../infra/fs/paths.js';
import { type TmuxClient } from '../infra/tmux/tmux.js';

export interface RegisterAgentInput {
  id: string;
  displayName?: string;
  role: AgentRole;
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
  tmuxSession: string;
  parentId?: string;
  workingDirectory?: string;
}

export interface ConfigureAgentInput {
  model?: string;
  reasoningEffort?: string;
  /** Explicitly drop the reasoning effort (distinct from "leave unchanged"). */
  clearReasoningEffort?: boolean;
}

export class AgentRegistry {
  private readonly paths: ProjectPaths;

  constructor(
    private readonly project: Project,
    private readonly tmux: TmuxClient,
  ) {
    this.paths = projectPaths(project.rootPath);
  }

  async list(): Promise<Agent[]> {
    if (!(await pathExists(this.paths.agentsDir))) return [];
    const files = (await fs.readdir(this.paths.agentsDir)).filter((f) => f.endsWith('.json'));
    const agents: Agent[] = [];
    for (const file of files.sort()) {
      agents.push(await readJsonFile(path.join(this.paths.agentsDir, file), agentSchema));
    }
    return agents;
  }

  async get(id: string): Promise<Agent> {
    const file = agentFile(this.project.rootPath, id);
    if (!(await pathExists(file))) {
      throw new NotFoundError(
        `Agent "${id}" is not registered in project "${this.project.name}"`,
        'Run `agentctl agent list` to see the registered agents.',
      );
    }
    const agent = await readJsonFile(file, agentSchema);
    if (agent.projectId !== this.project.id) {
      throw new ValidationError(
        `Agent "${id}" claims project "${agent.projectId}" but lives under "${this.project.name}"`,
        'The state directory looks inconsistent. Run `agentctl doctor`.',
      );
    }
    return agent;
  }

  async find(id: string): Promise<Agent | undefined> {
    const file = agentFile(this.project.rootPath, id);
    if (!(await pathExists(file))) return undefined;
    return readJsonFile(file, agentSchema);
  }

  /**
   * Registers an already-authenticated tmux session as an agent.
   * Never touches credentials: it only records where the session is.
   */
  async register(input: RegisterAgentInput): Promise<Agent> {
    const idCheck = identifierSchema.safeParse(input.id);
    if (!idCheck.success) {
      throw new ValidationError(`Invalid agent name "${input.id}"`, formatZodIssues(idCheck.error));
    }
    const sessionCheck = tmuxSessionSchema.safeParse(input.tmuxSession);
    if (!sessionCheck.success) {
      throw new ValidationError(
        `Invalid tmux session name "${input.tmuxSession}"`,
        formatZodIssues(sessionCheck.error),
      );
    }

    const provider = getProvider(input.provider);
    provider.validateExecutionConfig(
      {
        model: input.model,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      },
      validateOptionsForProject(this.project, input.provider),
    );

    if (input.role === 'agent' && input.parentId === undefined) {
      throw new ValidationError(
        `Agent "${input.id}" has role "agent" but no --parent`,
        'Executor agents must be attached to a coordinator. Root agents must use --role coordinator.',
      );
    }

    return withLock(this.paths.locksDir, 'agents', async () => {
      const existing = await this.list();

      if (existing.some((a) => a.id === input.id)) {
        throw new ConflictError(
          `Agent "${input.id}" is already registered in project "${this.project.name}"`,
          'Use `agentctl agent configure` to change it, or `agent remove` first.',
        );
      }

      const sessionOwner = existing.find((a) => a.tmuxSession === input.tmuxSession && a.enabled);
      if (sessionOwner) {
        throw new ConflictError(
          `tmux session "${input.tmuxSession}" is already attached to active agent "${sessionOwner.id}"`,
          'Disable or remove that agent first, or register a different session.',
        );
      }

      assertParentLinkIsValid(indexAgents(existing), input.id, input.parentId, this.project.id);

      if (!(await this.tmux.hasSession(input.tmuxSession))) {
        throw new NotFoundError(
          `tmux session "${input.tmuxSession}" does not exist`,
          `Create it and sign in first:  tmux new -s ${input.tmuxSession}  then run \`${provider.expectedCommand}\` inside it.`,
        );
      }

      const agent: Agent = {
        id: input.id,
        displayName: input.displayName ?? input.id,
        role: input.role,
        provider: input.provider,
        model: input.model,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        transport: 'tmux',
        tmuxSession: input.tmuxSession,
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        projectId: this.project.id,
        workingDirectory: path.resolve(input.workingDirectory ?? this.project.rootPath),
        registeredAt: nowIso(),
        enabled: true,
      };

      await this.persist(agent);
      await this.ensureMailbox(agent.id);
      return agent;
    });
  }

  async configure(
    id: string,
    changes: ConfigureAgentInput,
  ): Promise<{ before: Agent; after: Agent }> {
    return withLock(this.paths.locksDir, 'agents', async () => {
      const before = await this.get(id);
      const model = changes.model ?? before.model;
      const reasoningEffort = changes.clearReasoningEffort
        ? undefined
        : (changes.reasoningEffort ?? before.reasoningEffort);

      const provider = getProvider(before.provider);
      provider.validateExecutionConfig(
        { model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
        validateOptionsForProject(this.project, before.provider),
      );

      const after: Agent = {
        ...before,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        updatedAt: nowIso(),
      };
      if (reasoningEffort === undefined)
        delete (after as { reasoningEffort?: string }).reasoningEffort;

      await this.persist(after);
      return { before, after };
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<Agent> {
    return withLock(this.paths.locksDir, 'agents', async () => {
      const agent = await this.get(id);
      const next: Agent = { ...agent, enabled, updatedAt: nowIso() };
      await this.persist(next);
      return next;
    });
  }

  /**
   * Removes the registration. Mailboxes and history are preserved unless
   * `purgeMailbox` is requested, so past work stays auditable.
   */
  async remove(id: string, options: { purgeMailbox?: boolean } = {}): Promise<Agent> {
    return withLock(this.paths.locksDir, 'agents', async () => {
      const agent = await this.get(id);
      const agents = await this.list();
      const children = agents.filter((a) => a.parentId === id);
      if (children.length > 0) {
        throw new ConflictError(
          `Agent "${id}" still has ${children.length} child agent(s): ${children.map((c) => c.id).join(', ')}`,
          'Remove or re-parent the children first.',
        );
      }
      await fs.rm(agentFile(this.project.rootPath, id), { force: true });
      if (options.purgeMailbox === true) {
        await fs.rm(mailboxPaths(this.project.rootPath, id).dir, { recursive: true, force: true });
      }
      return agent;
    });
  }

  async requireEnabled(id: string): Promise<Agent> {
    const agent = await this.get(id);
    if (!agent.enabled) {
      throw new ConflictError(
        `Agent "${id}" is disabled and cannot receive new work`,
        `Re-enable it with: agentctl agent enable ${id}`,
      );
    }
    return agent;
  }

  async index() {
    return indexAgents(await this.list());
  }

  async getFromIndex(id: string): Promise<Agent> {
    return getAgentOrThrow(await this.index(), id);
  }

  async ensureMailbox(agentId: string): Promise<void> {
    const mailbox = mailboxPaths(this.project.rootPath, agentId);
    await ensureDir(mailbox.dir);
    await ensureDir(mailbox.workDir);
    for (const file of [mailbox.inbox, mailbox.outbox]) {
      if (!(await pathExists(file))) await fs.writeFile(file, '', 'utf8');
    }
  }

  private async persist(agent: Agent): Promise<void> {
    await ensureDir(this.paths.agentsDir);
    await writeJsonAtomic(agentFile(this.project.rootPath, agent.id), agent);
  }
}

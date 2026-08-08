import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js';
import { type Agent } from './types.js';

export type AgentIndex = ReadonlyMap<string, Agent>;

export function indexAgents(agents: readonly Agent[]): AgentIndex {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

export function getAgentOrThrow(index: AgentIndex, id: string): Agent {
  const agent = index.get(id);
  if (!agent) {
    throw new NotFoundError(
      `Agent "${id}" is not registered in this project`,
      'Run `agentctl agent list` to see the registered agents.',
    );
  }
  return agent;
}

/** Walks parent links from `id` up to a root. Throws if the chain is cyclic. */
export function ancestorsOf(index: AgentIndex, id: string): Agent[] {
  const chain: Agent[] = [];
  const seen = new Set<string>([id]);
  let current = index.get(id)?.parentId;
  while (current !== undefined) {
    if (seen.has(current)) {
      throw new ConflictError(
        `The agent hierarchy contains a cycle involving "${current}"`,
        'Repair .agentctl/agents/*.json or re-register the affected agents.',
      );
    }
    seen.add(current);
    const parent = index.get(current);
    if (!parent) break;
    chain.push(parent);
    current = parent.parentId;
  }
  return chain;
}

export function childrenOf(agents: readonly Agent[], parentId: string): Agent[] {
  return agents.filter((agent) => agent.parentId === parentId);
}

export function descendantsOf(agents: readonly Agent[], rootId: string): Agent[] {
  const out: Agent[] = [];
  const queue = [rootId];
  const seen = new Set<string>([rootId]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf(agents, current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

export function rootsOf(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.parentId === undefined);
}

/**
 * Validates the parent link a registration or re-parenting would create.
 * `agentId` may not yet exist in `index` (that is the registration case).
 */
export function assertParentLinkIsValid(
  index: AgentIndex,
  agentId: string,
  parentId: string | undefined,
  projectId: string,
): void {
  if (parentId === undefined) return;

  if (parentId === agentId) {
    throw new ValidationError(`Agent "${agentId}" cannot be its own parent`);
  }

  const parent = index.get(parentId);
  if (!parent) {
    throw new NotFoundError(
      `Parent agent "${parentId}" is not registered in this project`,
      'Register the coordinator first, or pass an existing agent to --parent.',
    );
  }

  if (parent.projectId !== projectId) {
    throw new ValidationError(
      `Parent agent "${parentId}" belongs to project "${parent.projectId}", not "${projectId}"`,
      'Agents can only be attached to a parent inside the same project.',
    );
  }

  if (parent.role !== 'coordinator') {
    throw new ValidationError(
      `Parent agent "${parentId}" has role "${parent.role}" and cannot own children`,
      'Only agents registered with --role coordinator may act as a parent.',
    );
  }

  // Walking up from the prospective parent must never reach the child.
  const seen = new Set<string>([parentId]);
  let cursor = parent.parentId;
  while (cursor !== undefined) {
    if (cursor === agentId) {
      throw new ConflictError(
        `Making "${parentId}" the parent of "${agentId}" would create a cycle`,
        `"${agentId}" is already an ancestor of "${parentId}".`,
      );
    }
    if (seen.has(cursor)) {
      throw new ConflictError(`The existing hierarchy already contains a cycle at "${cursor}"`);
    }
    seen.add(cursor);
    cursor = index.get(cursor)?.parentId;
  }
}

export type RouteDecision = { allowed: true } | { allowed: false; reason: string; hint?: string };

/**
 * Messaging rules:
 *  - both parties must live in the same project;
 *  - a coordinator may address its *direct* children;
 *  - any agent may address its own parent (that is how results travel up);
 *  - an agent may address itself (self-notes, retries);
 *  - anything else must be relayed through the immediate coordinator.
 */
export function canSendMessage(index: AgentIndex, fromId: string, toId: string): RouteDecision {
  const from = index.get(fromId);
  const to = index.get(toId);

  if (!from)
    return { allowed: false, reason: `Sender "${fromId}" is not registered in this project` };
  if (!to)
    return { allowed: false, reason: `Recipient "${toId}" is not registered in this project` };

  if (from.projectId !== to.projectId) {
    return {
      allowed: false,
      reason: `"${fromId}" and "${toId}" belong to different projects`,
      hint: 'Projects are isolated; messages never cross project boundaries.',
    };
  }

  if (fromId === toId) return { allowed: true };
  if (to.parentId === fromId && from.role === 'coordinator') return { allowed: true };
  if (from.parentId === toId) return { allowed: true };

  const relay = to.parentId;
  return {
    allowed: false,
    reason: `"${fromId}" may not send directly to "${toId}"`,
    hint:
      relay === undefined
        ? `"${toId}" is a root coordinator; only its own children may reply to it.`
        : `Route through "${toId}"'s coordinator "${relay}" instead.`,
  };
}

export function assertCanSendMessage(index: AgentIndex, fromId: string, toId: string): void {
  const decision = canSendMessage(index, fromId, toId);
  if (decision.allowed) return;
  throw new ValidationError(decision.reason, decision.hint);
}

/** Renders the hierarchy as an indented tree for `agent list`. */
export function formatTree(agents: readonly Agent[], render: (agent: Agent) => string): string[] {
  const lines: string[] = [];
  // A corrupt state file can contain a cycle; rendering must still terminate.
  const shown = new Set<string>();
  const visit = (agent: Agent, prefix: string, isLast: boolean, depth: number): void => {
    if (shown.has(agent.id)) return;
    shown.add(agent.id);
    const connector = depth === 0 ? '' : isLast ? '└── ' : '├── ';
    lines.push(`${prefix}${connector}${render(agent)}`);
    const nextPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');
    const children = childrenOf(agents, agent.id);
    children.forEach((child, i) => visit(child, nextPrefix, i === children.length - 1, depth + 1));
  };
  rootsOf(agents).forEach((root) => visit(root, '', true, 0));

  // Orphans (parent removed out-of-band) must still be visible.
  for (const agent of agents) {
    if (!shown.has(agent.id))
      lines.push(`${render(agent)}  (orphaned: parent "${agent.parentId ?? ''}" missing)`);
  }
  return lines;
}

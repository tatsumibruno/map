import { describe, expect, it } from 'vitest';

import {
  ancestorsOf,
  assertParentLinkIsValid,
  canSendMessage,
  childrenOf,
  descendantsOf,
  formatTree,
  indexAgents,
  rootsOf,
} from '../../src/domain/hierarchy.js';
import { type Agent } from '../../src/domain/types.js';

function agent(id: string, role: Agent['role'], parentId?: string, projectId = 'proj_a'): Agent {
  return {
    id,
    displayName: id,
    role,
    provider: 'codex',
    model: 'gpt-5-codex',
    transport: 'tmux',
    tmuxSession: `s-${id}`,
    ...(parentId === undefined ? {} : { parentId }),
    projectId,
    workingDirectory: '/tmp/project',
    registeredAt: '2026-08-08T00:00:00.000Z',
    enabled: true,
  };
}

const coordinator = agent('coordinator', 'coordinator');
const lead = agent('lead', 'coordinator', 'coordinator');
const researcher = agent('researcher', 'agent', 'lead');
const writer = agent('writer', 'agent', 'coordinator');
const tree = [coordinator, lead, researcher, writer];

describe('hierarchy structure', () => {
  it('identifies roots, children and descendants', () => {
    expect(rootsOf(tree).map((a) => a.id)).toEqual(['coordinator']);
    expect(childrenOf(tree, 'coordinator').map((a) => a.id)).toEqual(['lead', 'writer']);
    expect(
      descendantsOf(tree, 'coordinator')
        .map((a) => a.id)
        .sort(),
    ).toEqual(['lead', 'researcher', 'writer']);
  });

  it('walks ancestors up to the root', () => {
    expect(ancestorsOf(indexAgents(tree), 'researcher').map((a) => a.id)).toEqual([
      'lead',
      'coordinator',
    ]);
  });

  it('renders a tree and surfaces orphans', () => {
    const orphan = agent('lost', 'agent', 'deleted-coordinator');
    const lines = formatTree([...tree, orphan], (a) => a.id);
    expect(lines.join('\n')).toContain('coordinator');
    expect(lines.join('\n')).toContain('researcher');
    expect(lines.at(-1)).toContain('orphaned');
  });

  it('terminates when the stored hierarchy contains a cycle', () => {
    const a = agent('a', 'coordinator', 'b');
    const b = agent('b', 'coordinator', 'a');
    expect(() => formatTree([a, b], (x) => x.id)).not.toThrow();
  });
});

describe('assertParentLinkIsValid', () => {
  const index = indexAgents(tree);

  it('accepts a coordinator parent in the same project', () => {
    expect(() => assertParentLinkIsValid(index, 'newbie', 'lead', 'proj_a')).not.toThrow();
  });

  it('allows registering without a parent', () => {
    expect(() => assertParentLinkIsValid(index, 'newbie', undefined, 'proj_a')).not.toThrow();
  });

  it('rejects a missing parent', () => {
    expect(() => assertParentLinkIsValid(index, 'newbie', 'ghost', 'proj_a')).toThrow(
      /Parent agent "ghost" is not registered/,
    );
  });

  it('rejects self-parenting', () => {
    expect(() => assertParentLinkIsValid(index, 'lead', 'lead', 'proj_a')).toThrow(
      /cannot be its own parent/,
    );
  });

  it('rejects a non-coordinator parent', () => {
    expect(() => assertParentLinkIsValid(index, 'newbie', 'researcher', 'proj_a')).toThrow(
      /cannot own children/,
    );
  });

  it('rejects a parent from another project', () => {
    const foreign = indexAgents([agent('other', 'coordinator', undefined, 'proj_b')]);
    expect(() => assertParentLinkIsValid(foreign, 'newbie', 'other', 'proj_a')).toThrow(
      /belongs to project "proj_b"/,
    );
  });

  it('prevents cycles', () => {
    // Making "coordinator" a child of its own descendant "lead" is a cycle.
    expect(() => assertParentLinkIsValid(index, 'coordinator', 'lead', 'proj_a')).toThrow(
      /would create a cycle/,
    );
  });
});

describe('canSendMessage', () => {
  const index = indexAgents(tree);

  it('lets a coordinator address a direct child', () => {
    expect(canSendMessage(index, 'coordinator', 'lead').allowed).toBe(true);
    expect(canSendMessage(index, 'lead', 'researcher').allowed).toBe(true);
  });

  it('lets an agent reply to its parent', () => {
    expect(canSendMessage(index, 'researcher', 'lead').allowed).toBe(true);
  });

  it('refuses to skip a coordination level', () => {
    const decision = canSendMessage(index, 'coordinator', 'researcher');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.hint).toContain('lead');
  });

  it('refuses sibling-to-sibling delivery', () => {
    expect(canSendMessage(index, 'writer', 'lead').allowed).toBe(false);
  });

  it('refuses unknown participants', () => {
    expect(canSendMessage(index, 'ghost', 'lead').allowed).toBe(false);
    expect(canSendMessage(index, 'lead', 'ghost').allowed).toBe(false);
  });

  it('isolates projects', () => {
    const mixed = indexAgents([
      coordinator,
      { ...agent('foreign', 'agent', 'coordinator'), projectId: 'proj_b' },
    ]);
    const decision = canSendMessage(mixed, 'coordinator', 'foreign');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/different projects/);
  });
});

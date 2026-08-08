import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/core/errors.js';
import { type Agent } from '../../src/domain/types.js';
import { RESPONSE_SENTINEL_BEGIN, RESPONSE_SENTINEL_END } from '../../src/providers/envelope.js';
import { PROVIDER_IDS, getProvider, listProviders } from '../../src/providers/registry.js';
import { type DispatchContext } from '../../src/providers/types.js';

const agent: Agent = {
  id: 'researcher',
  displayName: 'Researcher',
  role: 'agent',
  provider: 'codex',
  model: 'gpt-5-codex',
  reasoningEffort: 'high',
  transport: 'tmux',
  tmuxSession: 'research',
  parentId: 'coordinator',
  projectId: 'proj_a',
  workingDirectory: '/tmp/product',
  registeredAt: '2026-08-08T00:00:00.000Z',
  enabled: true,
};

const context: DispatchContext = {
  agent,
  execution: { provider: 'codex', model: 'gpt-5-codex', reasoningEffort: 'high' },
  from: 'coordinator',
  correlationId: 'task_1',
  messageId: 'msg_1',
  body: 'Research persistence options.',
  workingDirectory: '/tmp/product',
  envelopePath: '/tmp/product/.agentctl/mailboxes/researcher/work/task_1.envelope.md',
  responsePath: '/tmp/product/.agentctl/mailboxes/researcher/work/task_1.response.md',
  contextRefs: ['.agentctl/context/shared.md'],
  contextDir: '/tmp/product/.agentctl/context',
};

describe('provider registry', () => {
  it('exposes exactly the supported providers', () => {
    expect([...PROVIDER_IDS].sort()).toEqual(['claude-code', 'codex']);
    expect(listProviders()).toHaveLength(2);
  });

  it('rejects an unknown provider with the valid list', () => {
    expect(() => getProvider('gemini')).toThrow(/Unknown provider "gemini"/);
    expect(hintOf(() => getProvider('gemini'))).toBe('Supported providers: codex, claude-code.');
  });
});

describe('codex adapter', () => {
  const codex = getProvider('codex');

  it('accepts a known model with a supported reasoning effort', () => {
    expect(() =>
      codex.validateExecutionConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }),
    ).not.toThrow();
  });

  it('accepts a known model without a reasoning effort', () => {
    expect(() => codex.validateExecutionConfig({ model: 'gpt-5-codex' })).not.toThrow();
  });

  it('rejects an unknown model and explains how to allow it', () => {
    expect(() => codex.validateExecutionConfig({ model: 'gpt-9-turbo' })).toThrow(
      /not a known Codex model/,
    );
    expect(hintOf(() => codex.validateExecutionConfig({ model: 'gpt-9-turbo' }))).toContain(
      'project model allow codex gpt-9-turbo',
    );
  });

  it('accepts an unknown model once the project allows it', () => {
    expect(() =>
      codex.validateExecutionConfig(
        { model: 'gpt-9-turbo', reasoningEffort: 'low' },
        { extraModels: ['gpt-9-turbo'] },
      ),
    ).not.toThrow();
  });

  it('rejects an unsupported reasoning effort and lists the valid ones', () => {
    expect(() =>
      codex.validateExecutionConfig({ model: 'gpt-5-codex', reasoningEffort: 'extreme' }),
    ).toThrow(/Reasoning effort "extreme" is not supported/);
    expect(
      hintOf(() =>
        codex.validateExecutionConfig({ model: 'gpt-5-codex', reasoningEffort: 'extreme' }),
      ),
    ).toBe('Supported levels: minimal, low, medium, high.');
  });

  it('reports reasoning-effort support', () => {
    expect(codex.supportsReasoningEffort('gpt-5-codex')).toBe(true);
    expect(codex.listReasoningEfforts('gpt-5-codex')).toContain('medium');
  });
});

describe('claude code adapter', () => {
  const claude = getProvider('claude-code');

  it('accepts a known model', () => {
    expect(() => claude.validateExecutionConfig({ model: 'sonnet' })).not.toThrow();
  });

  it('rejects a reasoning effort because the provider has none', () => {
    expect(() =>
      claude.validateExecutionConfig({ model: 'sonnet', reasoningEffort: 'high' }),
    ).toThrow(/does not expose a selectable reasoning effort/);
    expect(claude.supportsReasoningEffort('sonnet')).toBe(false);
    expect(claude.listReasoningEfforts('sonnet')).toEqual([]);
  });

  it('rejects an unknown model', () => {
    expect(() => claude.validateExecutionConfig({ model: 'claude-42' })).toThrow(
      /not a known Claude Code model/,
    );
    expect(hintOf(() => claude.validateExecutionConfig({ model: 'claude-42' }))).toContain(
      'project model allow claude-code claude-42',
    );
  });
});

describe('dispatch envelope', () => {
  it('carries identity, objective, context refs and the response contract', () => {
    const envelope = getProvider('codex').buildEnvelope(context);
    expect(envelope).toContain('task_1');
    expect(envelope).toContain('From: `coordinator`');
    expect(envelope).toContain('/tmp/product');
    expect(envelope).toContain('Research persistence options.');
    expect(envelope).toContain('.agentctl/context/shared.md');
    expect(envelope).toContain(context.responsePath);
    expect(envelope).toContain(RESPONSE_SENTINEL_BEGIN);
    expect(envelope).toContain(RESPONSE_SENTINEL_END);
    expect(envelope).toContain('Never include credentials');
  });

  it('records the reasoning effort only when there is one', () => {
    expect(getProvider('codex').buildEnvelope(context)).toContain('Reasoning effort: `high`');
    const withoutEffort = {
      ...context,
      execution: { provider: 'claude-code' as const, model: 'sonnet' },
    };
    expect(getProvider('claude-code').buildEnvelope(withoutEffort)).not.toContain(
      'Reasoning effort',
    );
  });

  it('keeps the dispatch line to a single line', () => {
    for (const adapter of listProviders()) {
      const line = adapter.buildDispatchLine(context);
      expect(line).not.toContain('\n');
      expect(line).toContain(context.envelopePath);
      expect(line).toContain(context.responsePath);
    }
  });
});

/** Returns the actionable hint attached to a thrown ValidationError. */
function hintOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.hint ?? '';
    throw error;
  }
  throw new Error('expected the call to throw');
}

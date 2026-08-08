import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectStore } from '../../src/app/projectStore.js';
import { Workspace } from '../../src/app/workspace.js';
import {
  FakeTmuxClient,
  createTestProject,
  registerCoordinator,
  registerWorker,
  type TestProject,
} from '../helpers.js';

let project: TestProject | undefined;

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

describe('project initialisation', () => {
  it('creates the documented directory layout', async () => {
    project = await createTestProject({ name: 'product' });
    const state = path.join(project.root, '.agentctl');
    for (const entry of [
      'project.json',
      'context/README.md',
      'context/shared.md',
      'agents',
      'mailboxes',
      'events.jsonl',
      'locks',
    ]) {
      await expect(fs.stat(path.join(state, entry))).resolves.toBeDefined();
    }
    expect(project.workspace.project.name).toBe('product');
    expect(project.workspace.project.schemaVersion).toBe(1);
  });

  it('refuses to initialise twice in the same directory', async () => {
    project = await createTestProject({ name: 'product' });
    await expect(ProjectStore.init({ name: 'other', rootPath: project.root })).rejects.toThrow(
      /already hosts project "product"/,
    );
  });

  it('rejects an invalid project name', async () => {
    project = await createTestProject();
    await expect(
      ProjectStore.init({ name: '../escape', rootPath: path.join(project.root, 'x') }),
    ).rejects.toThrow(/Invalid project name/);
  });

  it('discovers the project from a nested directory', async () => {
    project = await createTestProject();
    const nested = path.join(project.root, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });
    expect(await ProjectStore.discover(nested)).toBe(project.root);
  });
});

describe('agent registration', () => {
  it('registers a coordinator and an agent, and persists both', async () => {
    project = await createTestProject();
    const coordinator = await registerCoordinator(project);
    const researcher = await registerWorker(project);

    expect(coordinator.role).toBe('coordinator');
    expect(coordinator.reasoningEffort).toBe('medium');
    expect(researcher.parentId).toBe('coordinator');
    expect(researcher.reasoningEffort).toBeUndefined();
    expect(researcher.workingDirectory).toBe(project.root);

    const onDisk = JSON.parse(
      await fs.readFile(path.join(project.root, '.agentctl/agents/researcher.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk['tmuxSession']).toBe('research');

    const agents = await project.workspace.agents.list();
    expect(agents.map((a) => a.id).sort()).toEqual(['coordinator', 'researcher']);
  });

  it('creates the mailbox files for a new agent', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    const mailbox = path.join(project.root, '.agentctl/mailboxes/coordinator');
    await expect(fs.stat(path.join(mailbox, 'inbox.jsonl'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(mailbox, 'outbox.jsonl'))).resolves.toBeDefined();
  });

  it('fails when the tmux session does not exist', async () => {
    project = await createTestProject();
    await expect(
      project.workspace.agents.register({
        id: 'coordinator',
        role: 'coordinator',
        provider: 'codex',
        model: 'gpt-5-codex',
        tmuxSession: 'missing',
      }),
    ).rejects.toThrow(/tmux session "missing" does not exist/);
  });

  it('fails when the model is unsupported', async () => {
    project = await createTestProject({ sessions: ['coord'] });
    await expect(
      project.workspace.agents.register({
        id: 'coordinator',
        role: 'coordinator',
        provider: 'codex',
        model: 'not-a-model',
        tmuxSession: 'coord',
      }),
    ).rejects.toThrow(/not a known Codex model/);
  });

  it('fails when the reasoning effort is unsupported for the provider', async () => {
    project = await createTestProject({ sessions: ['research'] });
    await registerCoordinator(project);
    await expect(
      project.workspace.agents.register({
        id: 'researcher',
        role: 'agent',
        provider: 'claude-code',
        model: 'sonnet',
        reasoningEffort: 'high',
        tmuxSession: 'research',
        parentId: 'coordinator',
      }),
    ).rejects.toThrow(/does not expose a selectable reasoning effort/);
  });

  it('accepts a model the project explicitly allowed', async () => {
    project = await createTestProject({ sessions: ['coord'] });
    await ProjectStore.allowModel(project.root, 'codex', 'gpt-6-preview');
    const reloaded = await Workspace.load(project.root, project.tmux);
    const agent = await reloaded.agents.register({
      id: 'coordinator',
      role: 'coordinator',
      provider: 'codex',
      model: 'gpt-6-preview',
      tmuxSession: 'coord',
    });
    expect(agent.model).toBe('gpt-6-preview');
  });

  it('fails when the tmux session is already attached to an active agent', async () => {
    project = await createTestProject();
    await registerCoordinator(project, { session: 'shared' });
    await expect(
      project.workspace.agents.register({
        id: 'second',
        role: 'agent',
        provider: 'codex',
        model: 'gpt-5-codex',
        tmuxSession: 'shared',
        parentId: 'coordinator',
      }),
    ).rejects.toThrow(/already attached to active agent "coordinator"/);
  });

  it('allows reusing a session once the previous agent is disabled', async () => {
    project = await createTestProject();
    await registerCoordinator(project, { session: 'shared' });
    await project.workspace.agents.setEnabled('coordinator', false);
    await project.workspace.agents.register({
      id: 'root2',
      role: 'coordinator',
      provider: 'codex',
      model: 'gpt-5-codex',
      tmuxSession: 'shared',
    });
    expect((await project.workspace.agents.get('root2')).tmuxSession).toBe('shared');
  });

  it('fails when the parent is not in the project', async () => {
    project = await createTestProject({ sessions: ['research'] });
    await expect(
      project.workspace.agents.register({
        id: 'researcher',
        role: 'agent',
        provider: 'claude-code',
        model: 'sonnet',
        tmuxSession: 'research',
        parentId: 'nobody',
      }),
    ).rejects.toThrow(/Parent agent "nobody" is not registered/);
  });

  it('requires a parent for the agent role', async () => {
    project = await createTestProject({ sessions: ['research'] });
    await expect(
      project.workspace.agents.register({
        id: 'researcher',
        role: 'agent',
        provider: 'claude-code',
        model: 'sonnet',
        tmuxSession: 'research',
      }),
    ).rejects.toThrow(/no --parent/);
  });

  it('rejects duplicate agent ids', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await expect(registerCoordinator(project, { session: 'coord2' })).rejects.toThrow(
      /already registered/,
    );
  });

  it('rejects an agent id that would escape the agents directory', async () => {
    project = await createTestProject({ sessions: ['coord'] });
    await expect(
      project.workspace.agents.register({
        id: '../evil',
        role: 'coordinator',
        provider: 'codex',
        model: 'gpt-5-codex',
        tmuxSession: 'coord',
      }),
    ).rejects.toThrow(/Invalid agent name/);
  });

  it('rejects a tmux session name containing shell metacharacters', async () => {
    project = await createTestProject();
    await expect(
      project.workspace.agents.register({
        id: 'coordinator',
        role: 'coordinator',
        provider: 'codex',
        model: 'gpt-5-codex',
        tmuxSession: 'coord; rm -rf /',
      }),
    ).rejects.toThrow(/Invalid tmux session name/);
  });
});

describe('agent lifecycle', () => {
  it('disables an agent without losing its history', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await registerWorker(project);

    await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'first task' },
    );

    await project.workspace.agents.setEnabled('researcher', false);
    await expect(project.workspace.agents.requireEnabled('researcher')).rejects.toThrow(
      /is disabled and cannot receive new work/,
    );
    expect(await project.workspace.bus.readInbox('researcher')).toHaveLength(1);
  });

  it('refuses to remove a coordinator that still has children', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await registerWorker(project);
    await expect(project.workspace.agents.remove('coordinator')).rejects.toThrow(
      /still has 1 child agent/,
    );
  });

  it('keeps the mailbox after removal unless asked to purge it', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await registerWorker(project);

    await project.workspace.agents.remove('researcher');
    await expect(
      fs.stat(path.join(project.root, '.agentctl/mailboxes/researcher/inbox.jsonl')),
    ).resolves.toBeDefined();

    await registerWorker(project, { id: 'researcher2', session: 'research2' });
    await project.workspace.agents.remove('researcher2', { purgeMailbox: true });
    await expect(
      fs.stat(path.join(project.root, '.agentctl/mailboxes/researcher2')),
    ).rejects.toThrow();
  });

  it('never touches the tmux session when removing an agent', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await project.workspace.agents.remove('coordinator');
    expect(await project.tmux.hasSession('coord')).toBe(true);
  });
});

describe('agent configure', () => {
  it('validates the new configuration through the provider adapter', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await expect(
      project.workspace.agents.configure('coordinator', { reasoningEffort: 'extreme' }),
    ).rejects.toThrow(/not supported by Codex model/);
    await expect(
      project.workspace.agents.configure('coordinator', { model: 'no-such-model' }),
    ).rejects.toThrow(/not a known Codex model/);
  });

  it('changes model and effort, and can clear the effort', async () => {
    project = await createTestProject();
    await registerCoordinator(project);

    const { after } = await project.workspace.agents.configure('coordinator', {
      model: 'gpt-5',
      reasoningEffort: 'low',
    });
    expect(after.model).toBe('gpt-5');
    expect(after.reasoningEffort).toBe('low');
    expect(after.updatedAt).toBeDefined();

    const cleared = await project.workspace.agents.configure('coordinator', {
      clearReasoningEffort: true,
    });
    expect(cleared.after.reasoningEffort).toBeUndefined();
    expect(
      await fs.readFile(path.join(project.root, '.agentctl/agents/coordinator.json'), 'utf8'),
    ).not.toContain('reasoningEffort');
  });
});

describe('restart durability', () => {
  it('keeps projects, agents, messages and events across CLI restarts', async () => {
    project = await createTestProject({ name: 'product' });
    await registerCoordinator(project);
    await registerWorker(project);
    const { task } = await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'survive a restart' },
    );

    // Simulate a fresh process: nothing in memory, everything from disk.
    const restarted = await Workspace.load(
      project.root,
      new FakeTmuxClient(new Set(['coord', 'research'])),
    );
    expect(restarted.project.name).toBe('product');
    expect((await restarted.agents.list()).map((a) => a.id).sort()).toEqual([
      'coordinator',
      'researcher',
    ]);
    expect((await restarted.bus.readInbox('researcher'))[0]?.body).toBe('survive a restart');
    expect((await restarted.tasks.get(task.id)).state).toBe('pending');
    expect((await restarted.events.readAll()).length).toBeGreaterThan(0);
  });
});

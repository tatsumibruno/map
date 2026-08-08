import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Workspace } from '../../src/app/workspace.js';
import { AgentWorker } from '../../src/runner/agentWorker.js';
import { CoordinatorProcess } from '../../src/runner/coordinator.js';
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

/**
 * Simulates the container topology from the spec: a coordinator process and an
 * agent worker with *separate* Workspace instances (separate processes in
 * production) whose only shared resource is the project state directory.
 */
describe('coordinator and agent worker across a shared state directory', () => {
  it('exchanges a task and its result through the filesystem alone', async () => {
    project = await createTestProject({ name: 'product' });
    await registerCoordinator(project);
    await registerWorker(project);

    // Two independent "containers", each with its own tmux and its own handles.
    const coordinatorSide = await Workspace.load(
      project.root,
      new FakeTmuxClient(new Set(['coord'])),
    );
    const agentTmux = new FakeTmuxClient(new Set(['research']));
    const agentSide = await Workspace.load(project.root, agentTmux);

    const { task } = await coordinatorSide.tasks.assign(
      await coordinatorSide.agents.index(),
      await coordinatorSide.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'Work in your own container.' },
    );

    agentTmux.onDispatch = async (sent) => {
      const responsePath = /write your final answer to (\S+?)\.?$/.exec(sent.text.trim())?.[1];
      if (responsePath) await fs.writeFile(responsePath, 'answer from the agent container', 'utf8');
    };

    await new AgentWorker(agentSide, 'researcher', {
      pollIntervalMs: 10,
      responseTimeoutMs: 5_000,
      once: true,
      logger: () => {},
    }).run();

    // The coordinator side has never touched the agent's terminal.
    await new CoordinatorProcess(coordinatorSide, { once: true, logger: () => {} }).run();

    const finished = await coordinatorSide.tasks.get(task.id);
    expect(finished.state).toBe('completed');
    expect(finished.result).toBe('answer from the agent container');

    const reply = (await coordinatorSide.bus.readInbox('coordinator')).at(-1);
    expect(reply?.from).toBe('researcher');
    expect(reply?.correlationId).toBe(task.id);
  });

  it('keeps polling-only workers working when no filesystem events fire', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await registerWorker(project);

    const agentTmux = new FakeTmuxClient(new Set(['research']));
    const agentSide = await Workspace.load(project.root, agentTmux);
    const worker = new AgentWorker(agentSide, 'researcher', {
      pollIntervalMs: 10,
      once: true,
      logger: () => {},
    });

    // First poll: nothing queued yet.
    await worker.run();
    expect(agentTmux.sentText).toHaveLength(0);

    const { task } = await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'arrived after the first poll' },
    );

    agentTmux.onDispatch = async (sent) => {
      const responsePath = /write your final answer to (\S+?)\.?$/.exec(sent.text.trim())?.[1];
      if (responsePath) await fs.writeFile(responsePath, 'late but delivered', 'utf8');
    };
    await new AgentWorker(agentSide, 'researcher', {
      pollIntervalMs: 10,
      responseTimeoutMs: 5_000,
      once: true,
      logger: () => {},
    }).run();

    expect((await project.workspace.tasks.get(task.id)).state).toBe('completed');
  });

  it('writes every artefact inside the project state directory', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await registerWorker(project);
    await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'stay inside .agentctl' },
    );

    const state = path.join(project.root, '.agentctl');
    const entries = await fs.readdir(state);
    expect(entries.sort()).toEqual(
      expect.arrayContaining([
        'agents',
        'context',
        'events.jsonl',
        'mailboxes',
        'project.json',
        'tasks',
      ]),
    );
    // Nothing leaked into the project root itself.
    expect((await fs.readdir(project.root)).sort()).toEqual(['.agentctl']);
  });
});

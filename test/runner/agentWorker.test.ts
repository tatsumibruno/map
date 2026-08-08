import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentWorker } from '../../src/runner/agentWorker.js';
import { CoordinatorProcess } from '../../src/runner/coordinator.js';
import { RESPONSE_SENTINEL_BEGIN, RESPONSE_SENTINEL_END } from '../../src/providers/envelope.js';
import { extractSentinelBlock } from '../../src/runner/responseCapture.js';
import {
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

async function twoAgents(): Promise<TestProject> {
  const created = await createTestProject();
  await registerCoordinator(created);
  await registerWorker(created);
  return created;
}

/** Extracts the response path the runner told the client to write. */
function responsePathFrom(dispatchLine: string): string {
  const match = /write your final answer to (\S+)\.?$/.exec(dispatchLine.trim());
  if (!match?.[1]) throw new Error(`no response path in: ${dispatchLine}`);
  return match[1].replace(/\.$/, '');
}

async function assign(created: TestProject, body: string, timeoutMs?: number) {
  return created.workspace.tasks.assign(
    await created.workspace.agents.index(),
    await created.workspace.agents.get('researcher'),
    {
      from: 'coordinator',
      to: 'researcher',
      body,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  );
}

describe('agent worker task execution', () => {
  it('dispatches to the session, captures the response file and replies to the sender', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'Recommend a persistence layer.');

    // Simulate the AI client: read the envelope, write the answer.
    project.tmux.onDispatch = async (sent) => {
      const responsePath = responsePathFrom(sent.text);
      await fs.writeFile(responsePath, 'Use SQLite with WAL mode.', 'utf8');
    };

    const worker = new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      responseTimeoutMs: 5_000,
      once: true,
      logger: () => {},
    });
    await worker.run();

    const finished = await project.workspace.tasks.get(task.id);
    expect(finished.state).toBe('completed');
    expect(finished.result).toBe('Use SQLite with WAL mode.');
    expect(finished.attempts).toBe(1);

    const reply = (await project.workspace.bus.readInbox('coordinator')).at(-1);
    expect(reply?.type).toBe('result');
    expect(reply?.from).toBe('researcher');
    expect(reply?.correlationId).toBe(task.id);
    expect(reply?.body).toBe('Use SQLite with WAL mode.');

    // The coordinator never needed the agent terminal.
    expect(project.tmux.sentText[0]?.session).toBe('research');
    expect(project.tmux.sentText[0]?.text).toContain(task.id);
  });

  it('writes an envelope with the objective and the response contract', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'Summarise the architecture.');

    project.tmux.onDispatch = async (sent) => {
      await fs.writeFile(responsePathFrom(sent.text), 'done', 'utf8');
    };
    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      once: true,
      logger: () => {},
    }).run();

    const envelope = await fs.readFile(
      path.join(project.root, '.agentctl/mailboxes/researcher/work', `${task.id}.envelope.md`),
      'utf8',
    );
    expect(envelope).toContain('Summarise the architecture.');
    expect(envelope).toContain('From: `coordinator`');
    expect(envelope).toContain(project.root);
  });

  it('submits the prompt with an explicit Enter after typing it', async () => {
    project = await twoAgents();
    await assign(project, 'anything');
    project.tmux.onDispatch = async (sent) => {
      await fs.writeFile(responsePathFrom(sent.text), 'ok', 'utf8');
    };
    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      once: true,
      logger: () => {},
    }).run();

    expect(project.tmux.sentText[0]?.submit).toBe(false);
    expect(project.tmux.sentKeys[0]?.keys).toEqual(['Enter']);
  });

  it('falls back to the terminal sentinel block when no file is written', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'Answer in the terminal.');

    project.tmux.onDispatch = () => {
      project?.tmux.paneContents.set(
        'research',
        [
          'some noise',
          RESPONSE_SENTINEL_BEGIN,
          'The terminal answer.',
          RESPONSE_SENTINEL_END,
          'more noise',
        ].join('\n'),
      );
    };

    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      responseTimeoutMs: 3_000,
      once: true,
      logger: () => {},
    }).run();

    const finished = await project.workspace.tasks.get(task.id);
    expect(finished.state).toBe('completed');
    expect(finished.result).toBe('The terminal answer.');
  });

  it('times out, interrupts the session and reports an error upward', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'Never answered.');

    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      responseTimeoutMs: 60,
      once: true,
      logger: () => {},
    }).run();

    const finished = await project.workspace.tasks.get(task.id);
    expect(finished.state).toBe('timed_out');

    const reply = (await project.workspace.bus.readInbox('coordinator')).at(-1);
    expect(reply?.type).toBe('error');
    expect(reply?.meta?.['timedOut']).toBe(true);
    // Claude Code's interrupt key was sent.
    expect(project.tmux.sentKeys.at(-1)?.keys).toEqual(['Escape']);
  });

  it('fails the task and reports upward when the session disappeared', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'Session is gone.');
    project.tmux.removeSession('research');

    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      once: true,
      logger: () => {},
    }).run();

    const finished = await project.workspace.tasks.get(task.id);
    expect(finished.state).toBe('failed');
    expect(finished.error).toContain('research');

    const reply = (await project.workspace.bus.readInbox('coordinator')).at(-1);
    expect(reply?.type).toBe('error');
    expect(await project.workspace.bus.readStatus('researcher')).toMatchObject({
      runnerState: 'stopped',
    });
  });

  it('honours a cancel that arrives while the task is running', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'Cancel me.');

    project.tmux.onDispatch = async () => {
      // The cancel lands after dispatch but before any response appears.
      await project?.workspace.bus.send(await project.workspace.agents.index(), {
        from: 'coordinator',
        to: 'researcher',
        type: 'cancel',
        body: 'stop',
        correlationId: task.id,
      });
    };

    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      responseTimeoutMs: 5_000,
      once: true,
      logger: () => {},
    }).run();

    expect((await project.workspace.tasks.get(task.id)).state).toBe('cancelled');
    const reply = (await project.workspace.bus.readInbox('coordinator')).at(-1);
    expect(reply?.meta?.['cancelled']).toBe(true);
  });

  it('does not accept work while the agent is disabled', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'queued while enabled');
    await project.workspace.agents.setEnabled('researcher', false);

    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      once: true,
      logger: () => {},
    }).run();

    expect((await project.workspace.tasks.get(task.id)).state).toBe('pending');
    expect(project.tmux.sentText).toHaveLength(0);
  });

  it('does not reprocess a message after a restart', async () => {
    project = await twoAgents();
    await assign(project, 'process once');
    project.tmux.onDispatch = async (sent) => {
      await fs.writeFile(responsePathFrom(sent.text), 'first answer', 'utf8');
    };

    const options = { pollIntervalMs: 5, once: true, logger: () => {} } as const;
    await new AgentWorker(project.workspace, 'researcher', options).run();
    await new AgentWorker(project.workspace, 'researcher', options).run();

    expect(project.tmux.sentText).toHaveLength(1);
    const cursor = await project.workspace.bus.readCursor('researcher');
    expect(cursor?.offset).toBeGreaterThan(0);
  });

  it('records heartbeats and runner lifecycle events', async () => {
    project = await twoAgents();
    await new AgentWorker(project.workspace, 'researcher', {
      pollIntervalMs: 5,
      once: true,
      logger: () => {},
    }).run();

    const types = (await project.workspace.events.readAll()).map((e) => e.type);
    expect(types).toContain('runner.started');
    expect(types).toContain('runner.stopped');
    expect(await project.workspace.bus.readStatus('researcher')).toMatchObject({
      runnerState: 'stopped',
      agentId: 'researcher',
    });
  });
});

describe('coordinator process', () => {
  it('consolidates a child result into the task record', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'consolidate me');

    // The child replies directly; the coordinator only reads the filesystem.
    await project.workspace.bus.send(await project.workspace.agents.index(), {
      from: 'researcher',
      to: 'coordinator',
      type: 'result',
      body: 'the answer',
      correlationId: task.id,
    });

    await new CoordinatorProcess(project.workspace, { once: true, logger: () => {} }).run();

    const finished = await project.workspace.tasks.get(task.id);
    expect(finished.state).toBe('completed');
    expect(finished.result).toBe('the answer');
  });

  it('expires tasks that exceeded their timeout', async () => {
    project = await twoAgents();
    const { task } = await assign(project, 'expires quickly', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await new CoordinatorProcess(project.workspace, { once: true, logger: () => {} }).run();
    expect((await project.workspace.tasks.get(task.id)).state).toBe('timed_out');
  });

  it('reports the agents in a coordinator subtree', async () => {
    project = await twoAgents();
    const coordinator = new CoordinatorProcess(project.workspace, { once: true, logger: () => {} });
    expect((await coordinator.subtree('coordinator')).map((a) => a.id)).toEqual(['researcher']);
  });
});

describe('sentinel extraction', () => {
  it('takes the last complete block', () => {
    const capture = [
      `${RESPONSE_SENTINEL_BEGIN}`,
      'first',
      RESPONSE_SENTINEL_END,
      `${RESPONSE_SENTINEL_BEGIN}`,
      'second',
      RESPONSE_SENTINEL_END,
    ].join('\n');
    expect(extractSentinelBlock(capture)).toBe('second');
  });

  it('ignores an unterminated block', () => {
    expect(extractSentinelBlock(`${RESPONSE_SENTINEL_BEGIN}\nincomplete`)).toBeUndefined();
    expect(extractSentinelBlock('nothing here')).toBeUndefined();
  });
});

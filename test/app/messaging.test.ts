import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { redact } from '../../src/app/eventLog.js';
import { executionConfigFor } from '../../src/app/taskService.js';
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

describe('message delivery', () => {
  it('appends to the recipient inbox and the sender outbox', async () => {
    project = await twoAgents();
    const sent = await project.workspace.bus.send(await project.workspace.agents.index(), {
      from: 'coordinator',
      to: 'researcher',
      type: 'task',
      body: 'Investigate persistence options.',
    });

    const inbox = await project.workspace.bus.readInbox('researcher');
    const outbox = await project.workspace.bus.readOutbox('coordinator');
    expect(inbox.map((m) => m.id)).toEqual([sent.id]);
    expect(outbox.map((m) => m.id)).toEqual([sent.id]);
    expect(inbox[0]?.body).toBe('Investigate persistence options.');
  });

  it('writes one JSON object per line', async () => {
    project = await twoAgents();
    const index = await project.workspace.agents.index();
    for (const body of ['one', 'two\nwith newline', 'three']) {
      await project.workspace.bus.send(index, {
        from: 'coordinator',
        to: 'researcher',
        type: 'task',
        body,
      });
    }
    const raw = await fs.readFile(
      path.join(project.root, '.agentctl/mailboxes/researcher/inbox.jsonl'),
      'utf8',
    );
    const lines = raw.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect((await project.workspace.bus.readInbox('researcher'))[1]?.body).toBe(
      'two\nwith newline',
    );
  });

  it('refuses to skip a coordination level', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await registerWorker(project, { id: 'lead', session: 'lead' });
    // "lead" was registered as an agent, so re-register a real sub-coordinator.
    await project.workspace.agents.remove('lead');
    project.tmux.addSession('lead2');
    await project.workspace.agents.register({
      id: 'lead',
      role: 'coordinator',
      provider: 'codex',
      model: 'gpt-5-codex',
      tmuxSession: 'lead2',
      parentId: 'coordinator',
    });
    await registerWorker(project, { id: 'deep', session: 'deep', parent: 'lead' });

    await expect(
      project.workspace.bus.send(await project.workspace.agents.index(), {
        from: 'coordinator',
        to: 'deep',
        type: 'task',
        body: 'skip a level',
      }),
    ).rejects.toThrow(/may not send directly/);
  });

  it('lets a child reply to its parent', async () => {
    project = await twoAgents();
    await project.workspace.bus.send(await project.workspace.agents.index(), {
      from: 'researcher',
      to: 'coordinator',
      type: 'result',
      body: 'Use SQLite.',
    });
    expect((await project.workspace.bus.readInbox('coordinator'))[0]?.body).toBe('Use SQLite.');
  });

  it('records an event for every message', async () => {
    project = await twoAgents();
    await project.workspace.bus.send(await project.workspace.agents.index(), {
      from: 'coordinator',
      to: 'researcher',
      type: 'task',
      body: 'hello',
    });
    const events = await project.workspace.events.readAll();
    expect(events.some((e) => e.type === 'message.sent')).toBe(true);
  });
});

describe('mailbox cursors', () => {
  it('only returns messages the agent has not consumed', async () => {
    project = await twoAgents();
    const index = await project.workspace.agents.index();
    await project.workspace.bus.send(index, {
      from: 'coordinator',
      to: 'researcher',
      type: 'task',
      body: 'a',
    });

    const first = await project.workspace.bus.readInboxFromCursor('researcher');
    expect(first.messages).toHaveLength(1);
    await project.workspace.bus.writeCursor('researcher', first.offset, first.messages[0]?.id);

    const empty = await project.workspace.bus.readInboxFromCursor('researcher');
    expect(empty.messages).toHaveLength(0);

    await project.workspace.bus.send(index, {
      from: 'coordinator',
      to: 'researcher',
      type: 'task',
      body: 'b',
    });
    const second = await project.workspace.bus.readInboxFromCursor('researcher');
    expect(second.messages.map((m) => m.body)).toEqual(['b']);
  });

  it('persists runner status as an overwritable current-state view', async () => {
    project = await twoAgents();
    await project.workspace.bus.writeStatus('researcher', 'busy', {
      correlationId: 'task_1',
      pid: 42,
      detail: 'working',
    });
    await project.workspace.bus.writeStatus('researcher', 'idle');

    const status = await project.workspace.bus.readStatus('researcher');
    expect(status?.runnerState).toBe('idle');
    expect(status?.currentCorrelationId).toBeUndefined();

    const raw = await fs.readFile(
      path.join(project.root, '.agentctl/mailboxes/researcher/status.json'),
      'utf8',
    );
    expect(JSON.parse(raw)).toMatchObject({ agentId: 'researcher', runnerState: 'idle' });
  });
});

describe('task configuration snapshots', () => {
  it('records the agent model and effort on the task', async () => {
    project = await twoAgents();
    const { task } = await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'do the thing' },
    );
    expect(task.execution).toEqual({ provider: 'claude-code', model: 'sonnet' });
    expect(task.state).toBe('pending');
    expect(task.attempts).toBe(0);
  });

  it('applies a per-task override without changing the agent default', async () => {
    project = await twoAgents();
    const { task } = await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('coordinator'),
      { from: 'coordinator', to: 'coordinator', body: 'self note', execution: { model: 'gpt-5' } },
    );
    expect(task.execution.model).toBe('gpt-5');
    expect((await project.workspace.agents.get('coordinator')).model).toBe('gpt-5-codex');
  });

  it('does not rewrite the snapshot of a task already in flight', async () => {
    project = await twoAgents();
    const { task } = await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'long running' },
    );
    await project.workspace.tasks.transition(task.id, 'in_progress');
    await project.workspace.agents.configure('researcher', { model: 'opus' });

    const reloaded = await project.workspace.tasks.get(task.id);
    expect(reloaded.execution.model).toBe('sonnet');
    expect((await project.workspace.agents.get('researcher')).model).toBe('opus');
  });

  it('attaches the snapshot to the delivered task message', async () => {
    project = await twoAgents();
    await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('researcher'),
      { from: 'coordinator', to: 'researcher', body: 'with config' },
    );
    const message = (await project.workspace.bus.readInbox('researcher'))[0];
    expect(message?.execution).toEqual({ provider: 'claude-code', model: 'sonnet' });
    expect(message?.correlationId).toMatch(/^task_/);
  });

  it('logs the effective configuration on task.created', async () => {
    project = await twoAgents();
    await project.workspace.tasks.assign(
      await project.workspace.agents.index(),
      await project.workspace.agents.get('coordinator'),
      { from: 'coordinator', to: 'coordinator', body: 'note' },
    );
    const created = (await project.workspace.events.readAll()).find(
      (e) => e.type === 'task.created',
    );
    expect(created?.data).toMatchObject({ model: 'gpt-5-codex', reasoningEffort: 'medium' });
  });

  it('derives an execution config from the agent defaults', () => {
    const agent = {
      provider: 'codex' as const,
      model: 'gpt-5-codex',
      reasoningEffort: 'medium',
    };
    expect(executionConfigFor(agent as never)).toEqual({
      provider: 'codex',
      model: 'gpt-5-codex',
      reasoningEffort: 'medium',
    });
    expect(executionConfigFor(agent as never, { reasoningEffort: undefined })).toEqual({
      provider: 'codex',
      model: 'gpt-5-codex',
    });
  });
});

describe('event log hygiene', () => {
  it('redacts anything that looks like a credential', () => {
    expect(
      redact({ token: 'abc', apiKey: 'xyz', nested: { password: 'p' }, model: 'gpt-5-codex' }),
    ).toEqual({
      token: '[redacted]',
      apiKey: '[redacted]',
      nested: { password: '[redacted]' },
      model: 'gpt-5-codex',
    });
  });

  it('never writes a secret-looking value to disk', async () => {
    project = await twoAgents();
    await project.workspace.events.emit({
      type: 'runner.error',
      actor: 'researcher',
      data: { authorization: 'Bearer super-secret', detail: 'failed' },
    });
    const raw = await fs.readFile(path.join(project.root, '.agentctl/events.jsonl'), 'utf8');
    expect(raw).not.toContain('super-secret');
    expect(raw).toContain('[redacted]');
  });
});

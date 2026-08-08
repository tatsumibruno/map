import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunnerSupervisor, resolveCliEntry } from '../../src/app/runnerSupervisor.js';
import { sleep } from '../../src/core/time.js';
import {
  createTestProject,
  registerCoordinator,
  registerWorker,
  type TestProject,
} from '../helpers.js';

let project: TestProject | undefined;

afterEach(async () => {
  if (project) {
    const supervisor = new RunnerSupervisor(project.workspace);
    for (const record of await supervisor.listRecords()) {
      await supervisor.stop(record.agentId).catch(() => false);
    }
    await project.cleanup();
  }
  project = undefined;
});

describe('runner supervisor', () => {
  it('reports no runner before one is started', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    const status = await new RunnerSupervisor(project.workspace).status('coordinator');
    expect(status.record).toBeUndefined();
    expect(status.alive).toBe(false);
  });

  it('stops cleanly when there is nothing to stop', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    expect(await new RunnerSupervisor(project.workspace).stop('coordinator')).toBe(false);
  });

  it('refuses to start a runner for an unregistered agent', async () => {
    project = await createTestProject();
    await expect(new RunnerSupervisor(project.workspace).start('ghost')).rejects.toThrow(
      /Agent "ghost" is not registered/,
    );
  });

  it('refuses to start a runner when the tmux session is gone', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    project.tmux.removeSession('coord');
    await expect(new RunnerSupervisor(project.workspace).start('coordinator')).rejects.toThrow(
      /does not exist/,
    );
  });

  it('detects that the current process is alive and a bogus pid is not', () => {
    expect(RunnerSupervisor.isAlive(process.pid)).toBe(true);
    expect(RunnerSupervisor.isAlive(2_147_483_646)).toBe(false);
  });

  it('resolves a CLI entry point that node can execute', () => {
    expect(resolveCliEntry().endsWith(path.join('dist', 'bin', 'agentctl.js'))).toBe(true);
  });
});

// The detached runner re-execs the compiled CLI, so this needs a build.
describe.skipIf(!existsSync(resolveCliEntry()))('runner supervisor process lifecycle', () => {
  it('starts a detached runner, records it, and stops it again', async () => {
    project = await createTestProject();
    await registerCoordinator(project);
    await registerWorker(project);

    // The spawned process talks to the real tmux binary, so point it at a
    // stub that always reports the session as present.
    const stub = path.join(project.root, 'fake-tmux.sh');
    await fs.writeFile(
      stub,
      ['#!/bin/sh', 'case "$1" in', '  -V) echo "tmux 3.4 (stub)";;', 'esac', 'exit 0', ''].join(
        '\n',
      ),
      'utf8',
    );
    await fs.chmod(stub, 0o755);
    const previous = process.env['AGENTCTL_TMUX_BIN'];
    process.env['AGENTCTL_TMUX_BIN'] = stub;

    try {
      const supervisor = new RunnerSupervisor(project.workspace);
      const record = await supervisor.start('researcher', { pollIntervalMs: 200 });
      expect(record.pid).toBeGreaterThan(0);
      expect(record.host).toBe('process');

      const runnerFile = path.join(project.root, '.agentctl/runners/researcher.json');
      await expect(fs.stat(runnerFile)).resolves.toBeDefined();

      await expect(supervisor.start('researcher')).rejects.toThrow(/already running/);

      // Give the child a moment to write its first status heartbeat.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const status = await project.workspace.bus.readStatus('researcher');
        if (status && status.runnerState !== 'stopped') break;
        await sleep(50);
      }
      const status = await project.workspace.bus.readStatus('researcher');
      expect(status?.pid).toBe(record.pid);

      expect(await supervisor.stop('researcher')).toBe(true);
      await expect(fs.stat(runnerFile)).rejects.toThrow();
      expect(RunnerSupervisor.isAlive(record.pid)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['AGENTCTL_TMUX_BIN'];
      else process.env['AGENTCTL_TMUX_BIN'] = previous;
    }
  });
});

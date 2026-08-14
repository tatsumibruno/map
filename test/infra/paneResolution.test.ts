import { describe, expect, it } from 'vitest';

import { resolvePane, type PaneQueryClient } from '../../src/infra/tmux/paneResolution.js';
import { type TmuxPaneInfo } from '../../src/infra/tmux/tmux.js';

function pane(
  overrides: Partial<TmuxPaneInfo> & { paneId: string; sessionName: string },
): TmuxPaneInfo {
  return { windowIndex: 0, paneIndex: 0, windowName: 'work', dead: false, ...overrides };
}

/** A minimal, hand-rolled stand-in for the tmux target-resolution quirks. */
function mockClient(panes: readonly TmuxPaneInfo[]): PaneQueryClient {
  return {
    async paneInfo(target: string): Promise<TmuxPaneInfo | undefined> {
      if (target.startsWith('%')) return panes.find((p) => p.paneId === target);
      if (target.startsWith('=')) {
        const body = target.slice(1);
        const colon = body.indexOf(':');
        // Mirrors the real tmux gotcha this transport was built around: a
        // bare "=session" target never resolves to a pane.
        if (colon === -1) return undefined;
        const sessionName = body.slice(0, colon);
        const [windowRaw, paneRaw] = body.slice(colon + 1).split('.');
        return panes.find(
          (p) =>
            p.sessionName === sessionName &&
            p.windowIndex === Number(windowRaw) &&
            p.paneIndex === Number(paneRaw),
        );
      }
      return panes.find((p) => p.sessionName === target);
    },
    async listPanes(): Promise<TmuxPaneInfo[]> {
      return [...panes];
    },
  };
}

describe('resolvePane', () => {
  it('resolves the reported techlead/work/%7 layout via the qualified fallback', async () => {
    const client = mockClient([
      pane({ paneId: '%7', sessionName: 'techlead', windowName: 'work' }),
    ]);
    const resolved = await resolvePane(client, 'techlead');
    expect(resolved.paneId).toBe('%7');
    expect(resolved.resolvedVia).toBe('qualified-fallback');
  });

  it('never resolves a bare "=session" target — a stand-in for `send-keys -t =techlead` failing', async () => {
    // A client that only ever answers `paneInfo` for a bare "=session" target
    // with `undefined`, exactly like real tmux does for `display-message`/
    // `send-keys` (while `has-session` on the same target succeeds).
    const client: PaneQueryClient = {
      async paneInfo() {
        return undefined;
      },
      async listPanes() {
        return [];
      },
    };
    await expect(resolvePane(client, 'techlead')).rejects.toThrow(/No live tmux pane found/);
  });

  it('prefers a previously known pane id over re-resolving', async () => {
    const client = mockClient([
      pane({ paneId: '%7', sessionName: 'techlead' }),
      pane({ paneId: '%9', sessionName: 'other' }),
    ]);
    const resolved = await resolvePane(client, 'techlead', { paneIdHint: '%7' });
    expect(resolved.resolvedVia).toBe('pane-id');
    expect(resolved.paneId).toBe('%7');
  });

  it('falls back to the qualified target when the pane id hint is dead', async () => {
    const client = mockClient([
      // The hinted pane died in a different window; a fresh, live pane now
      // sits at 0.0 — the only coordinates a qualified target can name.
      pane({ paneId: '%3', sessionName: 'techlead', windowIndex: 3, paneIndex: 0, dead: true }),
      pane({ paneId: '%4', sessionName: 'techlead', windowIndex: 0, paneIndex: 0 }),
    ]);
    const resolved = await resolvePane(client, 'techlead', { paneIdHint: '%3' });
    expect(resolved.resolvedVia).toBe('qualified-fallback');
    expect(resolved.paneId).toBe('%4');
  });

  it('rediscovers via list-panes when the live pane is not window 0 / pane 0', async () => {
    const client = mockClient([
      pane({ paneId: '%5', sessionName: 'techlead', windowIndex: 1, paneIndex: 2 }),
    ]);
    const resolved = await resolvePane(client, 'techlead');
    expect(resolved.resolvedVia).toBe('rediscovered');
    expect(resolved.paneId).toBe('%5');
  });

  it('does not use a dead pane even when it sits at 0.0', async () => {
    const client = mockClient([
      pane({ paneId: '%1', sessionName: 'techlead', dead: true }),
      pane({ paneId: '%2', sessionName: 'techlead', windowIndex: 0, paneIndex: 1 }),
    ]);
    const resolved = await resolvePane(client, 'techlead');
    expect(resolved.paneId).toBe('%2');
    expect(resolved.resolvedVia).toBe('rediscovered');
  });

  it('rejects a stale pane id that only coincidentally matches after a server restart', async () => {
    // Pane ids reset after a full tmux server restart, so a persisted hint
    // can resolve to a *live* pane that belongs to an unrelated session.
    const client = mockClient([
      pane({ paneId: '%7', sessionName: 'someone-elses-session' }),
      pane({ paneId: '%2', sessionName: 'techlead' }),
    ]);
    const resolved = await resolvePane(client, 'techlead', { paneIdHint: '%7' });
    expect(resolved.paneId).toBe('%2');
    expect(resolved.resolvedVia).not.toBe('pane-id');
  });

  it('throws with the expected session, agent id, and available panes when nothing matches', async () => {
    const client = mockClient([pane({ paneId: '%1', sessionName: 'other-session' })]);
    await expect(resolvePane(client, 'techlead', { agentId: 'tech-lead' })).rejects.toThrow(
      /agent "tech-lead"/,
    );
    await expect(resolvePane(client, 'techlead')).rejects.toThrow(/expected session "techlead"/);
    await expect(resolvePane(client, 'techlead')).rejects.toThrow(/%1/);
  });

  it('reports "no panes on the tmux server" when the server has none at all', async () => {
    const client = mockClient([]);
    await expect(resolvePane(client, 'techlead')).rejects.toThrow(/no panes on the tmux server/);
  });
});

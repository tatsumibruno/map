import { describe, expect, it } from 'vitest';

import { deliverToPane, DeliveryStageError, resubmitPane } from '../../src/runner/dispatch.js';
import { type ResolvedPane } from '../../src/infra/tmux/paneResolution.js';

const pane: ResolvedPane = {
  paneId: '%7',
  sessionName: 'techlead',
  windowIndex: 0,
  paneIndex: 0,
  dead: false,
  resolvedVia: 'qualified-fallback',
};

interface Call {
  op: 'setBuffer' | 'pasteBuffer' | 'sendKeys';
  args: unknown[];
}

function fakeTmux(overrides: { failAt?: 'setBuffer' | 'pasteBuffer' | 'sendKeys' } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async setBuffer(text: string): Promise<void> {
        calls.push({ op: 'setBuffer', args: [text] });
        if (overrides.failAt === 'setBuffer') throw new Error('tmux set-buffer failed');
      },
      async pasteBuffer(target: string, options?: { delete?: boolean }): Promise<void> {
        calls.push({ op: 'pasteBuffer', args: [target, options] });
        if (overrides.failAt === 'pasteBuffer') throw new Error("can't find pane: " + target);
      },
      async sendKeys(target: string, keys: readonly string[]): Promise<void> {
        calls.push({ op: 'sendKeys', args: [target, [...keys]] });
        if (overrides.failAt === 'sendKeys') throw new Error('tmux send-keys failed');
      },
    },
  };
}

describe('deliverToPane', () => {
  it('loads the buffer, pastes it, waits, then submits with C-m — never raw send-keys -l', async () => {
    const { client, calls } = fakeTmux();
    const text = 'a single-line prompt';

    const telemetry = await deliverToPane(client, pane, text, { settleMs: 5 });

    expect(calls.map((c) => c.op)).toEqual(['setBuffer', 'pasteBuffer', 'sendKeys']);
    expect(calls[0]).toEqual({ op: 'setBuffer', args: [text] });
    expect(calls[1]).toEqual({ op: 'pasteBuffer', args: ['%7', { delete: true }] });
    expect(calls[2]).toEqual({ op: 'sendKeys', args: ['%7', ['C-m']] });
    expect(telemetry.paneId).toBe('%7');
    expect(telemetry.resolvedVia).toBe('qualified-fallback');
    expect(Date.parse(telemetry.queuedAt)).toBeLessThanOrEqual(
      Date.parse(telemetry.pastedAt ?? ''),
    );
    expect(Date.parse(telemetry.pastedAt ?? '')).toBeLessThanOrEqual(
      Date.parse(telemetry.submittedAt ?? ''),
    );
  });

  it('preserves multi-line text, quotes and special characters exactly, in one paste', async () => {
    const { client, calls } = fakeTmux();
    const text = [
      'line one with "quotes" and $shell-looking-things',
      'line two with a `backtick`, a tab\tand trailing spaces  ',
      "line three with a 'single quote' and a ; semicolon && chain",
    ].join('\n');

    await deliverToPane(client, pane, text, { settleMs: 1 });

    const setBufferCall = calls.find((c) => c.op === 'setBuffer');
    expect(setBufferCall?.args[0]).toBe(text);
    // Exactly one paste for the whole multi-line payload — never chunked or
    // split into per-line send-keys calls.
    expect(calls.filter((c) => c.op === 'pasteBuffer')).toHaveLength(1);
  });

  it('waits roughly the settle delay between paste and submit', async () => {
    const { client } = fakeTmux();
    const start = Date.now();
    await deliverToPane(client, pane, 'x', { settleMs: 50 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('does not submit when submit:false, and reports no submittedAt', async () => {
    const { client, calls } = fakeTmux();
    const telemetry = await deliverToPane(client, pane, 'x', { submit: false });
    expect(calls.some((c) => c.op === 'sendKeys')).toBe(false);
    expect(telemetry.submittedAt).toBeUndefined();
  });

  it('fails at "queued" when set-buffer fails, and never pastes', async () => {
    const { client, calls } = fakeTmux({ failAt: 'setBuffer' });
    const error = await deliverToPane(client, pane, 'x', { settleMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryStageError);
    expect((error as DeliveryStageError).stage).toBe('queued');
    expect(calls.some((c) => c.op === 'pasteBuffer')).toBe(false);
  });

  it('fails at "pasted" when paste-buffer fails, and never sends the submit key', async () => {
    const { client, calls } = fakeTmux({ failAt: 'pasteBuffer' });
    const error = await deliverToPane(client, pane, 'x', { settleMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryStageError);
    const stageError = error as DeliveryStageError;
    expect(stageError.stage).toBe('pasted');
    expect(stageError.partial.pastedAt).toBeUndefined();
    expect(calls.some((c) => c.op === 'sendKeys')).toBe(false);
  });

  it('fails at "submitted" when send-keys C-m fails, but records that the paste already happened', async () => {
    const { client } = fakeTmux({ failAt: 'sendKeys' });
    const error = await deliverToPane(client, pane, 'x', { settleMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryStageError);
    const stageError = error as DeliveryStageError;
    expect(stageError.stage).toBe('submitted');
    // The message is sitting un-submitted in the pane's input — a caller
    // must not re-paste on retry, only resubmit (see `resubmitPane`).
    expect(stageError.partial.pastedAt).toBeDefined();
  });
});

describe('resubmitPane', () => {
  it('sends only C-m, never re-pasting text that is already sitting in the input', async () => {
    const { client, calls } = fakeTmux();
    await resubmitPane(client, '%7', { settleMs: 1 });
    expect(calls).toEqual([{ op: 'sendKeys', args: ['%7', ['C-m']] }]);
  });
});

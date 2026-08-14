import { errorMessage } from '../core/errors.js';
import { nowIso, sleep } from '../core/time.js';
import { type DeliveryTelemetry } from '../domain/types.js';
import { type ResolvedPane } from '../infra/tmux/paneResolution.js';
import { type TmuxClient } from '../infra/tmux/tmux.js';

export type DeliveryStage = 'queued' | 'pasted' | 'submitted';

/**
 * Raised when any step of `deliverToPane` fails. Carries whatever telemetry
 * was gathered before the failure, so the caller never has to guess whether
 * text actually reached the pane before the failing step.
 */
export class DeliveryStageError extends Error {
  readonly stage: DeliveryStage;
  readonly paneId: string;
  readonly partial: Partial<DeliveryTelemetry>;

  constructor(
    stage: DeliveryStage,
    paneId: string,
    partial: Partial<DeliveryTelemetry>,
    cause: unknown,
  ) {
    super(`tmux delivery failed at "${stage}" for pane ${paneId}: ${errorMessage(cause)}`, {
      cause,
    });
    this.name = 'DeliveryStageError';
    this.stage = stage;
    this.paneId = paneId;
    this.partial = partial;
  }
}

export interface DeliverOptions {
  /** Press Enter after pasting. Defaults to true. */
  submit?: boolean;
  /** Delay between paste and Enter — most TUIs debounce paste-like input. */
  settleMs?: number;
  signal?: AbortSignal | undefined;
}

const DEFAULT_SETTLE_MS = 200;

/**
 * Delivers `text` to `pane` via the tmux paste buffer rather than
 * `send-keys -l`: a single `paste-buffer` writes the payload in one shot,
 * which survives embedded newlines, quotes and control characters exactly,
 * and does not risk a fast-typed `-l` submission being debounced/swallowed
 * by the TUI on the other end.
 *
 * Never silently reports success: a failure at any stage throws
 * `DeliveryStageError` carrying the timestamps gathered so far, so a message
 * is never marked delivered unless the paste *and* the submit both succeeded.
 */
export async function deliverToPane(
  tmux: Pick<TmuxClient, 'setBuffer' | 'pasteBuffer' | 'sendKeys'>,
  pane: ResolvedPane,
  text: string,
  options: DeliverOptions = {},
): Promise<DeliveryTelemetry> {
  const queuedAt = nowIso();
  try {
    await tmux.setBuffer(text);
  } catch (error) {
    throw new DeliveryStageError(
      'queued',
      pane.paneId,
      { paneId: pane.paneId, resolvedVia: pane.resolvedVia, queuedAt },
      error,
    );
  }

  let pastedAt: string;
  try {
    await tmux.pasteBuffer(pane.paneId, { delete: true });
    pastedAt = nowIso();
  } catch (error) {
    throw new DeliveryStageError(
      'pasted',
      pane.paneId,
      { paneId: pane.paneId, resolvedVia: pane.resolvedVia, queuedAt },
      error,
    );
  }

  if (options.submit === false) {
    return { paneId: pane.paneId, resolvedVia: pane.resolvedVia, queuedAt, pastedAt };
  }

  await sleep(options.settleMs ?? DEFAULT_SETTLE_MS, options.signal);

  try {
    await tmux.sendKeys(pane.paneId, ['C-m']);
  } catch (error) {
    throw new DeliveryStageError(
      'submitted',
      pane.paneId,
      { paneId: pane.paneId, resolvedVia: pane.resolvedVia, queuedAt, pastedAt },
      error,
    );
  }

  return {
    paneId: pane.paneId,
    resolvedVia: pane.resolvedVia,
    queuedAt,
    pastedAt,
    submittedAt: nowIso(),
  };
}

/**
 * Resubmits an already-pasted prompt without retyping it — used when a prior
 * attempt got as far as `pasted` but failed at `submitted`: the text is
 * already sitting in the pane's input, so re-pasting would duplicate it.
 */
export async function resubmitPane(
  tmux: Pick<TmuxClient, 'sendKeys'>,
  paneId: string,
  options: { settleMs?: number; signal?: AbortSignal | undefined } = {},
): Promise<string> {
  await sleep(options.settleMs ?? DEFAULT_SETTLE_MS, options.signal);
  await tmux.sendKeys(paneId, ['C-m']);
  return nowIso();
}

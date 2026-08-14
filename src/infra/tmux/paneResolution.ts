import { TransportError } from '../../core/errors.js';
import { type TmuxPaneInfo } from './tmux.js';

/** The subset of `TmuxClient` pane resolution needs — kept narrow so it is trivial to fake in tests. */
export interface PaneQueryClient {
  paneInfo(target: string): Promise<TmuxPaneInfo | undefined>;
  listPanes(): Promise<TmuxPaneInfo[]>;
}

export type PaneResolutionSource = 'pane-id' | 'qualified-fallback' | 'rediscovered';

export interface ResolvedPane extends TmuxPaneInfo {
  resolvedVia: PaneResolutionSource;
}

export interface ResolvePaneOptions {
  /** A previously persisted pane id to try first (see `Agent.tmuxPane`). */
  paneIdHint?: string | undefined;
  /** Included in the not-found error for a more actionable message. */
  agentId?: string | undefined;
}

/**
 * Resolves a live tmux pane for `session`, in three steps:
 *
 * 1. The persisted `paneIdHint`, if it still points at a live pane in this
 *    session. This is the fast path once an agent has dispatched once.
 * 2. The fully-qualified fallback `=session:0.0`. Unlike a bare `=session`
 *    target (which `has-session` accepts but `send-keys`/`display-message`
 *    silently fail to resolve to a pane — see `docs/runtime.md`), this is
 *    unambiguous and works.
 * 3. A full `list-panes -a` scan, matched by session name, preferring the
 *    lowest window/pane index among live panes. Handles a renamed/rebuilt
 *    window, or a session recreated after a tmux server restart.
 *
 * Throws `TransportError` with the expected session and every pane currently
 * on the server when nothing matches, so the caller can act on it directly
 * instead of guessing from a bare tmux error string.
 */
export async function resolvePane(
  client: PaneQueryClient,
  session: string,
  options: ResolvePaneOptions = {},
): Promise<ResolvedPane> {
  if (options.paneIdHint) {
    const hinted = await client.paneInfo(options.paneIdHint);
    // The session-name check guards against a pane id that was reused after a
    // full tmux server restart (pane ids reset and can coincidentally match a
    // stale hint) pointing at a pane that has nothing to do with this agent.
    if (hinted && !hinted.dead && hinted.sessionName === session) {
      return { ...hinted, resolvedVia: 'pane-id' };
    }
  }

  const qualified = await client.paneInfo(`=${session}:0.0`);
  if (qualified && !qualified.dead) {
    return { ...qualified, resolvedVia: 'qualified-fallback' };
  }

  const panes = await client.listPanes();
  const candidate = panes
    .filter((p) => p.sessionName === session && !p.dead)
    .sort((a, b) => a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex)[0];
  if (candidate) return { ...candidate, resolvedVia: 'rediscovered' };

  throw new TransportError(describeNoPane(session, panes, options.agentId));
}

function describeNoPane(
  session: string,
  panes: readonly TmuxPaneInfo[],
  agentId: string | undefined,
): string {
  const who = agentId ? `agent "${agentId}"` : 'the agent';
  const available = panes.length
    ? panes
        .map(
          (p) =>
            `  ${p.paneId}\tsession=${p.sessionName}\twindow=${p.windowIndex}\tpane=${p.paneIndex}\tdead=${p.dead ? 1 : 0}`,
        )
        .join('\n')
    : '  (no panes on the tmux server)';
  return (
    `No live tmux pane found for ${who}; expected session "${session}".\n` +
    `Available panes:\n${available}\n` +
    'Re-create or re-attach the tmux session, then retry delivery with `agentctl task redeliver <task-id>`.'
  );
}

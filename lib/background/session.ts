import type { PlaybackSession } from '../types';
import type { BackgroundContext } from './context';

/** Messages the session's player frame; navigation failures are owned by the session. */
export async function toPlayer(
  ctx: BackgroundContext,
  type: string,
  data: Record<string, unknown> = {},
  owner = ctx.session,
) {
  if (!owner) return;
  try {
    const reply = await chrome.tabs.sendMessage(
      owner.candidate.tabId,
      { type, sessionId: owner.id, ...data },
      { frameId: owner.candidate.frameId },
    );
    // Diagnostic transport must not turn an acknowledged media delivery into
    // a playback failure. The normal event channel also submits these records.
    await forwardTerminals(owner, reply?.terminals).catch(() => {});
    return reply;
  } catch {
    /* Navigation is handled by the session owner. */
  }
}

export async function forwardTerminals(owner: PlaybackSession, entries: unknown) {
  if (!Array.isArray(entries)) return;
  const events = entries.filter(
    (event) =>
      event &&
      event.type === 'player:metric' &&
      event.kind === 'terminal' &&
      event.sessionId === owner.id &&
      Number.isInteger(event.epoch) &&
      event.epoch <= owner.epoch &&
      Number.isInteger(event.languageVersion ?? 0) &&
      (event.languageVersion ?? 0) <= (owner.languageVersion ?? 0),
  );
  if (events.length)
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'engine:terminals',
      sessionId: owner.id,
      events,
    });
}

/** Cleanup for a session the caller already owns inside the transition queue. */
export async function stopOwned(
  ctx: BackgroundContext,
  previous: PlaybackSession | null,
  detached?: Promise<unknown>,
) {
  if (previous && ctx.session?.id === previous.id) ctx.session = null;
  await (detached ?? (previous ? toPlayer(ctx, 'player:stop', {}, previous) : Promise.resolve()));
  if (previous) await ctx.toOffscreen('engine:stop', { sessionId: previous.id }).catch(() => {});
  if (previous && !ctx.panelWatches(previous.candidate.tabId))
    ctx.releaseObservation(previous.candidate.tabId);
  // A new start cannot overtake this cleanup: all lifecycle work shares a queue.
  if (!ctx.session) {
    await chrome.storage.session.remove('activeSession');
    await ctx.rules.clear();
    void chrome.runtime.sendMessage({ type: 'session:updated', session: null }).catch(() => {});
  }
}

/** Stops the current session (or only `expectedId`) and invalidates pending starts. */
export function stopSession(ctx: BackgroundContext, expectedId?: string): Promise<void> {
  if (expectedId && ctx.session?.id !== expectedId) return Promise.resolve();
  ctx.transitions.invalidate();
  ctx.languageRequest++;
  const previous = ctx.session;
  ctx.session = null;
  const detached = previous ? toPlayer(ctx, 'player:stop', {}, previous) : Promise.resolve();
  return ctx.transitions.run(() => stopOwned(ctx, previous, detached));
}

/** Whether a message still targets the current seek/language revision. */
export function isCurrentRevision(
  session: PlaybackSession | null,
  message: { sessionId?: unknown; epoch?: unknown; languageVersion?: unknown },
): session is PlaybackSession {
  return (
    !!session &&
    session.id === message.sessionId &&
    (session.languageVersion ?? 0) === (message.languageVersion ?? 0) &&
    session.epoch === message.epoch
  );
}

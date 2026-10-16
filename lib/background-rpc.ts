import type { Envelope, Result } from './types';

const IDEMPOTENT = new Set([
  'settings:get', 'media:refresh', 'media:headers', 'auth:install', 'auth:remove',
  'engine:state', 'engine:segment',
]);
const BACKOFF_MS = [100, 300, 800] as const;
const channelFailure = (error: unknown) => /message (?:port|channel) closed|receiving end does not exist|could not establish connection|service worker.*(?:stopped|terminated|inactive)/i
  .test(error instanceof Error ? error.message : String(error));

/** MV3 workers can disappear mid-response. Retry only operations whose effects
 * remain safe after an ACK was lost. Application failures are never retried. */
export function createBackgroundRpc(
  send: (message: Envelope) => Promise<unknown>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  return async function background<T = unknown>(
    type: string,
    parameters: Record<string, unknown> = {},
  ): Promise<T> {
    let response: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await send({ ...parameters, target: 'background', type });
        break;
      } catch (error) {
        if (!IDEMPOTENT.has(type) || !channelFailure(error) || attempt >= BACKOFF_MS.length)
          throw error;
        await sleep(BACKOFF_MS[attempt]!);
      }
    }
    const result = response as Result<T> | undefined;
    if (!result || typeof result.ok !== 'boolean') throw new Error('扩展后台未返回有效响应，请重试');
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
}

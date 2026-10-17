import type { BackgroundResponse, BackgroundType, RequestArgs, Result } from '../../lib/messages';
import { AppError } from '../../lib/errors';

export type { PublicSettings, StorageSummary } from '../../lib/messages';

/** Typed side-panel call into the background message routes. */
export async function call<K extends BackgroundType>(
  type: K,
  ...[parameters]: RequestArgs<K>
): Promise<BackgroundResponse<K>> {
  const result = (await chrome.runtime.sendMessage({
    target: 'background',
    type,
    ...parameters,
  })) as Result<BackgroundResponse<K>>;
  if (!result.ok)
    throw result.code ? new AppError(result.code, result.error) : new Error(result.error);
  return result.value;
}

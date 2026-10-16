import type { Result, Settings } from '../../lib/types';
import type { ArchiveStorageSummary } from '../../lib/local-files';
import type { MediaTempSummary } from '../../lib/range-media';

export type PublicSettings = Omit<Settings, 'apiKey'> & { hasKey: boolean };
export interface StorageSummary {
  playback: { bytes: number; limitBytes: number };
  media: MediaTempSummary;
  archives: ArchiveStorageSummary;
}
export async function call<T = unknown>(type: string, parameters: Record<string, unknown> = {}): Promise<T> {
  const result = await chrome.runtime.sendMessage({ target: 'background', type, ...parameters }) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

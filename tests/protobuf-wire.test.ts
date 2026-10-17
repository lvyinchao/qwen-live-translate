import { expect, it } from 'vitest';
import { preserveSabrContext } from '../lib/protobuf-wire';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
it('retains opaque native client attestation while updating continuation fields', () => {
  const base = VideoPlaybackAbrRequest.encode({
    streamerContext: {
      clientInfo: { clientVersion: 'native' },
      poToken: new Uint8Array([7, 8]),
      sabrContexts: [],
      unsentSabrContexts: [],
    },
    initializationFormatIds: [],
    bufferedRanges: [],
    selectedAudioFormatIds: [],
    selectedVideoFormatIds: [],
    selectedCaptionFormatIds: [],
    ssapPlaybackInfos: [],
    field1000: [],
  }).finish();
  // Unknown field 42 inside the context: schema re-encoding would discard it.
  const raw = Uint8Array.from([...base.slice(0, 2), base[2]! + 3, ...base.slice(3), 0xd0, 2, 9]);
  const fresh = VideoPlaybackAbrRequest.encode({
    clientAbrState: { playerTimeMs: '90000' },
    streamerContext: {
      clientInfo: { clientVersion: 'changed' },
      poToken: new Uint8Array([1]),
      playbackCookie: new Uint8Array([3]),
      sabrContexts: [],
      unsentSabrContexts: [],
    },
    initializationFormatIds: [],
    bufferedRanges: [],
    selectedAudioFormatIds: [],
    selectedVideoFormatIds: [],
    selectedCaptionFormatIds: [],
    ssapPlaybackInfos: [],
    field1000: [],
  }).finish();
  const result = preserveSabrContext(raw, fresh);
  const decoded = VideoPlaybackAbrRequest.decode(result);
  expect(decoded.clientAbrState?.playerTimeMs).toBe('90000');
  expect(decoded.streamerContext?.clientInfo?.clientVersion).toBe('native');
  expect(decoded.streamerContext?.poToken).toEqual(new Uint8Array([7, 8]));
  expect(decoded.streamerContext?.playbackCookie).toEqual(new Uint8Array([3]));
  expect(Array.from(result)).toContain(0xd0);
});
it('rejects invalid native framing before any network request', () => {
  expect(() => preserveSabrContext(new Uint8Array([0x9a, 1, 255]), new Uint8Array())).toThrow();
  expect(() => preserveSabrContext(new Uint8Array(), new Uint8Array())).toThrow('上下文');
});

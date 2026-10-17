import {
  VideoPlaybackAbrRequest,
  MediaHeader,
  NextRequestPolicy,
  StreamProtectionStatus,
  UMPPartId,
} from 'googlevideo/protos';
import { SabrStream } from 'googlevideo/sabr-stream';
import {
  buildSabrFormat,
  EnabledTrackTypes,
  Logger,
  LogLevel,
} from 'googlevideo/utils';
import { decode64, encode64 } from './audio';
import { safeMediaUrl } from './security';
import { preserveSabrContext } from './protobuf-wire';
import type { AudioSource } from './types';

const flatten = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Incremental UMP framing; headers and media may cross arbitrary network chunks. */
export class UmpFramer {
  private pending = new Uint8Array(0);
  push(chunk: Uint8Array, consume: (type: number, data: Uint8Array) => void) {
    const bytes = flatten([this.pending, chunk]);
    let offset = 0;
    const integer = (at: number): [number, number] | undefined => {
      const first = bytes[at];
      if (first === undefined) return;
      const length =
        first < 128
          ? 1
          : first < 192
            ? 2
            : first < 224
              ? 3
              : first < 240
                ? 4
                : 5;
      if (at + length > bytes.length) return;
      if (length === 1) return [first, 1];
      if (length === 5)
        return [
          new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getUint32(
            0,
            true,
          ),
          5,
        ];
      let value = first & ((1 << (8 - length)) - 1),
        factor = 2 ** (8 - length);
      for (let i = 1; i < length; i++) {
        value += bytes[at + i]! * factor;
        factor *= 256;
      }
      return [value, length];
    };
    while (offset < bytes.length) {
      const type = integer(offset);
      if (!type) break;
      const size = integer(offset + type[1]);
      if (!size) break;
      if (size[0] > 16 * 1024 * 1024)
        throw new Error('UMP 分片超过安全读取上限');
      const begin = offset + type[1] + size[1],
        end = begin + size[0];
      if (end > bytes.length) break;
      consume(type[0], bytes.subarray(begin, end));
      offset = end;
    }
    this.pending = bytes.slice(offset);
  }
}

/** Open a bounded, sequential audio stream using the page's own authorized SABR session. */
export function openSabrWindow(
  source: AudioSource,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  if (!source.sabrRequest || end - start > 90.1 || !safeMediaUrl(source.url))
    throw new Error('无效的 SABR 读取窗口');
  const nativeBytes = decode64(source.sabrRequest);
  const request = VideoPlaybackAbrRequest.decode(nativeBytes);
  const nativeTrack = request.clientAbrState?.audioTrackId;
  const formats = (source.sabrFormats ?? [])
    .filter((f) =>
      nativeTrack ? f.audioTrackId === nativeTrack : f.isDefault !== false,
    )
    .map((f) => ({
      ...buildSabrFormat({ ...f, bitrate: f.bitrate ?? 0 }),
      isDrc: !!f.isDrc,
      audioTrackId: f.audioTrackId,
    }));
  const chosen = request.selectedAudioFormatIds?.[0];
  const audio =
    formats.find(
      (f) => chosen && f.itag === chosen.itag && f.xtags === chosen.xtags,
    ) ??
    formats.find(
      (f) => f.itag === 140 && f.isDrc === !!request.clientAbrState?.drcEnabled,
    ) ??
    formats.find((f) => f.itag === 140) ??
    formats[0];
  const context = request.streamerContext;
  if (!audio || !request.videoPlaybackUstreamerConfig || !context?.clientInfo)
    throw new Error('播放器尚未提供完整 SABR 音轨信息，请播放几秒后重新扫描');
  Logger.getInstance().setLogLevels(LogLevel.NONE);
  const diagnostics: Record<string, unknown>[] = [];
  const sabr = new SabrStream({
    videoId: source.identity.split(':')[1]!,
    formats,
    serverAbrStreamingUrl: source.url,
    videoPlaybackUstreamerConfig: encode64(
      request.videoPlaybackUstreamerConfig,
    ),
    clientInfo: context.clientInfo,
    poToken: context.poToken ? encode64(context.poToken) : undefined,
    audioHighWaterMark: 256 * 1024,
    fetchFunction: async (url, init) => {
      if (!safeMediaUrl(String(url)))
        throw new Error('SABR 重定向到了未允许的媒体域名');
      signal.throwIfAborted();
      const body =
        init?.body instanceof Uint8Array
          ? VideoPlaybackAbrRequest.decode(init.body)
          : undefined;
      if (body?.streamerContext) {
        const next = body.streamerContext;
        body.streamerContext = {
          ...context,
          ...next,
          playbackCookie: next.playbackCookie ?? context.playbackCookie,
          sabrContexts: [
            ...new Map(
              [...context.sabrContexts, ...next.sabrContexts].map((c) => [
                c.type,
                c,
              ]),
            ).values(),
          ],
        };
        init = {
          ...init,
          body: preserveSabrContext(
            nativeBytes,
            VideoPlaybackAbrRequest.encode(body).finish(),
          ),
        };
      }
      const record: {
        host: string;
        time?: unknown;
        headers: { start?: unknown; duration?: unknown; itag?: unknown; init?: unknown }[];
        policy?: { target?: unknown; backoff?: unknown };
        protection?: unknown;
      } = {
        host: new URL(String(url)).hostname,
        time: body?.clientAbrState?.playerTimeMs,
        headers: [],
      };
      diagnostics.push(record);
      if (diagnostics.length > 8) diagnostics.shift();
      const response = await fetch(url, {
        ...init,
        credentials: 'include',
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (!response.ok)
        throw new Error(
          `YouTube SABR 读取失败（HTTP ${response.status}），请刷新播放凭据后重试`,
        );
      if (!response.body) return response;
      const framer = new UmpFramer();
      return new Response(
        response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              framer.push(chunk, (type, data) => {
                if (type === UMPPartId.MEDIA_HEADER) {
                  const h = MediaHeader.decode(data);
                  if (h.videoId && h.videoId !== source.identity.split(':')[1])
                    throw new Error('音轨属于广告或其他视频，已停止');
                  if (record.headers.length < 20)
                    record.headers.push({
                      start: h.startMs,
                      duration: h.durationMs,
                      itag: h.itag ?? h.formatId?.itag,
                      init: h.isInitializationSegment,
                    });
                }
                if (type === UMPPartId.NEXT_REQUEST_POLICY) {
                  const p = NextRequestPolicy.decode(data);
                  record.policy = {
                    target: p.targetAudioReadaheadMs,
                    backoff: p.backoffTimeMs,
                  };
                }
                if (type === UMPPartId.STREAM_PROTECTION_STATUS)
                  record.protection =
                    StreamProtectionStatus.decode(data).status;
              });
              controller.enqueue(chunk);
            },
          }),
        ),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    },
  });
  const abort = () => {
    void sabr.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  const { audioStream } = sabr.start({
    audioFormat: audio,
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    startTimeMs: Math.floor(start * 1000),
    isPostLiveDvr: false,
    maxRetries: 2,
    stallDetectionMs: 10000,
  });
  let bytes = 0;
  const stream = audioStream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 32 * 1024 * 1024) throw new Error('SABR 窗口超出读取上限');
        controller.enqueue(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        );
      },
    }),
  );
  return {
    stream,
    diagnostics,
    close: async () => {
      signal.removeEventListener('abort', abort);
      await sabr.abort();
    },
  };
}

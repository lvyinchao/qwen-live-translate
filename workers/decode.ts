import {
  ALL_FORMATS,
  AudioSampleSink,
  Input,
  UrlSource,
  ReadableStreamSource,
} from 'mediabunny';
import { renderMono } from '../lib/audio';
import { openSabrWindow } from '../lib/sabr';
import { messageError } from '../lib/types';
import { RangeMediaCache } from '../lib/range-media';

const mediaCache = new RangeMediaCache();

const inputs = new Map<string, Input>();
self.onmessage = async (event) => {
  const { id, type, source, start, end, expectedDuration } = event.data;
  if (type === 'cancel') {
    inputs.get(id)?.dispose();
    inputs.delete(id);
    return;
  }
  let input: Input | undefined;
  let sabr: ReturnType<typeof openSabrWindow> | undefined;
  try {
    if (source.sabrRequest)
      sabr = openSabrWindow(source, start, end, AbortSignal.timeout(45000));
    input = new Input({
      formats: ALL_FORMATS,
      formatOptions: { hls: { offsetTimestampsByDateTime: false } },
      source: sabr
        ? new ReadableStreamSource(sabr.stream, {
            maxCacheSize: 8 * 1024 * 1024,
            handleUnhandledError: () => {},
          })
        : new UrlSource(source.url, {
            maxCacheSize: 8 * 1024 * 1024,
            parallelism: 2,
            requestInit: { credentials: 'include' },
            getRetryDelay: (attempt, error) =>
              attempt < 2 ? 2 ** attempt : null,
            fetchFn:
              source.kind === 'hls'
                ? (url, init) =>
                    source.hlsManifest &&
                    new URL(url instanceof Request ? url.url : String(url))
                      .href === new URL(source.url).href
                      ? Promise.resolve(
                          new Response(source.hlsManifest, {
                            headers: {
                              'Content-Type': 'application/vnd.apple.mpegurl',
                            },
                          }),
                        )
                      : fetch(url, {
                          ...init,
                          signal: init?.signal
                            ? AbortSignal.any([
                                init.signal,
                                AbortSignal.timeout(20000),
                              ])
                            : AbortSignal.timeout(20000),
                        })
                : mediaCache.fetch,
          }),
    });
    inputs.set(id, input);
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('媒体资源没有可解码的音轨');
    if (!(await track.canDecode()))
      throw new Error('当前浏览器不支持这条音轨的编码格式');
    if (!sabr && source.kind !== 'hls' && expectedDuration > 0) {
      const duration = await track.getDurationFromMetadata();
      if (
        duration !== null &&
        duration < expectedDuration - Math.max(2, expectedDuration * 0.01)
      )
        throw new Error(
          '发现的音频资源短于当前视频，可能属于广告或单个分片；未找到完整音轨，请重新扫描',
        );
    }
    const output = new Float32Array(Math.ceil((end - start) * 16000));
    const sink = new AudioSampleSink(track);
    let count = 0,
      decodedStart = Infinity,
      decodedEnd = -Infinity;
    for await (const sample of sink.samples(
      Math.max(0, start - 0.05),
      end + 0.05,
    )) {
      try {
        decodedStart = Math.min(decodedStart, sample.timestamp);
        decodedEnd = Math.max(
          decodedEnd,
          sample.timestamp + sample.numberOfFrames / sample.sampleRate,
        );
        const channels = Array.from(
          { length: sample.numberOfChannels },
          (_, planeIndex) => {
            const channel = new Float32Array(sample.numberOfFrames);
            sample.copyTo(channel, { format: 'f32-planar', planeIndex });
            return channel;
          },
        );
        renderMono(
          channels,
          sample.sampleRate,
          sample.timestamp,
          start,
          output,
        );
        count++;
      } finally {
        sample.close();
      }
    }
    if (!count) throw new Error('未读到该时间段的音频，请刷新资源地址后重试');
    if (decodedStart > start + 0.08 || decodedEnd < end - 0.08)
      throw new Error(
        `音轨时间窗口不完整（需要 ${start.toFixed(2)}～${end.toFixed(2)} 秒，取得 ${decodedStart.toFixed(2)}～${decodedEnd.toFixed(2)} 秒）`,
      );
    (
      self as unknown as {
        postMessage: (data: unknown, transfer: Transferable[]) => void;
      }
    ).postMessage(
      { id, ok: true, samples: output.buffer, decodedStart, decodedEnd },
      [output.buffer],
    );
  } catch (error) {
    const pending = sabr?.diagnostics.some(
      (d) => d.protection === 2 || d.protection === 3,
    );
    self.postMessage({
      id,
      ok: false,
      error: pending
        ? '提前读取请求未通过 YouTube 音轨播放验证，当前版本无法继续。翻译已停止，原声设置已恢复；可以重载视频后再试。'
        : messageError(error),
      diagnostics:
        sabr?.diagnostics ?? (error as { diagnostics?: unknown })?.diagnostics,
    });
  } finally {
    input?.dispose();
    await sabr?.close();
    inputs.delete(id);
  }
};

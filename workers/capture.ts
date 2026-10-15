import { Input, WEBM, ReadableStreamSource, AudioSampleSink } from 'mediabunny';
import { renderMono } from '../lib/audio';
import { messageError } from '../lib/types';
let controller: ReadableStreamDefaultController<Uint8Array>;
let input: Input;
let start = 0;
let pcm = new Float32Array(30 * 16000);
let through = 0;
const emit = (end: number) => {
  const samples = pcm.slice(0, Math.round((end - start) * 16000));
  self.postMessage(
    { type: 'window', start, end, samples },
    { transfer: [samples.buffer] },
  );
  start = end;
  pcm = new Float32Array(30 * 16000);
};
async function decode() {
  try {
    input = new Input({
      formats: [WEBM],
      source: new ReadableStreamSource(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        }),
        { maxCacheSize: 16 * 1024 * 1024, handleUnhandledError: () => {} },
      ),
    });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode()))
      throw new Error('Captured audio cannot be decoded.');
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        const channels = Array.from(
          { length: sample.numberOfChannels },
          (_, planeIndex) => {
            const c = new Float32Array(sample.numberOfFrames);
            sample.copyTo(c, { format: 'f32-planar', planeIndex });
            return c;
          },
        );
        const end =
          sample.timestamp + sample.numberOfFrames / sample.sampleRate;
        renderMono(channels, sample.sampleRate, sample.timestamp, start, pcm);
        through = end;
        if (end >= start + 30) {
          emit(start + 30);
          renderMono(channels, sample.sampleRate, sample.timestamp, start, pcm);
        }
        self.postMessage({ type: 'progress', through });
      } finally {
        sample.close();
      }
    }
    if (through > start + 0.02) emit(through);
    self.postMessage({ type: 'ended', through });
  } catch (error) {
    self.postMessage({ type: 'error', error: messageError(error) });
  } finally {
    input?.dispose();
  }
}
self.onmessage = (e) => {
  if (e.data.type === 'start') void decode();
  if (e.data.type === 'chunk') controller.enqueue(new Uint8Array(e.data.bytes));
  if (e.data.type === 'end') controller.close();
};

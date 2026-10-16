import { describe, expect, it } from 'vitest';
import { pcm16, renderMono, wav } from '../lib/audio';
import {
  activeSegment,
  coverageEnd,
  mergeCoverage,
  planDub,
} from '../lib/timeline';
import { TranslationAssembler } from '../lib/qwen';
import { AUTH_RULE, authRule, safeMediaUrl } from '../lib/security';
import { observedAudio, normalizeAudioRequest } from '../lib/adapters';
import {
  DEFAULT_SETTINGS,
  messageError,
  type TranslationSegment,
} from '../lib/types';

describe('sample timing and resampling', () => {
  it('writes signed little-endian PCM without wraparound', () => {
    const data = pcm16(new Float32Array([-2, -1, 0, 1, 2]));
    const view = new DataView(data.buffer);
    expect(
      Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true)),
    ).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
  it('uses media timestamps and downmixes instead of joining packets', () => {
    const out = new Float32Array(32000);
    const one = new Float32Array(48000).fill(0.5);
    renderMono([one, one], 48000, 11, 10, out);
    expect(out[100]).toBe(0);
    expect(out[20000]).toBeCloseTo(0.5, 4);
  });
  it('low-pass filters frequencies above the target Nyquist frequency', () => {
    const source = Float32Array.from({ length: 48000 }, (_, i) =>
      Math.sin((2 * Math.PI * 12000 * i) / 48000),
    );
    const out = new Float32Array(16000);
    renderMono([source], 48000, 0, 0, out);
    const rms = Math.sqrt(
      out.subarray(100, 15900).reduce((n, v) => n + v * v, 0) / 15800,
    );
    expect(rms).toBeLessThan(0.03);
  });
  it('writes a correct mono WAV and rejects incomplete PCM', () => {
    const bytes = wav([new Uint8Array(48000)]);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(48000);
    expect(() => wav([new Uint8Array(3)])).toThrow();
  });
});
describe('continuous-picture timeline', () => {
  it('does not bridge a missing translated interval', () => {
    expect(
      coverageEnd(
        [
          { start: 0, end: 10 },
          { start: 15, end: 30 },
        ],
        5,
      ),
    ).toBe(10);
    expect(
      coverageEnd(
        [
          { start: 0, end: 10 },
          { start: 15, end: 30 },
        ],
        12,
      ),
    ).toBe(12);
    expect(
      mergeCoverage([
        { start: 10, end: 20 },
        { start: 0, end: 10 },
      ]),
    ).toEqual([{ start: 0, end: 20 }]);
  });
  it('accelerates to fit speech and respects the absolute speed cap', () => {
    expect(
      planDub({ start: 10, end: 14, audioDuration: 6 }, 10, 1),
    ).toMatchObject({ rate: 1.5, truncated: false });
    expect(
      planDub({ start: 10, end: 14, audioDuration: 12 }, 10, 1.5),
    ).toMatchObject({ rate: 2, truncated: true });
  });
  it('seeks within an utterance and expires it at the next timeline boundary', () => {
    expect(
      planDub({ start: 10, end: 14, audioDuration: 6 }, 12, 1).offset,
    ).toBe(3);
    expect(
      planDub({ start: 10, end: 14, audioDuration: 6 }, 14, 1).expired,
    ).toBe(true);
    const segments = [
      { id: 'a', start: 0, end: 3 },
      { id: 'b', start: 2, end: 4 },
    ] as TranslationSegment[];
    expect(activeSegment(segments, 2.5)?.id).toBe('b');
  });
});
describe('Qwen 3.8 message correlation', () => {
  function fixture() {
    const emitted: TranslationSegment[] = [];
    return {
      emitted,
      a: new TranslationAssembler(
        { start: 60, end: 90, mediaId: 'video', language: 'zh' },
        (s) => emitted.push(s),
      ),
    };
  }
  function speech(a: TranslationAssembler) {
    a.consume({
      type: 'input_audio_buffer.speech_started',
      item_id: 'src',
      audio_start_ms: 500,
      speaker_id: 1,
    });
    a.consume({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'src',
      delta: 'Hello',
    });
    a.consume({
      type: 'conversation.item.created',
      previous_item_id: 'src',
      item: { id: 'out', role: 'assistant' },
    });
    a.consume({
      type: 'response.audio_transcript.delta',
      item_id: 'out',
      delta: '你好',
    });
    a.consume({
      type: 'response.audio.delta',
      item_id: 'out',
      delta: btoa('\0\0'.repeat(24000)),
    });
    a.consume({
      type: 'response.done',
      response: { status: 'completed', output: [{ id: 'out' }] },
    });
  }
  it('waits for source timestamps and maps to the original video time', () => {
    const { a, emitted } = fixture();
    speech(a);
    expect(emitted).toHaveLength(0);
    a.consume({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'src',
      audio_end_ms: 2500,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      start: 60.5,
      end: 62.5,
      audioDuration: 1,
      sourceText: 'Hello',
      text: '你好',
      speaker: 1,
    });
    expect(a.coverage()).toBe(62.5);
    expect(a.finish()).toHaveLength(1);
  });
  it('rejects missing correlation instead of guessing timestamps', () => {
    const { a } = fixture();
    a.consume({ type: 'response.audio.delta', item_id: 'out', delta: 'AAA=' });
    expect(() => a.finish()).toThrow('时间戳');
  });
  it('rejects incomplete responses and untranslated source speech', () => {
    const { a } = fixture();
    expect(() =>
      a.consume({ type: 'response.done', response: { status: 'incomplete' } }),
    ).toThrow();
    a.consume({
      type: 'input_audio_buffer.speech_started',
      item_id: 'src',
      audio_start_ms: 0,
    });
    expect(() => a.finish()).toThrow('完整译音');
  });
});
describe('credential and request boundaries', () => {
  it('binds auth to an exact endpoint and extension initiator', () => {
    const r = authRule(
      { ...DEFAULT_SETTINGS, apiKey: 'test-secret', workspace: 'llm-test' },
      'testextension',
    );
    expect(r.id).toBe(AUTH_RULE);
    expect(r.condition.initiatorDomains).toEqual(['testextension']);
    const regex = new RegExp(r.condition.regexFilter!);
    expect(
      regex.test(
        'wss://llm-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
      ),
    ).toBe(true);
    expect(
      regex.test('wss://evil.test/?model=qwen3.8-livetranslate-flash-realtime'),
    ).toBe(false);
    expect(() =>
      authRule(
        { ...DEFAULT_SETTINGS, apiKey: 'test\r\nsecret', workspace: 'test' },
        'id',
      ),
    ).toThrow();
  });
  it('rejects credential-bearing and arbitrary media URLs', () => {
    expect(safeMediaUrl('https://user:pass@cdn.bilivideo.com/audio.m4s')).toBe(
      false,
    );
    expect(safeMediaUrl('http://127.0.0.1/audio')).toBe(false);
    expect(safeMediaUrl('https://bilivideo.com.evil.test/audio')).toBe(false);
    expect(safeMediaUrl('https://a.bilivideo.com/audio')).toBe(true);
  });
  it('retains signed parameters when normalizing individual audio requests', () => {
    const url = normalizeAudioRequest(
      'https://rr.googlevideo.com/videoplayback?itag=140&range=0-20&sig=abc&expire=123',
    );
    expect(url).toContain('sig=abc');
    expect(url).toContain('expire=123');
    expect(url).not.toContain('range=');
    expect(observedAudio(url, 'application/octet-stream')).toBe(true);
  });
  it('redacts provider secrets and signed media URLs from displayed errors', () => {
    expect(
      messageError(
        new Error('Bearer sk-real-key https://cdn.test/a?sig=secret'),
      ),
    ).not.toContain('sk-real-key');
    expect(messageError('https://cdn.test/a?sig=secret')).not.toContain('sig=');
  });
});
it('treats a final empty ASR result as VAD noise, but never ignores recognized speech', () => {
  const a = new TranslationAssembler({
    start: 0,
    end: 10,
    mediaId: 'v',
    language: 'zh',
  });
  a.consume({
    type: 'input_audio_buffer.speech_started',
    item_id: 'noise',
    audio_start_ms: 0,
  });
  a.consume({
    type: 'input_audio_buffer.speech_stopped',
    item_id: 'noise',
    audio_end_ms: 500,
  });
  expect(a.coverage()).toBe(0);
  expect(() => a.finish()).toThrow();
  a.consume({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'noise',
    transcript: '',
  });
  expect(a.coverage()).toBe(0.5);
  expect(a.finish()).toEqual([]);
  a.consume({
    type: 'input_audio_buffer.speech_started',
    item_id: 'word',
    audio_start_ms: 1000,
  });
  a.consume({
    type: 'input_audio_buffer.speech_stopped',
    item_id: 'word',
    audio_end_ms: 2000,
  });
  a.consume({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'word',
    transcript: 'hello',
  });
  expect(() => a.finish()).toThrow('完整译音');
});

import { clockDiscontinuity } from '../lib/timeline';
it('distinguishes native player resets from ordinary and throttled playback clocks', () => {
  expect(clockDiscontinuity(120, 0, 0.25, 1)).toBe(true);
  expect(clockDiscontinuity(10, 120, 0.25, 1)).toBe(true);
  expect(clockDiscontinuity(10, 10.5, 0.25, 2)).toBe(false);
  expect(clockDiscontinuity(10, 130, 60, 2)).toBe(false);
});

it('does not accept Bilibili video-only requests as audio while retaining its real audio variants', () => {
  expect(
    observedAudio(
      'https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/25985482844_x1-1-100022.m4s',
      'video/mp4',
    ),
  ).toBe(false);
  expect(
    observedAudio(
      'https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/25985482844-1-30216.m4s',
      'video/mp4',
    ),
  ).toBe(true);
});

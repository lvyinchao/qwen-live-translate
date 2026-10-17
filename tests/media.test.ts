import { it, expect } from 'vitest';
import { CompositeBuffer, UmpWriter } from 'googlevideo/ump';
import { UmpFramer } from '../lib/sabr';
import { utteranceWindows } from '../lib/audio';
it('parses UMP correctly even when every byte arrives separately', () => {
  const buffer = new CompositeBuffer();
  const writer = new UmpWriter(buffer);
  const payload = Uint8Array.from({ length: 70000 }, (_, i) => i % 251);
  writer.write(20, new Uint8Array([1, 2, 3]));
  writer.write(21, payload);
  writer.write(22, new Uint8Array([0]));
  const parser = new UmpFramer(),
    parts: { type: number; data: Uint8Array }[] = [];
  const consume = (type: number, data: Uint8Array) => parts.push({ type, data: data.slice() });
  for (const chunk of buffer.chunks)
    for (let i = 0; i < chunk.length;) {
      const n = i < 12 ? 1 : Math.min(131, chunk.length - i);
      parser.push(chunk.subarray(i, i + n), consume);
      i += n;
    }
  expect(parts.map((p) => p.type)).toEqual([20, 21, 22]);
  expect(parts[1]!.data).toEqual(payload);
});
it('cuts source audio in quiet gaps, preserving a gap-free bounded timeline', () => {
  const rate = 16000,
    audio = new Float32Array(30 * rate).fill(0.2);
  for (const time of [3, 7, 10, 15, 19, 23, 27])
    audio.fill(0, (time - 0.2) * rate, (time + 0.2) * rate);
  const windows = utteranceWindows(audio);
  expect(windows[0]!.start).toBe(0);
  expect(windows.at(-1)!.end).toBe(audio.length);
  expect(windows[0]!.end / rate).toBeCloseTo(3, 1);
  windows.forEach((w, i) => {
    expect(w.end - w.start).toBeLessThanOrEqual(12 * rate);
    if (i) expect(w.start).toBe(windows[i - 1]!.end);
  });
  expect(windows.length).toBeGreaterThan(5);
});
it('bounds dense speech and handles an empty audio window', () => {
  const windows = utteranceWindows(new Float32Array(35 * 16000).fill(0.1));
  expect(windows.length).toBeGreaterThan(2);
  expect(windows.every((w) => w.end - w.start <= 12 * 16000)).toBe(true);
  expect(utteranceWindows(new Float32Array())).toEqual([]);
});

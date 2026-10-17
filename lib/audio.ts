export function encode64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
export function decode64(text: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(text);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
export function pcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, i) =>
    view.setInt16(
      i * 2,
      Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)),
      true,
    ),
  );
  return bytes;
}
export function wav(parts: Uint8Array[], sampleRate = 24000): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (size % 2) throw new Error('译音 PCM 字节长度不完整');
  const out = new Uint8Array(44 + size);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((v, i) => view.setUint8(offset + i, v.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, size, true);
  let offset = 44;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
// Windowed-sinc low-pass resampling. The media timestamp is used as the sample
// origin so decoded packet boundaries never accumulate rounding drift.
export function renderMono(
  channels: Float32Array[],
  rate: number,
  timestamp: number,
  windowStart: number,
  output: Float32Array,
  targetRate = 16000,
): void {
  if (!channels.length || !channels[0]?.length) return;
  const length = channels[0].length;
  const first = Math.max(0, Math.ceil((timestamp - windowStart) * targetRate));
  const last = Math.min(
    output.length,
    Math.floor((timestamp + length / rate - windowStart) * targetRate),
  );
  const cutoff = Math.min(1, targetRate / rate) * 0.94;
  const radius = 16;
  for (let outIndex = first; outIndex < last; outIndex++) {
    const pos = (windowStart + outIndex / targetRate - timestamp) * rate;
    const center = Math.floor(pos);
    let sum = 0,
      weights = 0;
    for (let tap = -radius + 1; tap <= radius; tap++) {
      const index = center + tap;
      if (index < 0 || index >= length) continue;
      const distance = pos - index;
      const x = Math.PI * distance * cutoff;
      const weight =
        (Math.abs(x) < 1e-10 ? 1 : Math.sin(x) / x) *
        (0.5 + 0.5 * Math.cos((Math.PI * distance) / radius)) *
        cutoff;
      let value = 0;
      for (const channel of channels) value += channel[index] ?? 0;
      sum += (value / channels.length) * weight;
      weights += weight;
    }
    output[outIndex] = weights ? sum / weights : 0;
  }
}
export function silenceBoundary(
  samples: Float32Array,
  maxSeconds: number,
  sampleRate = 16000,
): number {
  const end = Math.min(samples.length, Math.floor(maxSeconds * sampleRate));
  const minimum = Math.max(0, end - 5 * sampleRate);
  const window = Math.floor(sampleRate * 0.4);
  for (let i = end; i - window > minimum; i -= Math.floor(sampleRate * 0.1)) {
    let square = 0;
    for (let j = i - window; j < i; j++) square += (samples[j] ?? 0) ** 2;
    if (Math.sqrt(square / window) < 0.008) return i;
  }
  return end;
}

/** Non-overlapping utterance windows, cut in quiet gaps; dense speech is capped at 12 s. */
export function utteranceWindows(
  samples: Float32Array,
  rate = 16000,
): { start: number; end: number }[] {
  const frame = Math.round(rate * 0.02),
    energies: number[] = [];
  for (let offset = 0; offset < samples.length; offset += frame) {
    let sum = 0;
    const end = Math.min(samples.length, offset + frame);
    for (let i = offset; i < end; i++) sum += samples[i]! * samples[i]!;
    energies.push(Math.sqrt(sum / Math.max(1, end - offset)));
  }
  const threshold = Math.max(0.006, Math.max(0, ...energies) * 0.035);
  const gaps: number[] = [];
  let quiet = -1;
  for (let i = 0; i <= energies.length; i++) {
    if (i < energies.length && energies[i]! < threshold) {
      if (quiet < 0) quiet = i;
    } else if (quiet >= 0) {
      if (i - quiet >= 6) gaps.push(Math.floor((quiet + i) / 2) * frame);
      quiet = -1;
    }
  }
  const windows: { start: number; end: number }[] = [];
  let start = 0;
  while (start < samples.length) {
    const limit = Math.min(samples.length, start + 12 * rate);
    let end = limit;
    const gap = gaps.find(
      (p) => p >= start + 2 * rate && p <= limit && p < samples.length - 0.8 * rate,
    );
    if (gap !== undefined) end = gap;
    else if (limit < samples.length) {
      let best = Infinity;
      for (let i = Math.floor((limit - rate) / frame); i < Math.floor(limit / frame); i++)
        if (energies[i]! < best) {
          best = energies[i]!;
          end = i * frame;
        }
    }
    end = Math.max(start + 1, Math.min(samples.length, end));
    windows.push({ start, end });
    start = end;
  }
  return windows;
}

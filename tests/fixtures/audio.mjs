/** MIT-licensed deterministic test signal: no speech, provider calls or recordings. */
export function syntheticWav(duration = 3.84, sampleRate = 24000) {
  const frames = Math.round(duration * sampleRate);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const time = i / sampleRate;
    const ramp = Math.min(1, time / 0.02, (duration - time) / 0.02);
    const signal =
      Math.sin(2 * Math.PI * 220 * time) * 0.08 +
      Math.sin(2 * Math.PI * 330 * time) * 0.03;
    wav.writeInt16LE(Math.round(signal * ramp * 32767), 44 + i * 2);
  }
  return wav;
}

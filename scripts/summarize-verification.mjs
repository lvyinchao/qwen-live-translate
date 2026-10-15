import fs from 'node:fs/promises';
const quantile = (values, p) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
    : null;
};
const files = [
  'gate-bili-en-zh-original.json',
  'gate-bili-zh-en-original.json',
  'gate-long-original-voice.json',
  'gate-youtube-ja-zh-original.json',
  'gate-long-bili-original.json',
  'gate-bili-final.json',
  'gate-bili-worker-restart.json',
  'gate-youtube-final-failure.json',
];
const cases = [];
for (const file of files) {
  let r;
  try {
    r = JSON.parse(await fs.readFile('work/' + file, 'utf8'));
  } catch {
    continue;
  }
  const d = r.diagnostics?.value ?? {},
    events = d.events ?? [];
  const skipped = new Set(
    events
      .filter((e) => e.type === 'player:skip')
      .map((e) => `${e.epoch}:${e.segmentId}`),
  );
  const starts = events.filter(
    (e) => e.type === 'player:metric' && e.kind === 'start',
  );
  // Older preview builds misclassified late starts as seek entries. Derive the
  // initial source position from the test's explicit seek actions instead.
  const epochStarts = { 1: 0 };
  let epoch = 1;
  for (const a of r.actions ?? [])
    if (a.seek !== undefined) epochStarts[a.epoch ?? ++epoch] = a.seek;
  const eligible = starts.filter(
    (e) =>
      !skipped.has(`${e.epoch}:${e.segmentId}`) &&
      e.mediaTime - e.error >= (epochStarts[e.epoch] ?? 0) - 0.3,
  );
  const end = events.filter(
    (e) => e.type === 'player:metric' && e.kind === 'end',
  );
  const tokens = { inputAudio: 0, outputAudio: 0, outputText: 0 };
  const groups = new Map();
  let legacy = 0,
    previous = 0;
  for (const u of d.usage ?? []) {
    if (!u.providerSession && u.input_tokens < previous) legacy++;
    previous = u.input_tokens ?? 0;
    const key = u.providerSession ?? 'legacy-' + legacy;
    const old = groups.get(key) ?? {
      inputAudio: 0,
      outputAudio: 0,
      outputText: 0,
    };
    groups.set(key, {
      inputAudio: Math.max(
        old.inputAudio,
        u.input_tokens_details?.audio_tokens ?? 0,
      ),
      outputAudio: Math.max(
        old.outputAudio,
        u.output_tokens_details?.audio_tokens ?? 0,
      ),
      outputText: Math.max(
        old.outputText,
        u.output_tokens_details?.text_tokens ?? 0,
      ),
    });
  }
  for (const g of groups.values()) {
    tokens.inputAudio += g.inputAudio;
    tokens.outputAudio += g.outputAudio;
    tokens.outputText += g.outputText;
  }
  const yuan =
    (tokens.inputAudio * 40 +
      tokens.outputAudio * 160 +
      tokens.outputText * 100) /
    1e6;
  cases.push({
    file,
    url: r.url,
    ok: r.ok,
    error: r.error,
    firstReadyMs: r.firstReadyMs,
    actions: r.actions,
    restored: r.restored,
    rulesAfterStop: r.rulesAfterStop,
    failureState: r.failureState,
    normalPolicy: r.normalPolicy ?? file.includes('long-bili'),
    headless: !!r.headless,
    restoredAfterError: r.restoredAfterError,
    rulesAfterError: r.rulesAfterError,
    lastSnapshot: r.snapshots?.at(-1),
    continuousWallSeconds: r.continuousWallSeconds,
    continuousSourceSeconds: r.continuousSourceSeconds,
    memorySamples: r.memorySamples,
    metrics: {
      starts: starts.length,
      eligibleStarts: eligible.length,
      onsetAbsP95Ms: quantile(
        eligible.map((e) => Math.abs(e.error) * 1000),
        0.95,
      ),
      completedEnds: end.length,
      endSignedP50Ms: quantile(
        end.map((e) => e.error * 1000),
        0.5,
      ),
      endAbsP95Ms: quantile(
        end.map((e) => Math.abs(e.error) * 1000),
        0.95,
      ),
      skipped: skipped.size,
      skipRatio: starts.length ? skipped.size / starts.length : null,
      sourceInputSeconds: d.inputSeconds,
      translatedAudioSeconds: d.outputSeconds,
      bufferCount: d.bufferCount,
      cacheBytes: d.cacheBytes,
      providerTokens: tokens,
      estimatedYuan: yuan,
      estimatedYuanPerInputHour: d.inputSeconds
        ? (yuan / d.inputSeconds) * 3600
        : null,
    },
    notes: file.includes('long-bili')
      ? [
          '网站登录提示曾暂停原播放器，已关闭提示并通过播放按钮恢复。',
          '长测使用隔离 Chrome，正常自动播放策略。',
        ]
      : [],
  });
}
const siteReports = [];
for (const suffix of ['', '-youtube', '-bilibili']) {
  try {
    siteReports.push(
      ...JSON.parse(await fs.readFile(`work/gate-sites${suffix}.json`, 'utf8')),
    );
  } catch {}
}
const voice = JSON.parse(
  await fs.readFile('work/probe-original-sample.json', 'utf8'),
);
const config = voice.events?.find((e) => e.type === 'session.updated')?.session;
const data = {
  generatedAt: new Date().toISOString(),
  measurement:
    'HTMLAudioElement playing/ended events compared with HTMLVideoElement.currentTime. Not hardware audio loopback. P95 excludes deliberate seek entries and segments with truncated tails; skip ratio is reported separately.',
  cost: 'Beijing listed audio input/output and text output rates; provider-reported counters, taking the last/max cumulative snapshot per connection (verified against actual output duration), not summing snapshots. Estimate only, not a reconciled bill. Hourly figure normalized by uploaded source seconds and includes warmup/retry overhead.',
  voice: {
    ok: voice.ok,
    enableVoiceClone: config?.enable_voice_clone,
    frequency: config?.voice_clone_options?.frequency,
    voice: config?.voice,
    audioSegments: voice.segments?.length,
    sessionFinished: voice.events?.some((e) => e.type === 'session.finished'),
    perceptualSimilarityVerified: false,
  },
  ui: JSON.parse(await fs.readFile('work/ui-verification.json', 'utf8')),
  cases,
  siteReports,
};
await fs.writeFile(
  'outputs/验收数据.json',
  JSON.stringify(data, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    cases.map((c) => ({ file: c.file, ok: c.ok, ...c.metrics })),
    null,
    2,
  ),
);

import fs from 'node:fs/promises';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length)
  throw new Error('Pass only the fresh acceptance report JSON paths to summarize.');
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
};
const key = (event) => `${event.languageVersion ?? 0}:${event.epoch}:${event.segmentId}`;
const records = [];
for (const file of files) {
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  const diagnostics = report.diagnostics?.value ?? {};
  const events = diagnostics.events ?? [];
  const terminals = events.filter(
    (event) => event.type === 'player:metric' && event.kind === 'terminal',
  );
  const isTimelineCut = (event) => ['timeline-cut', 'overlap-cut'].includes(event.reason);
  const skips = new Set([
    ...events.filter((event) => event.type === 'player:skip').map(key),
    ...terminals.filter(isTimelineCut).map(key),
  ]);
  const starts = events.filter((event) => event.type === 'player:metric' && event.kind === 'start');
  const eligible = starts.filter((event) => !event.partial && !skips.has(key(event)));
  const validEligible = eligible.filter((event) => Number.isFinite(event.error));
  const invalidOnsets = eligible.length - validEligible.length;
  const ends = events.filter((event) => event.type === 'player:metric' && event.kind === 'end');
  const validEnds = ends.filter((event) => Number.isFinite(event.error));
  const played = new Set(starts.map(key));
  const all = new Set([...played, ...skips]);
  const remainingByCut = new Map();
  for (const event of [
    ...events.filter((event) => event.type === 'player:skip'),
    ...terminals.filter(isTimelineCut),
  ])
    if (Number.isFinite(event.remaining))
      remainingByCut.set(
        key(event),
        Math.max(remainingByCut.get(key(event)) ?? 0, event.remaining),
      );
  const classified = new Map();
  for (const event of terminals)
    if (played.has(key(event)) && !classified.has(key(event))) classified.set(key(event), event);
  if (!terminals.length) {
    for (const event of ends)
      if (played.has(key(event))) classified.set(key(event), { reason: 'natural-event' });
    for (const id of skips)
      if (played.has(id) && !classified.has(id))
        classified.set(id, { reason: 'legacy-cut-over-100ms' });
  }
  const reasons = {};
  for (const event of classified.values()) reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
  const groups = new Map();
  let knownUsageRecords = 0;
  for (const usage of diagnostics.usage ?? []) {
    if (!usage.providerSession) throw new Error(`Missing provider session for usage in ${file}`);
    if (
      [
        usage.input_tokens_details?.audio_tokens,
        usage.output_tokens_details?.audio_tokens,
        usage.output_tokens_details?.text_tokens,
      ].some(Number.isFinite)
    )
      knownUsageRecords++;
    const previous = groups.get(usage.providerSession) ?? {
      inputAudio: 0,
      outputAudio: 0,
      outputText: 0,
    };
    groups.set(usage.providerSession, {
      inputAudio: Math.max(previous.inputAudio, usage.input_tokens_details?.audio_tokens ?? 0),
      outputAudio: Math.max(previous.outputAudio, usage.output_tokens_details?.audio_tokens ?? 0),
      outputText: Math.max(previous.outputText, usage.output_tokens_details?.text_tokens ?? 0),
    });
  }
  const tokens = [...groups.values()].reduce(
    (sum, value) => ({
      inputAudio: sum.inputAudio + value.inputAudio,
      outputAudio: sum.outputAudio + value.outputAudio,
      outputText: sum.outputText + value.outputText,
    }),
    { inputAudio: 0, outputAudio: 0, outputText: 0 },
  );
  // Region-specific list prices, verified against official Model Studio pricing on
  // 2026-10-16. This estimate excludes discounts and incomplete/aborted usage.
  const region = report.modelRegion ?? process.env.ACCEPTANCE_REGION;
  if (region && !['cn-beijing', 'ap-southeast-1'].includes(region))
    throw new Error('Unsupported pricing region');
  const prices =
    region === 'cn-beijing'
      ? [40, 160, 100]
      : region === 'ap-southeast-1'
        ? [54.688, 218.752, 145.835]
        : null;
  const estimateCny =
    knownUsageRecords && prices
      ? (tokens.inputAudio * prices[0] +
          tokens.outputAudio * prices[1] +
          tokens.outputText * prices[2]) /
        1e6
      : null;
  const liveEvidence =
    /^https:\/\/www\.bilibili\.com\/video\//.test(report.url ?? '') &&
    /^[a-f0-9]{64}$/.test(report.buildSha256 ?? '') &&
    report.version === '0.2.2' &&
    knownUsageRecords > 0 &&
    diagnostics.inputSeconds > 0 &&
    report.provenance?.source === 'bilibili-native-real-provider' &&
    report.provenance.generatedAudio === false &&
    report.provenance.model === 'qwen3.8-livetranslate-flash-realtime' &&
    events.some((event) => event.type === 'provider:voice-confirmed');
  const onsetP95 = percentile(
    validEligible.map((event) => Math.abs(event.error) * 1000),
    0.95,
  );
  const memory = report.memorySamples ?? [];
  const peak = (values) => (values.length ? Math.max(...values) : null);
  let sampledWallMs = 0,
    sampledBufferMs = 0;
  for (let i = 1; i < (report.snapshots?.length ?? 0); i++) {
    const previous = report.snapshots[i - 1],
      current = report.snapshots[i];
    if (!Number.isFinite(previous.at) || !Number.isFinite(current.at)) continue;
    const elapsed = current.at - previous.at;
    sampledWallMs += elapsed;
    if (previous.phase === 'buffering') sampledBufferMs += elapsed;
  }
  records.push({
    file: path.basename(file),
    at: report.at,
    version: report.version,
    buildSha256: report.buildSha256,
    storageAfterStop: report.storageAfterStop,
    url: report.url,
    functionalPassed: report.ok === true,
    error: report.error,
    provenance: {
      liveEvidence,
      explicit: report.provenance ?? null,
      providerVoiceConfirmationEvents: events.filter(
        (event) => event.type === 'provider:voice-confirmed',
      ).length,
    },
    synchronizationPassed:
      liveEvidence &&
      report.ok === true &&
      invalidOnsets === 0 &&
      !(diagnostics.droppedCriticalEvents > 0) &&
      onsetP95 !== null &&
      onsetP95 <= 300,
    diagnosticRetention: {
      droppedCriticalEvents: diagnostics.droppedCriticalEvents ?? null,
      droppedDebugEvents: diagnostics.droppedDebugEvents ?? null,
      capturedAfterStop: report.diagnosticsCapturedAfterStop ?? false,
    },
    firstReadyMs: report.firstReadyMs,
    continuousSourceSeconds: report.continuousSourceSeconds,
    continuousWallSeconds: report.continuousWallSeconds,
    extendedSpeed: report.extendedSpeed ?? null,
    actions: report.actions,
    restored: report.restored,
    temporaryRulesAfterStop: report.rulesAfterStop,
    onset: {
      starts: starts.length,
      eligible: eligible.length,
      valid: validEligible.length,
      invalid: invalidOnsets,
      absoluteP95Ms: onsetP95,
      outlierCountOver300Ms: validEligible.filter((event) => Math.abs(event.error) > 0.3).length,
      outliersOver300Ms: validEligible
        .filter((event) => Math.abs(event.error) > 0.3)
        .slice(0, 20)
        .map(
          ({
            epoch,
            languageVersion,
            segmentId,
            error,
            mediaTime,
            frontendAt,
            videoTime,
            audioTime,
            readyState,
            preloadHit,
            readyThrough,
            stateVersion,
            tickGapMs,
            maxTickGapMs,
          }) => ({
            epoch,
            languageVersion,
            segmentId,
            errorMs: error * 1000,
            mediaTime,
            frontendAt,
            videoTime,
            audioTime,
            readyState,
            preloadHit,
            readyThrough,
            stateVersion,
            tickGapMs,
            maxTickGapMs,
          }),
        ),
    },
    ends: {
      completed: ends.length,
      valid: validEnds.length,
      invalid: ends.length - validEnds.length,
      signedP50Ms: percentile(
        validEnds.map((event) => event.error * 1000),
        0.5,
      ),
      absoluteP95Ms: percentile(
        validEnds.map((event) => Math.abs(event.error) * 1000),
        0.95,
      ),
    },
    completionCoverage: {
      format: terminals.length ? 'terminal-events-v1' : 'legacy-incomplete',
      uniqueStarts: played.size,
      classified: classified.size,
      unclassified: played.size - classified.size,
      reasons,
      smallTimelineCuts: [...classified.values()].filter(
        (event) => isTimelineCut(event) && event.remaining > 0 && event.remaining <= 0.1,
      ).length,
      largeTimelineCuts: [...classified.values()].filter(
        (event) => isTimelineCut(event) && event.remaining > 0.1,
      ).length,
      limitation: terminals.length
        ? 'A missing terminal remains unclassified; it is never inferred to be a natural completion.'
        : 'Legacy skip events recorded only tails above 100 ms. Other starts may include unrecorded small cuts, seeks, stops or active audio at capture.',
    },
    skips: {
      utterances: skips.size,
      playedOrSkipped: all.size,
      ratio: all.size ? skips.size / all.size : null,
      remainingAudioSeconds: [...remainingByCut.values()].reduce(
        (sum, remaining) => sum + remaining,
        0,
      ),
      remainingScope:
        'Recorded cuts only; missing completion classifications cannot be reconstructed.',
    },
    buffering: {
      count: diagnostics.bufferCount,
      sampledWallMs,
      sampledBufferMs,
      approximateWallRatio: sampledWallMs ? sampledBufferMs / sampledWallMs : null,
    },
    cost: {
      region: region ?? null,
      tokens,
      sessionsWithReportedUsage: groups.size,
      knownUsageRecords,
      aggregation:
        'Per-provider-session maxima inferred from observed monotonic usage snapshots; account billing semantics independently unverified',
      completedUsageListPriceLowerBoundCny: estimateCny,
      listPriceLowerBoundPerSourceVideoHourCny:
        estimateCny !== null && report.continuousSourceSeconds > 0
          ? (estimateCny / report.continuousSourceSeconds) * 3600
          : null,
      listPriceLowerBoundPerWallWatchHourCny:
        estimateCny !== null && report.continuousWallSeconds > 0
          ? (estimateCny / report.continuousWallSeconds) * 3600
          : null,
      accountBillVerified: false,
    },
    memory: {
      samples: memory.length,
      browserRssPeakMiB: peak(memory.map((sample) => sample.browserRssMiB).filter(Number.isFinite)),
      offscreenObservedHeapPeakBytes: peak(
        memory.map((sample) => sample.extensionHeap?.used).filter(Number.isFinite),
      ),
      playbackCachePeakDataBytes: peak(
        memory.map((sample) => sample.cacheBytes).filter(Number.isFinite),
      ),
    },
  });
}
const result = {
  at: new Date().toISOString(),
  scope:
    'Summaries of explicitly supplied report files; inspect each provenance and pass field. Headless Chromium software measurements, with no acoustic loopback or hardware A/V measurement and no numerical speaker-similarity score.',
  methodology: {
    onset:
      'Absolute source-video currentTime minus model source-turn start at audio playing. Excludes partial seek entries and utterances with skipped tails.',
    end: 'All observed natural audio ended events, including partial seek entries if present; a different population from eligible onsets. Source-video currentTime minus model source-turn end; shortened speech intentionally leaves a gap. Truncated tails are skips, not natural completed ends.',
    completion:
      'Every unique started utterance is classified from a terminal event when available. Legacy reports lack small-cut and stop classifications; missing terminals are shown explicitly, not counted as completion. Onset eligibility excludes recorded timeline/overlap cuts; legacy eligibility is incomplete for tails of 100 ms or less.',
    buffering:
      'Five-second sampling during continuous playback and any extended-speed interval, excluding startup and intentional pause/speed setup; approximate dwell ratio.',
    cost: 'Per-session maximum cumulative usage at response.done, then summed. Official configured-region list prices; incomplete/aborted responses may not report usage, so values are lower bounds, not an account bill. No usage or unknown region is null. Watch-hour extrapolation is available only for a measured continuous run and includes startup/prefetch/retries recorded in that report. No claim of full provider-billing coverage.',
    pricing: 'https://help.aliyun.com/zh/model-studio/model-pricing',
    memory:
      'RSS includes all processes in the isolated test browser and its video page. Observed offscreen V8 heap is approximate. Cache data sizes exclude database/filesystem metadata.',
  },
  records,
};
const destination = process.env.ACCEPTANCE_SUMMARY ?? 'outputs/acceptance-0.2.2.json';
await fs.writeFile(destination, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    destination,
    records: records.map(({ file, functionalPassed, synchronizationPassed, onset, skips }) => ({
      file,
      functionalPassed,
      synchronizationPassed,
      onset,
      skips,
    })),
  }),
);

import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

it('does not turn missing metrics, usage or a synthetic fixture into successful real acceptance', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timbradub-summary-'));
  try {
    const input = path.join(directory, 'fixture.json'), output = path.join(directory, 'summary.json');
    await fs.writeFile(input, JSON.stringify({at: '2000-01-01', version: 'fixture', ok: true,
      diagnostics: {value: {inputSeconds: 10, usage: [], events: [
        {type: 'player:metric', kind: 'start', epoch: 1, segmentId: 'valid', error: .1},
        {type: 'player:metric', kind: 'start', epoch: 1, segmentId: 'missing'},
      ]}}}));
    execFileSync(process.execPath, ['scripts/summarize-acceptance.mjs', input], {
      cwd: process.cwd(), env: {PATH: process.env.PATH, ACCEPTANCE_SUMMARY: output}, stdio: 'pipe',
    });
    const [record] = JSON.parse(await fs.readFile(output, 'utf8')).records;
    expect(record.functionalPassed).toBe(true);
    expect(record.synchronizationPassed).toBe(false);
    expect(record.provenance.liveEvidence).toBe(false);
    expect(record.onset).toMatchObject({eligible: 2, valid: 1, invalid: 1, absoluteP95Ms: 100});
    expect(record.cost.completedUsageListPriceLowerBoundCny).toBeNull();
    expect(record.memory.browserRssPeakMiB).toBeNull();
    expect(record.completionCoverage).toMatchObject({uniqueStarts: 2, classified: 0, unclassified: 2, format: 'legacy-incomplete'});
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

it('deduplicates terminal records, includes small cuts, and leaves missing completion unknown', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timbradub-terminal-summary-'));
  try {
    const input = path.join(directory, 'fixture.json'), output = path.join(directory, 'summary.json');
    const metric = (segmentId: string, kind: string, extra = {}) => ({type: 'player:metric', epoch: 1, segmentId, kind, ...extra});
    await fs.writeFile(input, JSON.stringify({ok: true, diagnostics: {value: {events: [
      ...['natural', 'small-cut', 'missing'].map((id) => metric(id, 'start', {error: .05})),
      metric('natural', 'terminal', {reason: 'natural', remaining: 0}),
      metric('natural', 'terminal', {reason: 'stop', remaining: 0}),
      metric('small-cut', 'terminal', {reason: 'timeline-cut', remaining: .06}),
    ]}}}));
    execFileSync(process.execPath, ['scripts/summarize-acceptance.mjs', input], {
      cwd: process.cwd(), env: {PATH: process.env.PATH, ACCEPTANCE_SUMMARY: output}, stdio: 'pipe',
    });
    const [record] = JSON.parse(await fs.readFile(output, 'utf8')).records;
    expect(record.completionCoverage).toMatchObject({format: 'terminal-events-v1', uniqueStarts: 3,
      classified: 2, unclassified: 1, reasons: {natural: 1, 'timeline-cut': 1}, smallTimelineCuts: 1, largeTimelineCuts: 0});
    expect(record.skips).toMatchObject({utterances: 1, playedOrSkipped: 3, remainingAudioSeconds: .06});
    expect(record.onset.eligible).toBe(2);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

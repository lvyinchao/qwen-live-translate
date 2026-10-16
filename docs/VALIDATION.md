# Compatibility and validation

This document distinguishes observed behavior from product goals. Detailed, dated evidence is in [the historical validation record](../outputs/真实验收记录.md), the [0.2.2 review and repair record](REVIEW-2026-10-16.md) and individual JSON reports in `outputs/`. Results from different versions or build hashes must not be combined into one acceptance claim.

## 0.2.2 software and distribution checks

The current candidate passed 181 unit tests in 29 files, all nine isolated browser gates, TypeScript checks, the production build and a dependency audit with zero known vulnerabilities. This includes seven real-browser audio checks for tails/classification/stop and bilingual title persistence. Earlier packages passed corresponding-source/package checks and actual download/install plus clean-source reproduction; those receipts retain their own package identities. The updated source-package reproduction and current 20-minute real-provider run are still pending. No unfinished check is counted as passed. Generated tones and controlled pages do not establish language quality or speaker similarity.

Final candidate runtime:

```text
dd3e6dc4cf0d82b964ad59122212d216fb35acfc57a818969e9192f062810968
```

The baseline runtime used for the 20-minute and first four short/extended cases is:

```text
8823267ec4059126957ab3e709ba6ffb56f5bf87e540c4ef509d1c04fb8482f3
```

This digest covers built runtime paths and file contents. ZIP digests are separate and appear in `SHA256SUMS.txt`. The separately attached CI/release smoke receipt names the archives actually verified; it is generated after packaging and excluded from the source ZIP. A changed source archive requires a matching new receipt.

The intermediate runtime `876c219bd2c2cdbdd1221a974b8eb733f9cb2b5c4d5fa697958c729a433a35ae` added settings serialization and YouTube track handling; its short-run onset failure remains historical evidence. The [build delta record](../outputs/final-build-delta-verification.json) now describes the current candidate: playback and scheduling diagnostics changed after a confirmed short-tail defect, so the earlier statement that seven core sources were unchanged no longer applies. Neither earlier runtime is an identical-binary substitute for the new run.

## Current-candidate playback and title follow-up

The earlier scheduler could stop or seek away the last tens of milliseconds when its ideal offset reached the audio duration even though the actual media element had not finished. A 60 ms reproduction fails when the old branch is restored. The current player lets a short tail finish naturally before the source boundary; a genuine boundary/overlap cut records every positive remaining duration, including 100 ms or less.

Each started utterance now receives a deduplicated terminal classification: natural completion, timeline/overlap cut, seek, language change, stop/error, video end or player loss. Terminal delivery checks task ownership and also travels through lifecycle acknowledgements, so ending an old epoch cannot pollute a replacement task. Missing classifications remain unknown. Onset/completion/provider-confirmation events use a separate bounded critical ring (20,000 records); detailed audio stages use a debug ring (1,000 records), with separate drop counters. Debug traffic must not evict the evidence used for acceptance, and critical drops must be disclosed.

Two fresh 90-second 1.5× cases completed on `dd3e…0968`; the English→Chinese 20-minute run is still in progress. The [acceptance summary](../outputs/acceptance-0.2.2.json) currently includes these two cases alongside the six historical reports, grouped by runtime identity.

| Current-candidate case | First ready | Eligible / starts; onset P95 | Natural ends; absolute end P95 | All positive cuts / starts | Small ≤100 ms / large >100 ms cuts; remaining audio | 1.5× wall / source advance | Sampled buffering |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Japanese→Chinese | 35.113 s | 14 / 37; 153.849 ms | 10; 704.304 ms | 23 / 37 (62.16%) | 11 / 12; 10.426 s | 90.877 / 67.097 s | 45.447 / 85.673 s (53.05%) |
| Chinese→English | 34.231 s | 7 / 41; 137.221 ms | 4; 438.402 ms | 33 / 41 (80.49%) | 8 / 25; 40.792 s | 91.994 / 66.143 s | 50.434 / 86.825 s (58.09%) |

Both scripted cases passed, with complete terminal classification: Japanese→Chinese 37/37 (10 natural, 23 timeline cuts, 3 seek stops, 1 stop), Chinese→English 41/41 (4 natural, 33 timeline cuts, 4 seek stops). Unknown terminals and dropped critical events were zero. This proves accounting coverage for these cases, not complete spoken playback: **62.16% and 80.49%** of their utterances were cut, and buffering occupied more than half of each sampled speed interval. Only the eligible onset subset met the 300 ms target.

The new cut counter includes every positive remaining duration; it must not be compared directly with the historical counter that omitted tails of 100 ms or less. All-case onset/end/cut counts include setup and seek interactions, while the wall/source and buffering columns describe the speed interval. Natural-end signed medians were −361.772 ms and −159.273 ms: shorter translated speech can finish before the source sentence and leave a gap. Their absolute end P95 is not purely a lateness metric, and 10/4 natural-end observations do not describe the whole population. No memory samples were taken in these short cases. Returned-usage Beijing list-price lower bounds were CNY 0.40490 and 0.60996 for the complete cases, with no verified bill or hourly extrapolation.

The new English→Chinese 20-minute outcome remains pending. The historical six-case table below is not a long-run pass result for the current candidate.

The in-panel product title, page title and toolbar tooltip follow the saved English/Chinese interface preference. This was verified during real translation and in the local Chrome installation; the prior Chinese preference was restored afterward. Chrome's installed-extension name and outer side-panel frame label use Chrome's browser language and cannot be changed at runtime by this setting.

## Historical 0.2.2 real-provider checks

The [acceptance summary](../outputs/acceptance-0.2.2.json) retains real Bilibili/provider provenance, runtime hashes and provider acknowledgement of original-voice mode. The following six cases are historical. Baseline English→Chinese playback completed 1201.049 source seconds in 1284.078 wall seconds; the case also exercised worker restart before its continuous interval. The intermediate `876c…35ae` English→Chinese short run reached 471.932 ms P95 and failed the onset target. The short-tail defect is now confirmed, but its contribution to that run's onset error has not been isolated; an environment/event-delay explanation is also unproven.

| Case and runtime | First ready | Eligible / all starts; onset P95 | Natural ends; absolute end P95 | Truncated / played-or-skipped; remaining speech | Measured interval: wall / source advance | Sampled buffering |
| --- | --- | --- | --- | --- | --- | --- |
| English→Chinese, 20-minute baseline `8823…2f3` | 35.900 s | 333 / 416; 43.525 ms | 5; 35.424 ms | 83 / 416 (19.95%); 49.889 s | 1×: 1284.078 / 1201.049 s | 81.053 / 1278.343 s (6.34%); 3 buffers |
| Japanese→Chinese, short `8823…2f3` | 35.725 s | 10 / 13; 295.928 ms | 2; 149.058 ms | 3 / 13 (23.08%); 1.600 s | No extended interval | Not sampled |
| Chinese→English, short `8823…2f3` | 34.664 s | 9 / 17; 170.996 ms | 2; 396.307 ms | 7 / 17 (41.18%); 8.288 s | No extended interval | Not sampled |
| Japanese→Chinese, extended `8823…2f3` | 34.701 s | 23 / 34; 41.867 ms | 4; 398.787 ms | 10 / 34 (29.41%); 7.994 s | 1.5×: 90.313 / 62.247 s | 45.144 / 85.267 s (52.94%) |
| Chinese→English, extended `8823…2f3` | 35.936 s | 13 / 39; 88.059 ms | 1; 69.686 ms | 25 / 39 (64.10%); 40.630 s | 1.5×: 90.460 / 60.318 s | 50.142 / 85.434 s (58.69%) |
| English→Chinese, intermediate short `876c…35ae` | 34.252 s | 12 / 23; **471.932 ms — failed** | 1; 31.281 ms | 10 / 23 (43.48%); 4.426 s | No extended interval | Not sampled |

Onset/end/truncation counts describe the complete case, including setup playback, continuous/extended intervals and any seeks; an interval alone is not their denominator. The legacy truncation counter records tails with more than 100 ms of translated audio remaining. Buffering uses five-second samples, omitting the first unsampled span. The historical 1.5× experience remains limited: the Chinese→English case truncated 25 of 39 utterances and advanced only about 60 source seconds during 90 wall seconds. Low onset P95 does not mean complete speech, sustained 1.5× throughput or a consistently smooth experience. All six cases passed their scripted controls, stop restoration and zero temporary rules after stop; the long case and intermediate short case also retained the same session through worker restart. Their action lists show which cases exercised seeks and container fullscreen.

The legacy format recorded only cuts above 100 ms and did not classify every terminal. Its recorded eligible onsets can therefore include unrecorded small cuts; the historical P95 values are conditional on incomplete flags, not proof of the new stricter criterion. Only five natural-end events were observed in the long case and one in the intermediate short case. Those end percentiles do not describe all 416 or 23 utterances.

| Historical case | Unique started utterances | Classified terminals | Unclassified |
| --- | --- | --- | --- |
| Baseline English→Chinese, long | 416 | 88 (5 natural, 83 recorded cuts) | **328 unknown** |
| Baseline Japanese→Chinese, short | 13 | 5 | 8 |
| Baseline Chinese→English, short | 17 | 9 | 8 |
| Baseline Japanese→Chinese, extended | 34 | 13 | 21 |
| Baseline Chinese→English, extended | 39 | 26 | 13 |
| Intermediate English→Chinese, short | 23 | 11 | 12 |

Unknown terminals cannot be reconstructed as natural completion or zero remaining audio. They can include small cuts, seeks/stops or active audio at capture. Raw natural-end events and unique terminal classifications are different counts; neither fills the missing history. The new candidate must demonstrate its own completion coverage.

### Long-case resources and reported-usage estimate

The baseline long case sampled 22 times: isolated-browser RSS peaked at **1698.656 MiB**, observed offscreen V8 heap at **49,554,110 bytes**, and playback-cache data at **88,408,128 bytes**. RSS includes the browser and video page, not just the extension; heap and cache values exclude other native/database overhead. At stop, playback cache remained 88,408,128 bytes, temporary media was zero and archive staging was zero with automatic file saving off. Short cases have no memory samples and report unknown, not zero.

The Beijing list-price lower bound from returned usage was **CNY 3.6853** for the long case. Scaling that report's recorded amount by continuous source time gives **CNY 11.046 per source-video hour**, or **CNY 10.332 per wall-watch hour**. The numerator includes recorded startup/prefetch/retries and omits any unreported/incomplete usage; these are case-specific extrapolations, not a verified bill or a stable hourly tariff. The account bill has not been reconciled. Usage aggregation takes the maximum observed cumulative snapshot per provider session, then sums sessions; provider billing semantics have not been independently audited.

The settings follow-up serializes complete read/modify/write operations so a preference update cannot restore a removed API key or overwrite replacement credentials. The YouTube follow-up associates direct sources and fallback selection with the current audio track, avoiding cross-track cache identity. These repairs have separate regression evidence from the Bilibili playback cases; they do not establish sustained YouTube translation.

Fullscreen evidence covers the tested webpage player's container fullscreen. Captions in native video-element fullscreen (`HTMLVideoElement.requestFullscreen()`) and picture-in-picture are not supported: the overlay cannot join the video element's fullscreen top layer. A successful container-fullscreen action must not be presented as coverage for those modes.

Each final case must report startup wait, all/eligible/valid onset counts and P95, natural-end count and deviation, skipped utterances and denominator, sampled buffering, memory and storage. Missing samples are unknown rather than zero. The onset target applies to eligible utterances only; meeting it does not establish low truncation or complete translation. Natural-end samples form a different population, and small counts limit the interpretation of their percentiles. List-price cost estimates are conservative reported-usage lower bounds, not verified account charges; startup, prefetch and retries are included and the viewing-hour denominator must be stated.

## Earlier site evidence and continuing limits

| Check                        | Evidence                                                                                           | What it does not establish                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Qwen protocol/authentication | Actual Model Studio requests and translated speech in isolated Chrome                              | Provider uptime, all accounts/regions or an end-to-end latency guarantee                                                         |
| Bilibili native playback     | Chinese/English translation, pause/resume, seeks, container fullscreen, 1.5×; live target change to Japanese | Every Bilibili video, CDN, quality or 20-minute reliability                                                                      |
| Tencent native HLS           | One specified clear episode, paused ahead-decoding near 1180 seconds and actual English speech     | All episodes, login states, qualities or DRM content                                                                             |
| YouTube primary player       | Live 720p→1080p→720p discovery returns one stable main target                                      | Sustained translation beyond unresolved SABR playback verification failures                                                      |
| Language cancellation        | Real extension fixture gate: four rapid changes, concurrent seek, old events and stop              | Language quality: generated synthetic-tone WAVs are deliberately reused and are not represented as genuine multi-language speech |
| Local archives               | Real OPFS/IndexedDB, quiet staging, final ZIP CRC and exact PCM merge checks                       | Rights to redistribute a source voice or third-party media                                                                       |
| UI                           | English and Chinese at 360/480 px; caption toggle, container fullscreen and restricted credential access | A complete accessibility audit, native video fullscreen or PiP captions                                                       |

The October 16 live Bilibili target-switch check prepared Chinese in 37.060 seconds, then Japanese in a further 47.861 seconds after a switch near source time 4.13 seconds. Actual Japanese audio started, the native video continued and temporary rules were zero after stop. This intermediate-build functional report does not record a runtime hash and is not part of the final-build timing cohort or long-playback acceptance. See `language-live-verification.json`.

The complete original site matrix is still unfinished: two videos per major site, including sustained YouTube translation, have not passed. A historical Bilibili baseline completed 20 minutes with incomplete terminal accounting, an intermediate short run missed the onset target, and the repaired candidate is being tested afresh. Historical 1.5× cases have substantial truncation and buffering. Bilibili results do not remove YouTube's SABR restriction, establish every video/quality/account or quantify speaker similarity. A build, synthetic source test, discovery result or short live clip is evidence only for its stated scope.

## Reproduce safely

Unit and isolated browser checks run without model credentials. See [Contributing](../CONTRIBUTING.md). Site gates depend on current pages/CDNs and can fail independently of code changes. Live model gates require an account and can incur costs. Keep secrets and signed media URLs out of published reports. Historical report timestamps and package versions are evidence for that revision only.

## Distribution checks from v0.2.2

`npm run test:browser` includes every offline fixture gate: UI, discovery, player selection, playback pause/wait state, audible playback, panel storage controls, language switching/cancellation, Range fallback and local files. Original tone fixtures are generated in code and are included in the source ZIP; no historical voice recording or provider account is needed.

`npm run test:release` downloads the actual installation/source ZIPs and checksums through Chrome, verifies SHA-256, extracts the installation ZIP and loads its root directory, then runs `npm ci`, type/unit checks, build and all offline browser gates in a clean source extraction. It generates `outputs/release-smoke-verification.json` afterward, attached separately to CI/release artifacts rather than embedded in its own source ZIP. Main/PR CI and tag release call the same validation workflow; publication uses its exact artifact and will not overwrite an existing release. These are software/distribution checks, not substitute evidence for live translation quality, voice similarity, the full 20-minute run or P95 synchronization.

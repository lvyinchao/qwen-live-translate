# Compatibility and validation

This document distinguishes observed behavior from product goals. Detailed, dated evidence is in [the historical validation record](../outputs/真实验收记录.md) and individual JSON reports in `outputs/`.

| Check                        | Evidence                                                                                           | What it does not establish                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Qwen protocol/authentication | Actual Model Studio requests and translated speech in isolated Chrome                              | Provider uptime, all accounts/regions or an end-to-end latency guarantee                                        |
| Bilibili native playback     | Chinese/English translation, pause/resume, seeks, fullscreen, 1.5×; live target change to Japanese | Every Bilibili video, CDN, quality or 20-minute reliability                                                     |
| Tencent native HLS           | One specified clear episode, paused ahead-decoding near 1180 seconds and actual English speech     | All episodes, login states, qualities or DRM content                                                            |
| YouTube primary player       | Live 720p→1080p→720p discovery returns one stable main target                                      | Sustained translation beyond unresolved SABR playback verification failures                                     |
| Language cancellation        | Real extension fixture gate: four rapid changes, concurrent seek, old events and stop              | Language quality: fixture WAVs are deliberately reused and are not represented as genuine multi-language speech |
| Local archives               | Real OPFS/IndexedDB, quiet staging, final ZIP CRC and exact PCM merge checks                       | Rights to redistribute a source voice or third-party media                                                      |
| UI                           | English and Chinese at 360/480 px; caption toggle, fullscreen and restricted credential access     | A complete accessibility audit                                                                                  |

For the 0.1.9 live Bilibili check, Chinese preparation took 34.212 seconds. Switching target to Japanese near video time 2.66 seconds took a further 36.872 seconds to prepare. Real Japanese audio started and the native video continued. A single software onset observation was about 19.2 ms; it is not P95, hardware loopback or lip-sync acceptance. See `language-live-verification.json`.

The original full acceptance targets—two videos per major site, all three requested language pairs, 20 minutes of continuous watching, P95 onset <=300 ms for eligible utterances, end deviations, skips, hourly costs and memory—are not all complete. Do not turn a successful build, synthetic source test, discovery result or one short live clip into a claim that those targets passed.

## Reproduce safely

Unit and isolated browser checks run without model credentials. See [Contributing](../CONTRIBUTING.md). Site gates depend on current pages/CDNs and can fail independently of code changes. Live model gates require an account and can incur costs. Keep secrets and signed media URLs out of published reports. Historical report timestamps and package versions are evidence for that revision only.

# Changelog

## Unreleased

- Split the service worker into `lib/background/` route modules with a declared access level per message, and type every background message's request and response in `lib/messages.ts`. Behaviour and rejection messages are unchanged.
- Retry provider failures by error code instead of matching Chinese message text. Background responses carry the code to the side panel and offscreen engine. A unit test now fails when a literal user-facing error lacks an English translation.
- Share media CDN domains, session-rule id ranges and the 60-second observation lifetime as single constants.
- Skip redundant 50 ms sync ticks when a video frame callback already ran, scan the YouTube page for a replaced player once per second instead of every 250 ms, and pause the side panel's 3-second rescan while the panel is hidden (it rescans when shown).
- Add ESLint, Prettier and V8 coverage (`npm run lint`, `format`, `format:check`, `test:coverage`); CI and the clean-source release check run lint and the format check. The codebase was reformatted once with Prettier.
- Replace remaining `any` in page adapters, the Tencent HLS observer and the decode worker with explicit types.
- Stop committing the generated `public/licenses/mediabunny-*-source.tgz` copy; `prepare:assets` now also runs before `npm run dev`. Document the vendored archives in `vendor/README.md`.

## 0.2.5 — 2026-10-16

- Clarify the English and Chinese playback notices: the tail counter includes very small timeline trims, not only long speech. Label affected transcript entries as trimmed. Playback, source discovery, the 2× audio-rate limit and cut accounting are unchanged.
- Publish the short real-provider Tencent Video test on a complete 4K episode: Chinese→English from approximately 16:54 to 19:33, with 46 native audio `playing` observations, 35.173 seconds to first readiness and 0.844× preparation throughput. One rebuffer and 41 tail trims remain quality limitations; 35 trims were at most 100 ms and the total was 3.914 seconds of output audio.
- Keep the earlier protection-warning cause unconfirmed: reopening the same watch URL made a readable audio source available in that account, and the warning did not recur. This is not a DRM repair, a full-episode or 20-minute acceptance, or a platform-wide compatibility claim. See the [Tencent playback record](docs/TENCENT-PLAYBACK-2026-10-16.md).

## 0.2.4 — 2026-10-16

- Add targeted discovery for public CCTV desktop VOD pages. Query CCTV's fixed official metadata endpoint with the current programme GUID; prefer its audio-only HLS, with a validated public HLS fallback. Associate it only with the unique native main player, without media protection and within two seconds of the programme duration.
- Recheck the page, GUID and observation revision after metadata lookup, and rescan the player DOM before association. Keep the same content identity when the verified programme's CDN mirror changes.
- Reuse successful metadata results in memory for five minutes; retry failed lookups after two seconds and clear them when observation is released. Send no cookies or model credentials to this endpoint, retain only the validated URL/title/duration and never persist the raw API response, IP or `client_sid`. No new permission is requested.
- A development 0.2.4 build decoded non-silent mono 16 kHz audio from the reported CCTV video's beginning, 1180.15–1210.15 seconds and ending, while the native video stayed paused at zero. The final build repeated all three reads successfully. This checks ahead-readable audio, not translated playback or a new model/synchronization long run. See [validation](docs/VALIDATION.md).
- The final build passed types, the build, 196 unit tests in 31 files and all 12 expanded CCTV browser-fixture categories, including same-URL reload, a changed player during an API lookup, CDN rotation and direct-source identity. Complete ten-gate CI, CodeQL, package checks and clean-source reproduction also passed at `810d771`; the exact validated packages are public in [v0.2.4](https://github.com/lvyinchao/timbradub/releases/tag/v0.2.4). Existing 0.2.2/0.2.3 evidence remains version-specific.

## 0.2.3 — 2026-10-16

- Fix concurrent Offscreen Document startup: a second caller must wait for the shared creation promise even when Chrome already lists the new document. This prevents an early message from returning no response while creation is still in progress.
- Add independent source/target subtitle switches: source only, target only, both or neither. New sessions default to both; legacy `subtitles` booleans remain compatible. Caption selection does not change audio scheduling.
- The released build passed 187 unit tests in 30 files, types, the build, all nine browser gates and clean-source reproduction in CI; release, main CI and CodeQL succeeded at `d06ce4b`. Final-build UI/language checks cover all four caption combinations, defaults, legacy behavior, container fullscreen and target switching. The startup injection was rerun from the final runtime and confirms both requests wait for one creation.
- Public ZIP checksums, extracted-root installation and independent reproduction from the downloaded source ZIP passed dependency/source checks, types, 187 unit tests, build and all nine browser gates. The fixed [public-download receipt](https://github.com/lvyinchao/timbradub/releases/download/v0.2.3/public-download-verification.json) is separate from the original CI receipt; both identify the same validated archive hashes.
- The 0.2.2 runtime's 20-minute measurements remain versioned evidence for 0.2.2 and are not presented as a fresh 0.2.3 long run. Existing 0.2.2 packages and receipts are not overwritten.

## 0.2.2 — 2026-10-16

- Fix translated-cache delivery beyond 90 seconds, including cached seeks and switching back to a prepared language. Playback readiness now requires the current player to acknowledge delivered utterances.
- Isolate media identities across clips, frames and audio tracks; reject obsolete errors, starts, stops and language results. Failed initialization restores the native player's audio settings.
- Replace shifted retry utterances in local archives, preserve overlapping speakers, reclaim obsolete WAV files and protect an in-progress merge from concurrent cleanup.
- Recover sequential media sources after interrupted transfers, cancel retired decoders and clean temporary source files on task retirement.
- Limit media observation to the visible panel and active task, expire source context, reject late responses after observation changes and replay Tencent metadata when discovery begins.
- Serialize settings read/modify/write operations so preference changes cannot revive removed API credentials or overwrite a replacement. Follow up YouTube direct-source and fallback selection with explicit audio-track identity.
- Show separate playback-cache, staged-archive and temporary-source usage with explicit cleanup. Scale startup preparation with video speed and display measured preparation throughput.
- Preload translated utterances and tighten scheduling after initial real-video synchronization measurements exceeded the onset target. Final measurements and remaining limits are recorded separately from fixture results.
- Fix premature pauses/seeks of short audio tails; record every positive timeline/overlap cut, deliver ownership-checked terminal reasons through lifecycle acknowledgements and retain critical metrics separately from debug stages. Preserve unknown completion counts in legacy reports.
- Make in-panel product, page and toolbar titles follow the saved interface language. Chrome's installed-extension name and outer side-panel frame remain governed by Chrome's language.
- Put `manifest.json` at the installation ZIP root, include short English/Chinese installation guides and replace historical voice recordings in tests with generated tones.
- Require the same complete offline validation for CI and tag releases. Verify downloaded ZIP installation and clean-source reproduction; publish the exact validated artifacts and check corresponding Mediabunny source integrity.
- Upgrade the development dependency chain; the refreshed full dependency audit reports zero known vulnerabilities at verification time.
- Split playback, media observation, lifecycle and side-panel behavior into testable modules. See the [review and repair record](docs/REVIEW-2026-10-16.md) for regression coverage and live-acceptance boundaries.
- The candidate passed 181 unit tests in 29 files, all nine offline browser gates, type checks, the build and a zero-vulnerability dependency audit, including 13 added player regressions and seven real-browser audio checks. CI also verified the matching runtime and clean-source installation/build plus all browser gates; archive receipts remain tied to their actual hashes.
- Preserve all six historical real cases, including the intermediate build's **failed 471.932 ms onset P95** and 328 unclassified terminals in the earlier 20-minute baseline, alongside the repaired build's three completed cases. Build identities, completion coverage, resource use and reported-usage cost lower bounds remain separate; the complete site matrix and perceptual voice evaluation are unfinished.
- The repaired build completed 1202.725 source seconds with all 418 terminals classified, eligible onset P95 213.8295 ms (68/418) and three retained onset outliers. It still cut 79 tails over 100 ms; native-ended absolute P95 was 949.919 ms. Two 1.5× cases have complete accounting and eligible onset P95 below 300 ms, but substantial truncation and 53.05% / 58.09% buffering remain. The stricter all-positive cut counter is not directly comparable with legacy reports; these outcomes do not establish overall quality acceptance.
- Preserve stored settings and the opt-in export preference. Repair old shifted archive duplicates without automatic download retries; do not reuse ambiguous legacy page-level media caches for newly isolated generic videos.

Original-speaker voice mode, user-owned Model Studio credentials without a self-hosted backend, and automatic local export **off by default** are unchanged. This release does not add DRM playback, live streams or a delayed tab-capture fallback.

## 0.2.1 — 2026-10-16

- Product, repository, toolbar, store listing, downloads and artwork renamed to **TimbraDub / 听译**, independent of the model provider brand.
- Original-speaker voice is the lead message; all 29 spoken target languages are listed in both languages.
- Public walkthrough and reviewer example use Bilibili. YouTube remains only in compatibility/developer validation.
- Extension first-run/settings pages and English/Chinese documentation link to qianwenai.com and require user-owned registration and API keys; usage is billed to that account.
- Existing local cache/archive identifiers are retained; new exports use `TimbraDub/`.

## 0.2.0 — 2026-10-16

First prepared public open-source release, continuing the 0.1.x preview.

- MIT license for original project code, documentation and brand assets; third-party licenses retained.
- New play/speech/waveform logo, Chrome toolbar/install icons, and repository artwork.
- English project homepage, full Chinese usage guide, architecture, privacy, security, contribution and support documents.
- GitHub issue/PR templates, dependency updates and CI for types, tests, browser fixtures, build and release verification.
- Separate GitHub installation, Chrome Web Store and source ZIPs, including license notices and corresponding Mediabunny source.
- Installation downloads published through GitHub Releases. Chrome Web Store submission status is tracked separately; release availability does not imply store approval.

No new translation protocol, media-capture mode or long-video compatibility claims.

## 0.1.9 — 2026-10-16

- Switch target language during playback; preserve player state and reject late language/seek results.
- Reuse per-language caches; buffer an uncached language from the actual current video position.
- Prevent video-only native-site responses from overwriting a known audio track.
- Live Bilibili Chinese→Japanese target switching and fixture regression checks.

## 0.1.8 — 2026-10-16

- Automatic local file saving defaults off, with a persistent bilingual toggle.
- Quiet segmented staging and explicit/manual merged archive controls remain available.

## 0.1.6–0.1.7 — 2026-10-15

- Removed tab-capture compatibility mode; retained ahead-buffered original-player playback.
- Continuous source discovery, mid-video seek fixes and native clear-HLS observation.
- YouTube main-player deduplication across resolution changes.

Earlier preview behavior and limitations are recorded in [historical validation](outputs/真实验收记录.md).

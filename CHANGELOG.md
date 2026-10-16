# Changelog

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

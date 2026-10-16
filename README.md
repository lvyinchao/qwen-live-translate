<p align="center"><img src="public/brand/logo.svg" width="88" height="88" alt="Video Dub logo" /></p>
<h1 align="center">Video Dub · 听译</h1>
<p align="center">Watch in another language. Stay on the same timeline.</p>
<p align="center">
  <a href="https://github.com/lvyinchao/qwen-live-translate/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/lvyinchao/qwen-live-translate/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-164a3f" /></a>
  <img alt="Chrome 116+" src="https://img.shields.io/badge/Chrome-116%2B-164a3f" />
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-164a3f" />
</p>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

![Video Dub: another language, the same timeline](docs/assets/banner.svg)

An independent, open-source Chrome extension that plays Qwen-translated speech alongside the **original webpage's video player**. Bring your own Alibaba Cloud Model Studio API key. No self-hosted server is required.

[Download the extension](https://github.com/lvyinchao/qwen-live-translate/releases/latest) · [Chinese guide](README.zh-CN.md) · [Privacy](PRIVACY.md) · [Report a problem](https://github.com/lvyinchao/qwen-live-translate/issues/new/choose)

> **Preview software.** Bilibili has short, real translated-playback checks. YouTube discovery and some audio windows work, but sustained playback can be blocked by SABR playback-verification requirements. Tencent support is verified for one specific clear HLS episode. Detection on a site does not guarantee that its videos can be translated. See the [compatibility and validation record](docs/VALIDATION.md). Chrome Web Store availability will be linked here once approved; GitHub downloads are available separately.

## What it does

- **Dubs in the existing player.** Speech segments follow the source video's time, including pause, seek, fullscreen and 0.5–2× video speed.
- **Prepares audio ahead.** Starts with about 30 seconds, then keeps preparing future audio. Missing translation pauses the video rather than playing untranslated scenes.
- **Uses original-voice mode.** Requests Qwen's realtime voice cloning. Similarity is model-dependent and is not guaranteed.
- **Switches languages during playback.** Choose another of the 29 supported speech-output languages. Reuse its cache or buffer from the current position; old-language results are isolated.
- **Keeps you in control.** Separate original/dub volume, bilingual subtitles, English/Chinese UI (English by default).
- **Saves only when enabled.** Automatic file saving defaults **off**. When enabled, completed utterances are staged locally, then merged into one ZIP with WAV audio, bilingual scripts and timed subtitles.

## Install

Requires desktop Chrome 116+ and a compatible Model Studio account. Provider usage is billed to your account.

1. Download `qwen-video-dub-<version>-chrome.zip` from [Releases](https://github.com/lvyinchao/qwen-live-translate/releases/latest) and extract it.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted `extension` folder containing `manifest.json`.
3. Pin **Qwen Video Dub**, then refresh any already-open video pages.
4. Open its side panel → settings. Enter your API key, Workspace ID and matching region. Save and test the connection.
5. Play a few seconds of a supported video so its audio source can be detected. Choose the video and target language, then **Start translation**.

The extension pauses to prepare speech before resuming. New, uncached language selections also require preparation; this can take tens of seconds. Short utterances retain timeline gaps; long ones can speed up to 2× and truncate expired tails. This is sentence-level synchronization, not lip sync.

## Compatibility

| Source                    | Current evidence                                                                      | Limits                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bilibili VOD              | Real Chinese/English playback, controls, seeks, and Chinese→Japanese target switching | CDN, account, codec and page changes can affect availability                               |
| YouTube VOD               | Main-player selection, resolution deduplication, some audio windows                   | Long playback has unresolved SABR verification failures                                    |
| Tencent Video             | One specified episode: clear HLS, middle-of-video decoding and English dubbing        | Not a claim of all episodes, qualities or protected content                                |
| Youku, iQIYI, other sites | Generic player and media-request discovery                                            | Translation requires an unencrypted, ahead-readable audio source; no universal DASH parser |

Live streams, DRM decryption, captured-tab compatibility mode, full video downloads, Firefox and mobile browsers are outside the current scope. Full 20-minute acceptance and broad P95 synchronization targets remain unfinished.

## Privacy and permissions

Translation audio is sent directly from the extension to the configured Model Studio endpoint **only after you start translation**. Original text and translated text/audio are received from that provider. API credentials stay in restricted extension-local storage and are not exposed to webpage messages, Chrome sync or project telemetry. There is no project-operated backend, analytics or advertising.

A bounded IndexedDB playback cache is separate from optional archive files. Some range-less media sources also need temporary, browser-private disk storage. Turning automatic saving off disables new archives and automatic downloads; it does not disable the cache or delete existing files.

Broad host access supports current-page media discovery, cross-origin audio and extension-origin WebSocket authentication. Runtime authentication rules are scoped to the extension and exact Model Studio endpoint and removed after use. See [Privacy](PRIVACY.md), [permission explanations](docs/ARCHITECTURE.md#permissions) and [Security](SECURITY.md).

## Develop

Node.js **22.12+**, npm, and Git are required. Packaging uses `zip`/`unzip`. Browser fixture gates require Playwright's Chromium; media fixture gates also require FFmpeg.

```sh
git clone https://github.com/lvyinchao/qwen-live-translate.git
cd qwen-live-translate
npm ci
npm run check
npm test
npm run build
```

Load `.output/chrome-mv3` for development. `npm run dev` starts WXT. No API key is needed to build or run unit tests.

```sh
npx playwright install chromium
HEADLESS=1 npm run test:browser
npm run package
npm run verify:release
```

The package command produces a GitHub installation ZIP, a manifest-at-root Chrome Web Store ZIP, a source ZIP, and SHA-256 checksums in `outputs/`. Release verification checks archive layout, licenses, icons and unexpected credential files. Model gates are **manual and may incur provider costs**; they are excluded from CI. Read [Contributing](CONTRIBUTING.md) before running them.

## Project map

| Location                        | Purpose                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `entrypoints/sidepanel`         | Bilingual React controls and settings                                 |
| `entrypoints/player.content.ts` | Existing-player control, captions and translated speech               |
| `entrypoints/background.ts`     | Discovery, permissions, task coordination and temporary auth rules    |
| `entrypoints/offscreen`         | Prefetch, model sessions, scheduling, cache and optional archives     |
| `workers/decode.ts`, `lib/`     | Media decoding, timeline logic, protocol, storage and site adapters   |
| `tests/`, `scripts/`            | Unit tests, isolated browser gates and explicitly invoked live checks |
| `docs/`, `.github/`             | Architecture, validation, store materials and contributor workflows   |

## Contribute and support

Bug fixes, reproducible compatibility reports, accessibility improvements and tests are welcome. Start with [Contributing](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), [Support](SUPPORT.md) and the [roadmap](docs/ROADMAP.md). Report security problems privately through [GitHub Security Advisories](https://github.com/lvyinchao/qwen-live-translate/security/advisories/new), not public issues.

## License and attribution

Original project code, documentation and the new vector brand assets are available under the [MIT License](LICENSE). Third-party software retains its own license, including Mediabunny (MPL-2.0), googlevideo/React/WXT (MIT), Lucide (ISC) and protobuf-es (Apache-2.0). The distribution includes dependency notices and the exact unchanged Mediabunny source package; see [Third-party notices](THIRD_PARTY_NOTICES.md).

Third-party video screenshots, source speech and translated examples in historical validation materials are evaluation evidence, not MIT-licensed media or a grant of voice/likeness rights. They are excluded from new downloadable release bundles. The extension was independently implemented and contains no FetchV implementation code. This project is not affiliated with Alibaba Cloud, Qwen, Google or the video platforms.

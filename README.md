<p align="center"><img src="public/brand/logo.svg" width="88" height="88" alt="TimbraDub logo" /></p>
<h1 align="center">TimbraDub · 听译</h1>
<p align="center">The original voice. A new language. The same timeline.</p>
<p align="center">
  <a href="https://github.com/lvyinchao/timbradub/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/lvyinchao/timbradub/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-164a3f" /></a>
  <img alt="Chrome 116+" src="https://img.shields.io/badge/Chrome-116%2B-164a3f" />
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-164a3f" />
</p>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

![TimbraDub: the original voice in another language](docs/assets/banner.svg)

An independent, open-source Chrome extension that translates video speech **in the original speaker’s voice**, with synchronized audio and bilingual subtitles in the **original webpage’s video player**. No self-hosted server is required.

**Your own account and API key are required. Register at [qianwenai.com](https://qianwenai.com/) and apply for an API key before translating.** Configure your key, Workspace ID and matching region in the extension. Model usage is billed directly to your own provider account; this project does not supply keys or credits.

[Download the extension](https://github.com/lvyinchao/timbradub/releases/latest) · [Chinese guide](README.zh-CN.md) · [Privacy](PRIVACY.md) · [Report a problem](https://github.com/lvyinchao/timbradub/issues/new/choose)

> **Preview software.** Bilibili has real translated-playback checks, with measured buffering and truncation limits documented below. YouTube discovery and some audio windows work, but sustained playback can be blocked by SABR playback-verification requirements. Tencent support is verified for one specific clear HLS episode. Detection on a site does not guarantee that its videos can be translated. See the [compatibility and validation record](docs/VALIDATION.md). Chrome Web Store v0.2.3 is submitted and pending review, with automatic publication selected after approval. It is not yet approved or publicly available in the store. GitHub downloads are a separate channel. See [store status](docs/store/STATUS.md).

## What it does

- **Dubs in the existing player.** Speech segments follow the source video's time, including pause, seek, player-container fullscreen and 0.5–2× video speed. Captions in native video-element fullscreen or picture-in-picture are not supported.
- **Prepares audio ahead.** Starts with 30 seconds of source time at 1× (45 seconds at 1.5×, 60 seconds at 2×), then keeps preparing future audio up to a 90-second ceiling. Model input is conservatively paced at 1×, so faster viewing can require further buffering. Missing translation pauses the video rather than playing untranslated scenes.
- **Uses original-voice mode.** Requests Qwen's realtime voice cloning. Similarity is model-dependent and is not guaranteed.
- **Switches languages during playback.** Choose another of the 29 supported speech-output languages. Reuse its cache or buffer from the current position; old-language results are isolated.
- **Keeps you in control.** Separate original/dub volume, independent source/target captions in 0.2.3, English/Chinese UI (English by default). The panel brand, page title, original-voice label and toolbar tooltip follow the saved interface language. Chrome's own extension-management name and browser-managed side-panel heading follow the browser's language and cannot be renamed by this setting.
- **Saves only when enabled.** Automatic file saving defaults **off**. When enabled, completed utterances are staged locally, then merged into one ZIP with WAV audio, bilingual scripts and timed subtitles.

## Install

Requires desktop Chrome 116+ and a compatible Model Studio account. Provider usage is billed to your account.

1. Download `timbradub-<version>-chrome.zip` from [Releases](https://github.com/lvyinchao/timbradub/releases/latest) and extract it.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted root folder **directly containing `manifest.json`**. From v0.2.2 there is no extra `extension` subfolder.
3. Pin **TimbraDub**, then refresh any already-open video pages.
4. [Register at qianwenai.com and obtain your own API key](https://qianwenai.com/). Open the side panel → settings, enter the key, Workspace ID and matching region, then save and test the connection.
5. Play a few seconds of a supported video so its audio source can be detected. Choose the video and target language, then **Start translation**.

See the [bilingual installation guide and package comparison](docs/INSTALL.en.md), including the fix for “Manifest file is missing or unreadable”. Keep the extracted folder after installation.

The extension pauses to prepare speech before resuming. New, uncached language selections also require preparation; this can take tens of seconds. Short utterances retain timeline gaps; long ones can speed up to 2× and truncate expired tails. This is sentence-level synchronization, not lip sync.

In 0.2.3, **Show original-language subtitles** and **Show target-language subtitles** are independent: enable either one, both, or neither. Both default on for a new session. Hiding captions does not stop the translated audio.

## Bilibili example

Try [this Bilibili video](https://www.bilibili.com/video/BV13rsaeaEgE/) used in our real checks. Play a few seconds, open TimbraDub, choose Chinese and start. Once prepared, change the target to Japanese while watching. The new target prepares from the current video position. Video/CDN availability can change.

## All 29 spoken target languages

Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, Russian, Arabic, Italian, Indonesian, Thai, Vietnamese, Turkish, Hindi, Malay, Dutch, Urdu, Norwegian Bokmål, Swedish, Danish, Hebrew, Finnish, Polish, Icelandic, Czech, Filipino, Persian.

See the [English / Chinese language table and codes](docs/LANGUAGES.md). Every target uses original-voice mode; similarity depends on the model and source audio.

## Compatibility

| Source                    | Current evidence                                                                      | Limits                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bilibili VOD              | Real English→Chinese, Chinese→English and Japanese→Chinese playback, controls, seeks, and in-playback target switching | CDN, account, codec and page changes can affect availability; faster viewing can buffer and truncate speech |
| YouTube VOD               | Main-player selection, resolution deduplication, some audio windows                   | Long playback has unresolved SABR verification failures                                    |
| Tencent Video             | One specified episode: clear HLS, middle-of-video decoding and English dubbing        | Not a claim of all episodes, qualities or protected content                                |
| CCTV desktop VOD (0.2.4 candidate) | One reported programme: paused ahead-decoding at the beginning, 1180.15 seconds and ending | Targeted public metadata/HLS support; no new translated-playback claim, no live streams or DRM |
| Youku, iQIYI, other sites | Generic player and media-request discovery                                            | Translation requires an unencrypted, ahead-readable audio source; no universal DASH parser |

Live streams, DRM decryption, captured-tab compatibility mode, full video downloads, Firefox and mobile browsers are outside the current scope. The original cross-site acceptance matrix remains incomplete; measured onset timing does not establish complete spoken coverage, voice similarity or lip sync. Sustained 1.5× checks showed substantial buffering and truncation, especially Chinese→English. Read the sample counts and limits in the [validation record](docs/VALIDATION.md).

## Privacy and permissions

Translation audio is sent directly from the extension to the configured Model Studio endpoint **only after you start translation**. Original text and translated text/audio are received from that provider. API credentials stay in restricted extension-local storage and are not exposed to webpage messages, Chrome sync or project telemetry. There is no project-operated backend, analytics or advertising.

Settings show three separate storage areas: the bounded playback cache, optional archive staging, and temporary source media. Stop translation before explicitly clearing any of them. Clearing archive staging does not delete files already downloaded. A bounded IndexedDB playback cache is separate from optional archive files. Some range-less media sources also need temporary, browser-private disk storage. Turning automatic saving off disables new archives and automatic downloads; it does not disable the cache or delete existing files.

Broad host access supports current-page media discovery, cross-origin audio and extension-origin WebSocket authentication. Media observation is enabled for a panel-selected tab or the active translation task, with a 15-second renewable panel lease and 60-second validity for discovered media addresses and request-header context; expired information is removed on a subsequent scan or background startup. Closing the panel or changing to an unrelated tab ends its observation lease; the active task may continue observing its own tab. Runtime authentication rules are scoped to the extension and exact Model Studio endpoint and removed after use. See [Privacy](PRIVACY.md), [permission explanations](docs/ARCHITECTURE.md#permissions) and [Security](SECURITY.md).

From 0.2.4, selecting a CCTV desktop VOD page in the open panel can send its programme GUID to the fixed official CCTV metadata API, even before translation starts. This request uses no cookies or model key. Only the validated public media URL, title and duration are cached in memory with five-minute validity, a separate exception to observed-media context's 60-second validity; releasing observation clears the lookup. The raw response, including IP or `client_sid` fields, is not retained. No additional permission is required.

## Develop

Node.js **22.12+**, npm, and Git are required. Packaging uses `zip`/`unzip` and `tar`. Browser fixture gates require Playwright's Chromium; media fixture gates also require FFmpeg. The unit, browser and release checks use original synthetic fixtures and require no provider account.

```sh
git clone https://github.com/lvyinchao/timbradub.git
cd timbradub
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
npm run test:release
```

The package command produces a GitHub installation ZIP, a manifest-at-root Chrome Web Store ZIP, a source ZIP, and SHA-256 checksums in `outputs/`. Release verification checks directly loadable archive layout, licenses, icons, secret patterns and the corresponding Mediabunny source against the installed version and lockfile SHA-512. `test:release` downloads the actual ZIPs through Chrome, extracts and loads the installation folder, then runs `npm ci`, type/unit checks, a build and every offline browser gate from the clean source ZIP. CI and tag releases share this validation workflow; release publication uses its exact validated artifacts. Model gates are **manual and may incur provider costs**; they are excluded from CI. Read [Contributing](CONTRIBUTING.md) before running them.

The [0.2.2 review and repair record](docs/REVIEW-2026-10-16.md) maps the confirmed issues to fixes and regression checks, with live-acceptance limits recorded separately.

The release-smoke receipt is generated after the run and attached separately to CI/release artifacts. It is excluded from the source ZIP and identifies the archive hashes actually verified.

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

Bug fixes, reproducible compatibility reports, accessibility improvements and tests are welcome. Start with [Contributing](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), [Support](SUPPORT.md) and the [roadmap](docs/ROADMAP.md). Report security problems privately through [GitHub Security Advisories](https://github.com/lvyinchao/timbradub/security/advisories/new), not public issues.

## License and attribution

Original project code, documentation and the new vector brand assets are available under the [MIT License](LICENSE). Third-party software retains its own license, including Mediabunny (MPL-2.0), googlevideo/React/WXT (MIT), Lucide (ISC) and protobuf-es (Apache-2.0). The distribution includes dependency notices and the exact unchanged Mediabunny source package; see [Third-party notices](THIRD_PARTY_NOTICES.md).

Third-party video screenshots, source speech and translated examples in historical validation materials are evaluation evidence, not MIT-licensed media or a grant of voice/likeness rights. They are excluded from new downloadable release bundles. The extension was independently implemented and contains no FetchV implementation code. This project is not affiliated with Alibaba Cloud, Qwen, Google or the video platforms.

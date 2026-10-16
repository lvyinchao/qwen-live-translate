# Chrome Web Store submission packet

This packet describes the version 0.2.3 candidate. The last actual submission and Google review/publication status are recorded separately in `STATUS.md`; preparing this packet does not imply a new submission or approval.

## Package and public links

- Candidate upload `outputs/timbradub-0.2.3-webstore.zip` (manifest at root).
- Homepage/support: https://github.com/lvyinchao/timbradub
- Support issues: https://github.com/lvyinchao/timbradub/issues
- Privacy policy: https://github.com/lvyinchao/timbradub/blob/main/PRIVACY.md
- Store icon: `public/icons/128.png`; small promo: `docs/store/assets/small-promo-440x280.png`.
- Screenshots: `docs/store/assets/screenshot-*.png`, generated from the actual built extension. Captioned compositions describe the interface and must not imply unsupported live results.
- English/Chinese copy: `LISTING.en.md`, `LISTING.zh-CN.md`.

## Single purpose

Make supported web video understandable in a selected language by preparing translated speech ahead, playing it against the original video's time, and displaying optional bilingual subtitles. Optional local script/audio export is part of this same translation workflow.

## Permission justifications

| Requested permission                | User-facing justification                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| storage                             | Save the user's own Model Studio credentials and preferences locally and maintain the current translation task. Access to sensitive settings is restricted to trusted extension pages.                                                                                                                                               |
| tabs / activeTab                    | Identify the current video page and coordinate task cancellation when that page/tab changes or closes; not to collect general browsing history.                                                                                                                                                                                      |
| scripting                           | Inspect supported player metadata and video elements in the selected page/frames and control the selected player's translation playback.                                                                                                                                                                                             |
| webRequest                          | Observe media URLs and origin/referrer context only for panel-selected or actively translating tabs. Panel leases last 15 seconds; source metadata is valid for 60 seconds, with expired data removed on a later scan/background startup rather than a guaranteed timer. Closing/switching the panel releases unrelated observation. |
| sidePanel                           | Present video selection, language choice, preparation progress, volume/subtitle and saving controls.                                                                                                                                                                                                                                 |
| offscreen                           | Decode and prepare source/translated audio and manage the translation connection in the background under Manifest V3.                                                                                                                                                                                                                |
| downloads                           | Save one optional merged translation ZIP when the user enables automatic saving or explicitly merges/retries. Saving is off by default.                                                                                                                                                                                              |
| declarativeNetRequestWithHostAccess | Apply temporary authentication only to the extension's allowlisted Model Studio WebSocket and origin/referrer headers required by source audio servers. Browser WebSocket does not accept arbitrary Authorization headers directly. Rules are removed after use.                                                                     |
| all host access                     | Detect videos across user-selected websites and frames, read their cross-origin audio CDN resources, and meet Chrome's request+initiator host checks for extension-origin authentication. Narrow grants failed the actual browser handshake test. The API key is never attached to webpage requests.                                 |

## Remote code

No remote executable code is used. All extension scripts, workers, icons, codecs/libraries and protocol handling are bundled. Model output is text/audio data, not evaluated code. The project does not fetch code from a website or require a local native app.

## Data disclosures to enter accurately

The extension handles authentication information (the user-supplied API key), website content (source speech and translated text/audio), and selected-page/media URL/title context. Source audio and necessary model parameters go directly to the configured Alibaba Cloud Model Studio service after user initiation; its key authenticates that service. Video/CDN requests reach their original servers. Credentials and preparation/cache/archive data also remain in browser-local storage as described in the privacy policy.

If the dashboard asks about data types used/collected, disclose those categories even though the maintainer operates no backend. Selected-page URL context does not mean the extension reads the browser's history database. Do not claim that no data leaves the device. No sale of data, advertising, unrelated transfer, creditworthiness determination or unrelated profiling occurs.

## Reviewer instructions

1. Install the uploaded build in desktop Chrome 116+.
2. Open the extension side panel. The interface defaults to English and supports Simplified Chinese from its header. Local saving defaults off and can be tested without a provider account.
3. Register at https://qianwenai.com/ and obtain a **reviewer-owned API key**; translation requires that key, Workspace ID and region configured in settings. The project has no login, paid subscription or project-hosted account. Do not place a project owner's personal API key in a listing or source archive.
4. A tested public example is https://www.bilibili.com/video/BV13rsaeaEgE/ . Start it briefly, let the audio be detected, choose Chinese and start translation. Source/CDN availability may vary. At 1×, translation pauses the video to prepare approximately 30 source seconds (45 at 1.5×, 60 at 2×); this often takes 30–45 seconds, with no fixed timing guarantee.
5. Test pause/resume and change target language to Japanese while translating. The old audio clears immediately; after new preparation the original player resumes. A user-paused video stays paused.
6. Faster video speed can require more buffering because model input is conservatively paced at 1×. Stop translation to restore the original audio settings. Settings show and separately clear the playback cache, archive staging and temporary source files; clear only after stopping. Toggle automatic local saving only if you wish to create merged ZIPs in Chrome's download folder.
7. YouTube long playback is not a reliable acceptance case yet. Do not use DRM, live streams or assume all generic detected streams are ahead-readable.

If reviewers require credentials beyond BYOK, request a dedicated, restricted test credential from the maintainer through a private channel. Approval and actual public availability remain Google-controlled.

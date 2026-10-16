# Contributing

Thanks for helping improve Video Dub. English and Chinese issues and pull requests are welcome.

## Before changing code

Search existing issues. For a large feature or a new media-extraction strategy, open an issue describing the user-visible outcome and a small reproducible example. Preserve the original-player, ahead-buffered translation design. Do not replace it with delayed tab capture or present detection-only, subtitles-only or synthetic fixtures as live translation acceptance.

## Setup and checks

Use Node.js 22.12+ and run `npm ci`. The repository's `private: true` prevents accidental npm publication; GitHub source and release downloads can still be public.

```sh
npm run check
npm test
npm run build
npx playwright install chromium
HEADLESS=1 npm run test:browser
```

The browser gates use isolated profiles and deterministic pages, not your regular browser profile. `scripts/gate-language-switch.mjs` and `scripts/gate-range-source.mjs` additionally use FFmpeg. They do not make paid model calls.

Live gates such as `gate-language-live.mjs`, `gate-playback.mjs` and `gate-browser.mjs` make real Model Studio requests and may cost money. They run only when invoked explicitly. Some read `~/.bailian/config.json`; see each script for `BAILIAN_CONFIG`, `VIDEO_URL` and other overrides. Never commit that file, add a key to source, or put credentials in an issue, recording, CI variable dump or test report. A failed site gate is useful evidence; do not hide it or loosen timestamp validation to obtain a pass.

## Pull requests

Keep a PR focused. Explain the problem, observable behavior, tests, and remaining limits. For player/discovery changes, include a public example URL, source position, browser/version, language pair and anonymized diagnostics. For UI changes, check both languages at 360 and 480 px, keyboard focus, and subtitle visibility. For concurrency changes, check rapid language changes, simultaneous seeks, late events and stop during work.

Add meaningful regression coverage when changing timeline, cache, isolation or credential behavior. Do not commit paid recordings, signed CDN URLs, cookies, personal credentials or copyrighted sample media. Use synthetic fixtures or media you have rights to redistribute. Keep current assertions about real-site acceptance separate from fixture checks.

## Licensing and collaboration

Contributions are accepted under the project's MIT license unless a file carries a different third-party license. Retain third-party notices and identify any new dependency and its license. Use the [Code of Conduct](CODE_OF_CONDUCT.md). A separate contributor license agreement is not required.

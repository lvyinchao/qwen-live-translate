# Contributing

Thanks for helping improve TimbraDub. English and Chinese issues and pull requests are welcome.

## Before changing code

Search existing issues. For a large feature or a new media-extraction strategy, open an issue describing the user-visible outcome and a small reproducible example. Preserve the original-player, ahead-buffered translation design. Do not replace it with delayed tab capture or present detection-only, subtitles-only or synthetic fixtures as live translation acceptance.

## Setup and checks

Use Node.js 22.12+ and run `npm ci`. The repository's `private: true` prevents accidental npm publication; GitHub source and release downloads can still be public.

```sh
npm run check
npm run lint
npm run format:check
npm test
npm run build
npx playwright install chromium
HEADLESS=1 npm run test:browser
npm run package
npm run verify:release
npm run test:release
```

`npm run format` applies Prettier; `npm run test:coverage` writes an HTML report to ignored `coverage/`.

The browser gates use isolated profiles and deterministic pages, not your regular browser profile. Install FFmpeg, `zip`/`unzip` and `tar` as well as Playwright's Chromium. `test:browser` runs UI, discovery, YouTube-player selection, playback pause/wait state, audible playback, panel storage controls, language cancellation, range-source and local-file gates. WAV fixtures are generated from original tone code in `tests/fixtures/audio.mjs`; historical voice recordings are not required or included in source downloads. The fixture gates deny real provider traffic and never make paid model calls.

`test:release` performs actual ZIP downloads and root-folder installation in Chrome, then installs dependencies, typechecks, runs unit tests, builds and executes every offline browser gate from a clean extracted source ZIP. It uses the local packaged archives by default. To verify already published assets, set `RELEASE_BASE_URL` to their versioned GitHub release-download URL. This downloads public files without providing a GitHub token to the browser. Source installation requires registry network access but no model account. Logs remain under ignored `work/` on failure, and the sanitized outcome is written to `outputs/release-smoke-verification.json`.

That receipt is generated after packaging and is excluded from the source ZIP. The separately attached CI/release receipt identifies the actual archive hashes it verified; an earlier receipt is not evidence for a newly built package.

CI and tags call the same `validate.yml` workflow. Tag/package versions must match; release publication depends on successful validation and publishes the artifact it produced, without rebuilding or overwriting an existing release. `npm run audit:deps` must pass with no reported vulnerabilities. `npm run verify:media-source` compares the installed Mediabunny version, exact package declaration, lockfile integrity and the unchanged readable-source tarball. Dependency changes must update and verify the corresponding source and notices in the same PR.

Live gates such as `gate-language-live.mjs`, `gate-playback.mjs` and `gate-browser.mjs` make real Model Studio requests and may cost money. They run only when invoked explicitly. Some read `~/.bailian/config.json`; see each script for `BAILIAN_CONFIG`, `VIDEO_URL` and other overrides. Never commit that file, add a key to source, or put credentials in an issue, recording, CI variable dump or test report. A failed site gate is useful evidence; do not hide it or loosen timestamp validation to obtain a pass.

## Pull requests

Keep a PR focused. Explain the problem, observable behavior, tests, and remaining limits. For player/discovery changes, include a public example URL, source position, browser/version, language pair and anonymized diagnostics. For UI changes, check both languages at 360 and 480 px, keyboard focus, and subtitle visibility. For concurrency changes, check rapid language changes, simultaneous seeks, late events and stop during work.

Add meaningful regression coverage when changing timeline, cache, isolation or credential behavior. Do not commit paid recordings, signed CDN URLs, cookies, personal credentials or copyrighted sample media. Use synthetic fixtures or media you have rights to redistribute. Keep current assertions about real-site acceptance separate from fixture checks.

## Licensing and collaboration

Contributions are accepted under the project's MIT license unless a file carries a different third-party license. Retain third-party notices and identify any new dependency and its license. Use the [Code of Conduct](CODE_OF_CONDUCT.md). A separate contributor license agreement is not required.

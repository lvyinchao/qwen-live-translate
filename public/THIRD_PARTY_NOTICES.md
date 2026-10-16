# Third-party software

Original project code and brand assets are MIT-licensed; see `LICENSE`. Third-party components keep the licenses below. Historical external-media validation examples are not covered by that MIT grant and are excluded from new downloadable releases.

This extension is independently implemented. No FetchV implementation code is included.

- **Mediabunny 1.61.4** — MPL-2.0. Copyright Vanilagy and contributors. Source: https://github.com/Vanilagy/mediabunny and https://www.npmjs.com/package/mediabunny/v/1.61.4. The unchanged library is bundled in the media decoding worker. The corresponding untouched npm source package, including readable TypeScript, is included as `licenses/mediabunny-1.61.4-source.tgz` in the extension and `vendor/mediabunny-1.61.4-source.tgz` in the source distribution. Its integrity is checked against the locked npm package before release. The full MPL-2.0 license is provided in `licenses/mediabunny-MPL-2.0.txt`.
- **googlevideo 4.1.1-qvd.96d1418** — MIT. Copyright LuanRT. Pinned upstream source: https://github.com/LuanRT/googlevideo/tree/96d1418984d00ac2797a1dafe4625d1368b5b9aa . Its unmodified SABR stream implementation and protobuf definitions are bundled for bounded audio fetching. The source distribution includes the readable upstream source in `vendor/googlevideo-4.1.1-qvd.96d1418.tgz`; only package metadata was adjusted to include generated output without requiring a local protobuf compiler.
- **@bufbuild/protobuf 2.16.0** — Apache-2.0. Copyright Buf Technologies, Inc. https://github.com/bufbuild/protobuf-es .
- **scheduler** — MIT. Copyright Meta Platforms, Inc. and affiliates. https://github.com/facebook/react
- **React / React DOM** — MIT. Copyright Meta Platforms, Inc. and affiliates. https://github.com/facebook/react
- **Lucide icons** — ISC. Copyright Lucide Contributors. https://github.com/lucide-icons/lucide
- **WXT** — MIT. Copyright WXT contributors. https://github.com/wxt-dev/wxt

Development-only dependencies and validation scripts are not part of the browser extension bundle. See `package-lock.json` in the source distribution for pinned dependency versions.

Development/distribution tooling uses **fflate 0.8.3** (MIT; https://github.com/101arrowz/fflate) to create and inspect UTF-8 ZIP archives consistently across platforms. It is a development dependency and is not included in the browser extension runtime. The installed Mediabunny version and the corresponding source tarball are automatically checked against the lockfile SHA-512 by `scripts/check-media-source.mjs` during build and release validation.

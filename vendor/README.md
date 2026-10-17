# Vendored archives

Both archives are installed from this folder so a build never depends on a
mutable registry tarball or a local protobuf compiler.

| Archive | What it is | Checked by |
| --- | --- | --- |
| `googlevideo-4.1.1-qvd.96d1418.tgz` | [LuanRT/googlevideo](https://github.com/LuanRT/googlevideo) at commit `96d1418984d00ac2797a1dafe4625d1368b5b9aa`, MIT. Source unchanged; the archive adds the generated protobuf and compiled ESM output, removes package scripts and suffixes the version (`4.1.1-qvd.96d1418`). Provenance is repeated in the archive's `package/UPSTREAM.md`. | `package-lock.json` integrity |
| `mediabunny-1.61.4-source.tgz` | The untouched npm tarball of `mediabunny@1.61.4`, kept to satisfy MPL-2.0 source distribution. `npm run prepare:assets` (run before `dev` and `build`) copies it into the extension as `licenses/mediabunny-1.61.4-source.tgz`; that copy is generated and not committed. | `npm run verify:media-source` (SHA-512 against the lockfile) |

## Upgrading

- **googlevideo**: build the new upstream commit, add the generated output to
  the package, set the version to `<upstream>-qvd.<short-sha>`, `npm pack` it
  here, update `package.json`, run `npm install`, and update
  `THIRD_PARTY_NOTICES.md`.
- **mediabunny**: change the exact version in `package.json`, run
  `npm install`, replace the archive with `npm pack mediabunny@<version>`, and
  run `npm run verify:media-source`. Update `THIRD_PARTY_NOTICES.md` and the
  release checks if the filename changes.

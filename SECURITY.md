# Security policy

## Supported versions

Security fixes target the latest published preview release. Older previews are not separately maintained. This is experimental browser software with broad host permissions; inspect the source and permission explanations before enabling it.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/lvyinchao/timbradub/security/advisories/new). Do not open a public issue containing an API key, cookie, account information, exploitable details or a signed private-media URL. Share a minimal reproduction, affected version, impact and sanitized evidence. There is no guaranteed response time or paid bounty program.

If you accidentally expose a key, revoke/rotate it through its provider immediately; deleting a post or commit does not invalidate a credential.

## Security boundaries

- Content scripts receive player/session data and presentation preferences, never the API key.
- Credentials use extension-local storage restricted to trusted extension contexts, not sync storage. This is browser-local storage, not an operating-system password vault.
- Model traffic goes to the chosen Model Studio region/workspace. Temporary authorization rules target the extension's own requests and the exact allowed model endpoint.
- Media observation is limited to panel-selected tabs with renewable leases and the active translation tab; stored request metadata expires on use/startup. Media identities separate files, frames and tracks before cache/archive lookup.
- Webpage-origin callers cannot change settings, install auth rules, start model sessions or download private archive files.
- Remote executable code, telemetry and a project-hosted proxy are not part of the architecture.
- Playback caches, temporary source files and optional export archives have different lifetimes; consult [Privacy](PRIVACY.md).

Model-generated output and webpage metadata are untrusted input. Dependencies and browser/platform behavior can change; passing tests is not a security certification.

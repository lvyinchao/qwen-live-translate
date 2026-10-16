# Roadmap

The next work should improve reliable original-player viewing before expanding scope.

- Extend the repaired scheduler's complete terminal accounting from the two measured speed cases to long runs, and reduce the observed truncation and buffering. Preserve earlier onset failures and unknown completions rather than inferring full speech from a small natural-end sample.
- Repeat and expand native-player acceptance across builds and videos, reporting continuous viewing, eligible onset P95, end offsets, truncation, preparation waits, buffering, memory and disk separately. Confirm provider cost against account billing as well as reported-usage estimates.
- Extend the repaired media-identity and signed-source handling with reproducible cases, including more clear-media sites and account/codec combinations.
- Investigate YouTube SABR playback verification failures without weakening protected-content boundaries or presenting partial windows as complete support.
- Expand language-pair and accessibility coverage, including keyboard-only operation and long translated labels.
- Investigate native video-element fullscreen and picture-in-picture captions separately; current fullscreen evidence covers webpage-player containers only.
- Maintain the three storage categories and explicit cleanup with long-running quota and interruption tests; keep automatic file saving off by default and avoid per-utterance download prompts.
- Complete Chrome Web Store review and publish the actual approved listing URL.

Not currently planned: delayed tab capture, DRM bypass, live streams, full-video download/export, user accounts/billing, Firefox or mobile support. Priorities can change through concrete issues and reproducible evidence.

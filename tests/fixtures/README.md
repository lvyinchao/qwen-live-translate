# Test media

`audio.mjs` generates a deterministic 24 kHz mono PCM16 WAV tone in memory. It is original MIT-licensed fixture code, contains no recorded speech, and runs without a provider account, network access or a paid model. Browser UI, language-switch and archive gates use this same 3.84-second signal. Playback, cancellation and byte-for-byte archive checks do not establish translation quality or voice similarity.

`probe.pcm` is 16 kHz mono signed PCM16 LE synthetic English test speech generated locally for an explicitly invoked authenticated WebSocket smoke test. Override `PROBE_PCM` to use your own authorized audio. There are no credentials in either fixture.

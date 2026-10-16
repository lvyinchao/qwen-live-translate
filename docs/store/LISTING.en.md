# Chrome Web Store listing — English

Name: **TimbraDub — Original-Voice Translation**

Short description: **Original-voice video translation in 29 languages, with synced audio and subtitles. Get your own API key at qianwenai.com.**

Category: Accessibility (video-language accessibility); default language: English.

## Detailed description

The original voice. A new language. The same timeline.

Watch supported web videos translated in the original speaker’s voice, in the original webpage’s player.

TimbraDub prepares translated speech ahead of the video, then plays it in sync with the source sentences. It requests Qwen LiveTranslate's original-voice mode and includes bilingual subtitles. Voice similarity depends on the model; this is sentence-level alignment, not lip synchronization.

All 29 spoken target languages:
Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, Russian, Arabic, Italian, Indonesian, Thai, Vietnamese, Turkish, Hindi, Malay, Dutch, Urdu, Norwegian Bokmål, Swedish, Danish, Hebrew, Finnish, Polish, Icelandic, Czech, Filipino, Persian.

• Choose a detected video and one of 29 supported spoken target languages.
• Switch target language while translating. Cached audio is reused; new content pauses briefly for preparation.
• Use the webpage's pause, seek, fullscreen and 0.5–2× speed controls.
• Adjust original and translated audio separately, and turn subtitles on or off.
• Use an English or Simplified Chinese interface (English by default).
• Optionally save completed translated speech and scripts locally. Automatic saving is OFF by default. When enabled, speech is staged in segments and merged into one ZIP with WAV audio and subtitles.

REQUIRES YOUR OWN ACCOUNT AND API KEY: Register at https://qianwenai.com/ and apply for your own API key. Enter it with the matching Workspace ID and region in extension settings. Provider usage is billed to your account. The extension has no subscription, project-operated backend, advertising or analytics. Audio is sent directly to your configured Model Studio service only after you start translation. API keys are restricted to extension-local storage and the model's authentication endpoint.

This is an open-source preview. Bilibili has real short playback checks. YouTube discovery and some audio windows work, but sustained playback has unresolved playback-verification limits. Tencent support is verified for one clear HLS episode. Other sites may be detected without an audio source that can be translated. Unencrypted, ahead-readable audio is required; live streams, DRM decryption, full-video downloads and delayed tab recording are not supported. Preparation may take tens of seconds, depending on source access and the provider.

Source, installation downloads, current limitations, privacy policy and support:
https://github.com/lvyinchao/timbradub

An independent project; not affiliated with Alibaba Cloud, Qwen, Google or the video platforms.

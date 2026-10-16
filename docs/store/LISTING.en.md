# Chrome Web Store listing — English

Name: **Qwen Video Dub — Original-Voice Translation**

Short description: **Translate video speech in its original player, with synchronized audio and bilingual subtitles. Bring your own Model Studio API key.**

Category: Accessibility (video-language accessibility); default language: English.

## Detailed description

Watch supported web videos in another language while keeping the original webpage's player and timeline.

Qwen Video Dub prepares translated speech ahead of the video, then plays it in sync with the source sentences. It requests Qwen LiveTranslate's original-voice mode and includes bilingual subtitles. Voice similarity depends on the model; this is sentence-level alignment, not lip synchronization.

• Choose a detected video and one of 29 supported spoken target languages.
• Switch target language while translating. Cached audio is reused; new content pauses briefly for preparation.
• Use the webpage's pause, seek, fullscreen and 0.5–2× speed controls.
• Adjust original and translated audio separately, and turn subtitles on or off.
• Use an English or Simplified Chinese interface (English by default).
• Optionally save completed translated speech and scripts locally. Automatic saving is OFF by default. When enabled, speech is staged in segments and merged into one ZIP with WAV audio and subtitles.

You need your own compatible Alibaba Cloud Model Studio API key, Workspace ID and region. Provider usage is billed to your account. The extension has no subscription, project-operated backend, advertising or analytics. Audio is sent directly to your configured Model Studio service only after you start translation. API keys are restricted to extension-local storage and the model's authentication endpoint.

This is an open-source preview. Bilibili has real short playback checks. YouTube discovery and some audio windows work, but sustained playback has unresolved playback-verification limits. Tencent support is verified for one clear HLS episode. Other sites may be detected without an audio source that can be translated. Unencrypted, ahead-readable audio is required; live streams, DRM decryption, full-video downloads and delayed tab recording are not supported. Preparation may take tens of seconds, depending on source access and the provider.

Source, installation downloads, current limitations, privacy policy and support:
https://github.com/lvyinchao/qwen-live-translate

An independent project; not affiliated with Alibaba Cloud, Qwen, Google or the video platforms.

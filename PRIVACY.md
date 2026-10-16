# Privacy policy / 隐私政策

Effective: 2026-10-16 · Applies to Video Dub / Qwen Video Dub / 听译, version 0.2.0.

Video Dub is an independent open-source Chrome extension maintained at [lvyinchao/qwen-live-translate](https://github.com/lvyinchao/qwen-live-translate). It has no project-operated server, analytics, ads or data-broker integration. Questions can be raised through [GitHub issues](https://github.com/lvyinchao/qwen-live-translate/issues); report sensitive information privately via [Security](SECURITY.md).

## What the extension accesses

On supported HTTP/HTTPS pages it inspects video elements, player metadata, page/video identity, current video time, and relevant media requests to find playable audio. It may process the page URL/title and media URLs plus the Origin/Referer headers needed to fetch that media. It does not intentionally collect unrelated page text, browsing history, cookies, passwords, payment information or private messages. Broad host permission enables this media-specific behavior across websites; it is not an analytics permission.

## What leaves the browser

When **you start translation**, the extension sends decoded source audio, the selected target language and necessary model/voice settings directly to Alibaba Cloud Model Studio in the configured region and workspace. Original-voice mode asks the provider to reproduce characteristics of the input speaker. The extension receives source text, translated text and translated audio. Media is also fetched from the video's original server/CDN. The project maintainer receives none of this traffic through a project backend.

The explicit connection test also sends a short silent sample to Model Studio to validate credentials; it does not capture website or microphone audio.

Your API key is sent only to the configured, allowlisted Model Studio endpoint for authentication. Model Studio processes requests under your provider agreement and privacy/data-retention terms; this project cannot promise that the provider stores nothing or processes all regions identically. Consult [Model Studio](https://help.aliyun.com/en/model-studio/) and your account's data policies before translating sensitive material. Use content and voices you have permission to process.

The current version sends audio rather than full video files or video frames to the translation model. The extension does not sell data, use it for advertising or send it to project telemetry. Use of information received from Google APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data), including its Limited Use requirements. Data is used only to provide the user-facing translation and local-file features described here.

## Local storage and deletion

| Data                                                          | Location and lifetime                                                                                  | Your controls                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| API key, workspace, region and preferences                    | Chrome extension-local storage, restricted to trusted extension contexts; not Chrome sync              | Forget credentials in settings; uninstall removes extension storage                                          |
| Translated speech, text and prepared ranges                   | Browser IndexedDB playback cache, with a default 128 MiB LRU limit                                     | Stop translation, then clear playback cache in settings                                                      |
| Temporary original-media bytes for servers without HTTP Range | Browser-private temporary files; at most two sources, each capped at 2 GiB                             | Reclaimed by source lifecycle/next temporary-source creation; removing extension site data also removes them |
| Optional completed-utterance archives                         | Browser-private local files; retained for merge/retry                                                  | Automatic saving is **off by default**; old staged files remain until extension storage/site data is removed |
| Exported WAV, scripts and subtitles                           | A ZIP in your Chrome download folder when auto-save is enabled or you explicitly request a merge/retry | Delete downloaded files using your file manager; uninstall does not delete them                              |

Turning automatic file saving off prevents new archive staging and new automatic downloads. It does not turn off the playback cache, remove previous archives, or cancel an already-issued Chrome download. Stopping a task closes its model work and clears temporary authentication rules. Provider-side retention is controlled separately by the provider.

## Permissions

`storage` saves settings and task state; `sidePanel` presents controls; `tabs`/`activeTab` identify the selected page; `scripting` and content scripts inspect/control media; `webRequest` observes relevant media requests; host access fetches source audio; `declarativeNetRequestWithHostAccess` supplies tightly scoped model authentication and media request headers; `offscreen` handles audio/media processing; `downloads` saves optional merged exports. The extension does not request microphone, camera, tabCapture, debugger or browsing-history permissions.

## Updates

Changes to processing or permissions will be documented here and in release notes. This policy covers the extension, not independent websites, GitHub or Alibaba Cloud services.

## 中文摘要

只有你点击开始翻译后，音轨才会由扩展直接发送至所选地域和 Workspace 的百炼服务，同时请求原音色译音。项目维护者没有接收这些数据的自建后端；没有广告、分析统计或数据出售。原视频服务器/CDN 仍会收到正常媒体请求。百炼如何保留请求数据，以你使用的服务条款和账号配置为准。

凭据保存在受限的扩展本地存储，不进入网页或 Chrome 同步。译音播放缓存、无 Range 音轨所需临时文件与可选永久归档是不同存储。自动保存默认关闭；关闭不删除旧文件，也不禁用播放缓存。设置页可忘记凭据、清理播放缓存；清除扩展全部站点数据或卸载会移除扩展内部存储，下载目录中的文件需要你自行删除。完整范围、权限和保留规则见上表。

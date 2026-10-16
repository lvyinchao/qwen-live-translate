# Privacy policy / 隐私政策

Effective: 2026-10-16 · Applies to TimbraDub / 听译. The CCTV metadata lookup described below is introduced in 0.2.4.

TimbraDub is an independent open-source Chrome extension maintained at [lvyinchao/timbradub](https://github.com/lvyinchao/timbradub). It has no project-operated server, analytics, ads or data-broker integration. Questions can be raised through [GitHub issues](https://github.com/lvyinchao/timbradub/issues); report sensitive information privately via [Security](SECURITY.md).

## What the extension accesses

While the side panel is open, it inspects the selected HTTP/HTTPS tab's video elements, player metadata, page/video identity, current video time and relevant media requests to find playable audio. A 15-second observation lease is renewed by the panel; the active translation tab remains observed until the task stops. Other tabs' media responses are ignored before their URLs or headers are stored. Closing the panel or switching its selected tab releases observation of the previous tab unless that tab still has the active translation task. Observed media metadata has a 60-second validity period; expired records are removed on the next scan or service-worker startup, rather than by an always-running timer. For Tencent pages, a small page-local bridge can retain recent media metadata before the panel opens, so it can replay that information on a later scan; background retention still requires the observation lease. It may process the page URL/title and media URLs plus the Origin/Referer headers needed to fetch that media. It does not intentionally collect unrelated page text, browsing history, cookies, passwords, payment information or private messages. Broad host permission enables this media-specific behavior across websites; it is not an analytics permission.

## What leaves the browser

When **you start translation**, the extension sends decoded source audio, the selected target language and necessary model/voice settings directly to Alibaba Cloud Model Studio in the configured region and workspace. Original-voice mode asks the provider to reproduce characteristics of the input speaker. The extension receives source text, translated text and translated audio. Media is also fetched from the video's original server/CDN. The project maintainer receives none of this traffic through a project backend.

On supported CCTV desktop VOD pages, opening the side panel and selecting the page can send the current programme GUID to the fixed official endpoint `https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do`, before translation starts. This request sends neither cookies nor Model Studio credentials. Only a validated public media URL, title and duration are cached in extension memory with five-minute validity; failed lookups can retry after two seconds, and releasing observation clears the lookup. An expired lookup is replaced on the next scan rather than by an always-running deletion timer. This API-specific cache is separate from the 60-second validity of observed media addresses/header context. The raw response, including any IP or `client_sid` fields, is not persisted or logged. No additional extension permission is requested.

The explicit connection test also sends a short silent sample to Model Studio to validate credentials; it does not capture website or microphone audio.

Your API key is sent only to the configured, allowlisted Model Studio endpoint for authentication. Model Studio processes requests under your provider agreement and privacy/data-retention terms; this project cannot promise that the provider stores nothing or processes all regions identically. Consult [Model Studio](https://help.aliyun.com/en/model-studio/) and your account's data policies before translating sensitive material. Use content and voices you have permission to process.

The current version sends audio rather than full video files or video frames to the translation model. The extension does not sell data, use it for advertising or send it to project telemetry. Use of information received from Google APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data), including its Limited Use requirements. Data is used only to provide the user-facing translation and local-file features described here.

## Local storage and deletion

| Data                                                          | Location and lifetime                                                                                  | Your controls                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| API key, workspace, region and preferences                    | Chrome extension-local storage, restricted to trusted extension contexts; not Chrome sync              | Forget credentials in settings; uninstall removes extension storage                                          |
| CCTV public-programme metadata lookup | Extension memory only: programme GUID and validated public URL/title/duration, valid for five minutes; no raw API response | Closing the panel or changing its selected tab clears the lookup unless that tab still has the active translation task |
| Translated speech, text and prepared ranges                   | Browser IndexedDB playback cache, with a default 128 MiB LRU limit                                     | Stop translation, then clear playback cache in settings                                                      |
| Temporary original-media bytes for servers without HTTP Range | Browser-private temporary files; each decoder keeps at most two sources, each capped at 2 GiB. Retiring and new decoders can briefly coexist during a switch. | Decoder shutdown releases files and reclaims unused sources; after stopping, clear temporary media in settings. Locked files are skipped and their remaining space stays visible. |
| Optional completed-utterance archives | Browser-private local files; retained for merge/retry, with unreferenced parts reclaimed | Automatic saving is **off by default**; after stopping, clear staged archives separately in settings. This does not delete Chrome downloads. |
| Exported WAV, scripts and subtitles                           | A ZIP in your Chrome download folder when auto-save is enabled or you explicitly request a merge/retry | Delete downloaded files using your file manager; uninstall does not delete them                              |

Turning automatic file saving off prevents new archive staging and new automatic downloads. It does not turn off the playback cache, remove previous archives, or cancel an already-issued Chrome download. Stopping a task closes its model work and clears temporary authentication rules. Provider-side retention is controlled separately by the provider.

## Permissions

`storage` saves settings and task state; `sidePanel` presents controls; `tabs`/`activeTab` identify the selected page; `scripting` and content scripts inspect/control media; `webRequest` observes relevant media requests; host access fetches source audio; `declarativeNetRequestWithHostAccess` supplies tightly scoped model authentication and media request headers; `offscreen` handles audio/media processing; `downloads` saves optional merged exports. The extension does not request microphone, camera, tabCapture, debugger or browsing-history permissions.

## Updates

Changes to processing or permissions will be documented here and in release notes. This policy covers the extension, not independent websites, GitHub or Alibaba Cloud services.

## 中文摘要

只有你点击开始翻译后，音轨才会由扩展直接发送至所选地域和 Workspace 的百炼服务，同时请求原音色译音。项目维护者没有接收这些数据的自建后端；没有广告、分析统计或数据出售。原视频服务器/CDN 仍会收到正常媒体请求。百炼如何保留请求数据，以你使用的服务条款和账号配置为准。

凭据保存在受限的扩展本地存储，不进入网页或 Chrome 同步。译音播放缓存、无 Range 音轨所需临时文件与可选永久归档是不同存储。自动保存默认关闭；关闭不删除旧文件，也不禁用播放缓存。设置页可忘记凭据，并分别查看和清理播放缓存、临时原媒体及分段归档的空间；清理归档不会删除下载目录中的 ZIP。打开侧栏时只观察所选标签，正在翻译的标签持续观察至停止；关闭侧栏或切换后释放其他标签的观察。观察租约为 15 秒，资源信息有效期为 60 秒，过期内容在扫描或后台重新启动时清理。

0.2.4 起，打开侧栏并选中受支持的央视普通点播页面时，可在开始翻译前将当前节目 GUID 发送给固定的央视官方 API；不携带 Cookie 或模型密钥。扩展仅在内存中保留节目 GUID、已校验的公开媒体地址、标题与时长，成功结果有效 5 分钟，失败后 2 秒允许重试，释放观察时清除；过期查询在下次扫描时替换，不承诺后台定时删除。这是普通观察信息 60 秒有效期之外的单独例外；不会持久保存或记录含 IP、`client_sid` 等字段的原始 API 响应，也不增加权限。清除扩展全部站点数据或卸载会移除扩展内部存储，下载目录中的文件需要你自行删除。完整范围、权限和保留规则见上表。

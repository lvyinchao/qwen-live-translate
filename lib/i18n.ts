import type { UILanguage } from './types';

// Keep the original internal errors stable: retry classification and diagnostics
// use them. Localize at the presentation boundary, never model text or subtitles.
const english = {
  自动保存翻译文件: 'Save translation files automatically',
  '关闭时仅使用播放缓存，不自动保存脚本、译音文件或发起下载。已有文件会保留。':
    'When off, only the playback cache is used. Transcripts and audio files are not saved automatically, and no automatic downloads start. Existing files are kept.',
  自动保存已关闭: 'Automatic saving is off',
  '持续检测音轨中，找到可用资源后自动更新。':
    'Watching for audio. Available sources appear automatically.',
  媒体资源: 'Media stream',
  '媒体资源已发现，暂未找到可控制的网页播放器':
    'Media detected. A controllable in-page player has not been found yet.',
  '检测到受保护视频，暂不支持提前翻译':
    'Protected video detected. Reading audio ahead is not supported.',
  '发现多个媒体资源，暂无法确定当前视频音轨':
    'Multiple media resources found. The current audio track could not be matched yet.',
  '已发现 DASH 清单，暂未接入该站音轨解析':
    'DASH playlist detected. Audio extraction for this site is not yet supported.',
  '已发现媒体分片，尚缺可提前读取的完整音轨':
    'Media segments detected. A complete audio source is still needed.',
  '发现的音频资源短于当前视频，可能属于广告或单个分片；未找到完整音轨，请重新扫描':
    'The detected audio is shorter than this video and may be an ad or a single segment. Rescan for a complete audio track.',
  '打开视频网站的点播页面，播放几秒后重新扫描。':
    'Open a video page, play a few seconds, then rescan.',

  '音轨服务器读取超时，请重试':
    'Reading the audio server timed out. Please retry.',
  '音轨服务器返回的数据不完整，请刷新资源后重试':
    'The audio server returned incomplete data. Refresh the media and retry.',
  '音轨临时存储空间不足，请释放磁盘空间后重试':
    'Temporary audio storage is full. Free disk space and retry.',
  '不支持范围读取的音轨超过 2 GiB，无法提前读取':
    'This audio track exceeds the 2 GiB limit for servers without range support.',
  '当前浏览器无法创建音轨临时文件，请检查本地存储权限':
    'The browser could not create temporary audio storage. Check local storage permissions.',

  '片段自动暂存在本机，翻译结束或停止时合并为一个音频包；分段不发起下载。':
    'Audio chunks save quietly on this device. When translation finishes or stops, they merge into one audio package. No per-chunk downloads.',
  '正在合并并保存…': 'Merging and saving…',
  '已保存 {count} 个结果': '{count} saved results',
  '译音先分段保存，完成后自动合并':
    'Audio saves in chunks, then merges when finished',
  '已暂存 {count} 段译音': '{count} audio chunks stored locally',
  '有 {count} 个视频待合并': '{count} videos ready to merge',
  合并并保存: 'Merge and save',
  '无法合并：译音 WAV 格式无效': 'Cannot merge: invalid translated WAV format.',
  '合并音频超过 WAV 文件上限': 'Merged audio exceeds the WAV file size limit.',
  '本地译音片段不完整，无法合并':
    'A local audio chunk is incomplete and cannot be merged.',
  '合并文件超过 ZIP 文件上限':
    'The merged package exceeds the ZIP file size limit.',
  本地译音片段信息无效: 'Invalid local audio chunk metadata.',
  本地保存: 'Local files',
  '脚本、字幕与原音色音频自动保存到下载目录，按视频和目标语言分文件夹。':
    'Transcripts, subtitles and original-voice audio save automatically to your Chrome download folder, organized by video and target language.',
  '正在保存文件…': 'Saving files…',
  '已保存 {count} 个译音包': '{count} translation bundles saved',
  '翻译完成的内容会自动保存为 ZIP':
    'Completed translations save automatically as ZIP files',
  '待保存 {count} 批': '{count} batches waiting to save',
  '本地保存失败，待保存内容已保留，请重试。':
    'Saving failed. Please retry to save the queued files.',
  查看已保存文件: 'Show saved files',
  重试保存: 'Retry saving',
  '本地保存待处理内容已满，请先重试保存':
    'The local save queue is full. Retry saving before continuing.',
  不允许网页读取本地保存内容:
    'Web pages cannot access saved translation files.',
  本地保存暂不可用: 'Local saving is temporarily unavailable.',
  本地文件不存在: 'The saved file is unavailable.',
  不允许网页保存文件: 'Web pages cannot save extension files.',
  本地保存路径无效: 'Invalid local save path.',
  '本地文件保存中断，请重试': 'File saving was interrupted. Please retry.',
  '本地文件保存超时，请重试': 'File saving timed out. Please retry.',
  听译: 'TimbraDub',
  '听译 · 视频译音': 'TimbraDub',
  打开听译: 'Open TimbraDub',
  界面语言: 'Interface language',
  打开设置: 'Open settings',
  未开始: 'Not started',
  准备中: 'Preparing',
  准备译音: 'Buffering',
  正在翻译: 'Translating',
  已暂停: 'Paused',
  已结束: 'Ended',
  需要处理: 'Needs attention',
  '原网页 · 同步译音': 'In-page · Synced audio',
  返回视频: 'Back to videos',
  连接你的百炼: 'Connect Model Studio',
  '使用自己的账户调用模型。凭据只保存在本机，不会提供给视频网页。':
    'Use your own Alibaba Cloud Model Studio account. Credentials stay on this device and are never shared with video pages.',
  '翻译需要你自己的账号和 API Key。请前往':
    'Translation requires your own account and API key. Visit',
  '注册账号并申请 API Key，模型费用由你的账号按用量结算。':
    'to register an account and obtain an API key. Model usage is billed to your account.',
  已保存: 'Saved',
  待填写: 'Required',
  '留空保留已保存的 Key': 'Leave blank to keep the saved key',
  '百炼业务空间 ID': 'Model Studio workspace ID',
  服务地域: 'Service region',
  '华北 2 · 北京': 'China North 2 · Beijing',
  新加坡: 'Singapore',
  保存配置: 'Save settings',
  验证连接: 'Test connection',
  当前模型: 'Current model',
  '支持 29 种语言译音，随原说话人复刻音色。费用由百炼账户按实际用量结算。':
    'Dub into 29 languages using the original speaker’s voice. Usage is billed to your Model Studio account.',
  导出最近一次播放诊断: 'Export latest playback diagnostics',
  清除译音缓存: 'Clear audio cache',
  移除凭据: 'Remove credentials',
  配置已保存在这台浏览器中: 'Settings saved in this browser.',
  '播放诊断已导出，不含密钥和媒体地址':
    'Diagnostics exported without credentials or media URLs.',
  译音缓存已清除: 'Audio cache cleared.',
  本机凭据已移除: 'Credentials removed from this device.',
  当前页面: 'Current page',
  选择要观看的视频: 'Choose a video',
  重新扫描视频: 'Rescan videos',
  '用原声的音色，听另一种语言。':
    'The original voice. A new language.',
  当前页面的视频: 'Videos on this page',
  网页视频: 'Web video',
  音轨已识别: 'Audio track found',
  等待识别音轨: 'Waiting for audio track',
  让视频先出现: 'Find a video first',
  '打开 Bilibili 点播页面，播放几秒后重新扫描。':
    'Open a Bilibili video, play a few seconds, then rescan.',
  重新扫描: 'Rescan',
  'YouTube 长视频尚未通过连续译音验收；遇到音轨播放验证限制时会停止翻译。':
    'Continuous dubbing of long YouTube videos is not yet verified. Translation stops if audio playback verification blocks access.',
  '先播放几秒，让浏览器发现音轨，再点击重新扫描。':
    'Play a few seconds to let the browser find the audio track, then rescan.',
  翻译成: 'Translate into',
  '自动识别原语言 · 保留原音色': 'Auto-detect source · Original voice',
  先连接百炼账户: 'Connect Model Studio first',
  停止翻译: 'Stop translation',
  开始翻译: 'Start translation',
  '后续译音 {seconds} 秒': '{seconds}s of audio ready ahead',
  '{rate}× 播放': '{rate}× playback',
  '正在提前准备译音，就绪后会自动继续播放。':
    'Preparing translated audio ahead. Playback resumes when ready.',
  原声: 'Original',
  译音: 'Translated',
  双语字幕: 'Bilingual subtitles',
  '为跟随画面，已有 {count} 处过长译音跳过尾部。完整译文仍可查看。':
    'To keep up with the video, {count} long audio tails were skipped. Full translations remain available.',
  译文片段: 'Transcript',
  译音尾部已跳过: 'Audio tail skipped',
  '先准备一小段译音，再边看边翻译。':
    'Prepare a short buffer, then translate as you watch.',
  '暂停、跳转和倍速，译音跟随视频。':
    'Audio follows pauses, seeks and playback speed.',
  '由 Qwen 提供译音': 'Audio by Qwen',
  '自用预览版 · {version}': 'Personal preview · {version}',
  '请点击视频播放按钮，继续观看': 'Click the video’s play button to continue.',
  '翻译已停止，请查看侧边栏': 'Translation stopped. Check the sidebar.',
  '正在准备译音 · 已准备 {seconds} 秒': 'Preparing audio · {seconds}s ready',
  '请点击视频一次，允许播放译音':
    'Click the video to allow translated audio playback.',
  '操作未完成，请重试': 'The action could not be completed. Please try again.',
  '已连接 Qwen3.8 LiveTranslate': 'Connected to Qwen3.8 LiveTranslate.',
  无效的界面语言: 'Invalid interface language.',
  不允许网页读取配置: 'Web pages cannot read extension settings.',
  不允许网页修改配置: 'Web pages cannot change extension settings.',
  不允许网页测试凭据: 'Web pages cannot test credentials.',
  不允许网页触发扫描: 'Web pages cannot start a scan.',
  不允许网页读取诊断: 'Web pages cannot read diagnostics.',
  不允许网页触发选择: 'Web pages cannot select a player.',
  不允许网页触发翻译: 'Web pages cannot start translation.',
  不允许网页停止翻译: 'Web pages cannot stop translation.',
  不允许网页安装鉴权规则: 'Web pages cannot install authentication rules.',
  不允许网页修改鉴权规则: 'Web pages cannot change authentication rules.',
  不允许网页修改请求规则: 'Web pages cannot change request rules.',
  不允许网页清理缓存: 'Web pages cannot clear the cache.',
  请先停止翻译再测试连接: 'Stop translation before testing the connection.',
  无效的目标语言: 'Invalid target language.',
  翻译任务已过期: 'This translation task has expired.',
  '视频已变化，请重新扫描': 'The video has changed. Please rescan.',
  '请等待广告结束，再选择正片':
    'Wait for the ad to finish, then select the video.',
  首版仅支持普通点播视频: 'This preview supports on-demand videos only.',
  '尚未发现可预取的音轨。请先播放几秒，再重新扫描；本版本不会以滞后采集代替同步。':
    'No audio track is available for prefetching. Play a few seconds, then rescan. This preview requires audio that can be read ahead for synchronized playback.',
  请先在设置中填写百炼凭据:
    'Enter your Model Studio credentials in settings first.',
  '播放器已被页面替换，请重新扫描':
    'The page replaced the player. Please rescan.',
  媒体域名不在允许范围: 'This media domain is not allowed.',
  '请先停止翻译，再清理缓存': 'Stop translation before clearing the cache.',
  没有可预取的音轨: 'No audio track is available for prefetching.',
  '音轨读取超时，请刷新视频后重新扫描':
    'Audio loading timed out. Refresh the video and rescan.',
  媒体资源没有可解码的音轨: 'The media has no decodable audio track.',
  当前浏览器不支持这条音轨的编码格式:
    'This browser does not support the audio track’s codec.',
  '未读到该时间段的音频，请刷新资源地址后重试':
    'No audio was found for this interval. Refresh the source and try again.',
  '提前读取请求未通过 YouTube 音轨播放验证，当前版本无法继续。翻译已停止，原声设置已恢复；可以重载视频后再试。':
    'YouTube audio playback verification blocked prefetching. Translation has stopped and original audio settings have been restored. Reload the video to try again.',
  'SABR 请求字段不完整': 'Incomplete SABR request field.',
  'SABR 请求字段过长': 'SABR request field is too long.',
  'SABR 请求字段无效': 'Invalid SABR request field.',
  '不支持的 SABR 请求字段': 'Unsupported SABR request field.',
  'SABR 请求字段越界': 'SABR request field is out of bounds.',
  'SABR 请求缺少播放器上下文': 'The SABR request is missing player context.',
  当前译音片段超过缓存上限: 'This audio segment exceeds the cache limit.',
  '请填写有效的百炼 Workspace ID': 'Enter a valid Model Studio workspace ID.',
  请选择北京或新加坡地域: 'Choose the Beijing or Singapore region.',
  '请填写有效的百炼 API Key': 'Enter a valid Model Studio API key.',
  '译音 PCM 字节长度不完整':
    'The translated PCM audio has an incomplete byte length.',
  '翻译响应未完整完成，请重试当前片段':
    'The translation response is incomplete. Retry this segment.',
  '模型译音缺少可靠的源时间戳或消息关联，已停止本段以防音画错位':
    'The model response lacks reliable source timestamps or message associations. This segment stopped to prevent audio drift.',
  '检测到人声但没有获得完整译音，请重试':
    'Speech was detected but no complete translated audio was received. Please retry.',
  任务已取消: 'Task cancelled.',
  '模型连接或响应超时，请检查地域、网络和模型权限':
    'The model connection or response timed out. Check your region, network and model access.',
  '百炼 WebSocket 连接失败：请检查 Key、Workspace、地域和模型访问权限':
    'Model Studio WebSocket connection failed. Check your key, workspace, region and model access.',
  '连接返回了不同模型，已停止':
    'The connection returned a different model and has been stopped.',
  '模型未确认启用原音色复刻，已停止翻译':
    'The model did not confirm original voice cloning. Translation has stopped.',
  'UMP 分片超过安全读取上限': 'The UMP fragment exceeds the safe read limit.',
  '无效的 SABR 读取窗口': 'Invalid SABR read window.',
  '播放器尚未提供完整 SABR 音轨信息，请播放几秒后重新扫描':
    'The player has not provided complete SABR audio information. Play a few seconds, then rescan.',
  'SABR 重定向到了未允许的媒体域名':
    'SABR redirected to a media domain that is not allowed.',
  '音轨属于广告或其他视频，已停止':
    'The audio belongs to an ad or another video. Playback has stopped.',
  'SABR 窗口超出读取上限': 'The SABR window exceeds the read limit.',
} as const;

export type MessageKey = keyof typeof english;
export function normalizeUILanguage(value: unknown): UILanguage {
  return value === 'zh' ? 'zh' : 'en';
}
export function t(
  locale: UILanguage,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const template = locale === 'zh' ? key : english[key];
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    values[name] === undefined ? token : String(values[name]),
  );
}

export function languageName(code: string, locale: UILanguage): string {
  return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
}

export function localizeMessage(message: string, locale: UILanguage): string {
  if (locale === 'zh') return message;
  if (Object.hasOwn(english, message)) return english[message as MessageKey];
  return message
    .replace(
      /^翻译连接提前断开（(\d+)），本段未标记为完成$/,
      'Translation disconnected early ($1). This segment was not marked complete.',
    )
    .replace(/^百炼限流：(.*)$/, 'Model Studio rate limit: $1')
    .replace(
      /^百炼返回错误：(.*)，请核对模型权限和配置$/,
      'Model Studio error: $1. Check model access and settings.',
    )
    .replace(
      /^YouTube SABR 读取失败（HTTP (\d+)），请刷新播放凭据后重试$/,
      'YouTube SABR request failed (HTTP $1). Refresh playback credentials and retry.',
    )
    .replace(
      /^音轨时间窗口不完整（需要 (.+)～(.+) 秒，取得 (.+)～(.+) 秒）$/,
      'Incomplete audio window (requested $1–$2s, received $3–$4s).',
    )
    .replaceAll('[已隐藏密钥]', '[redacted key]')
    .replaceAll('[已隐藏]', '[redacted]')
    .replaceAll('[媒体地址]', '[media URL]');
}

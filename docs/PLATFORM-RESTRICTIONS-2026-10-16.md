# 订阅平台与受保护播放：官方资料核验

2026-10-16。评估基准为已发布 TimbraDub 0.2.4，发布提交 `810d771f465481a9a9798e437d9f09e64c76c760`（已剥离 annotated tag 对象），运行时 SHA-256 `429f29c34ba61a739a7fdd43af0924ef7856002120849690e0cc47ba4c34a55a`。本项仅查官方公开帮助、协议与技术资料，没有登录、购买、播放订阅正片或调用模型；不是这些平台的扩展实测通过记录。

## 结论与判断口径

**五家海外服务都有官方 Chrome 网页观看路径；这与扩展能否提前提取音轨是两回事。** Google 的 [Widevine 官方概览](https://developers.google.com/widevine/drm/overview)将 Netflix、Disney+、Amazon Prime Video、HBO Max、Hulu 列为使用方，并说明受保护播放由 CDM、许可证代理及业务授权共同完成。这能确认这些服务使用 DRM，不能证明每条预告、免费片段、每个清晰度或地区都加密；该文最后更新于 2024-10-09，也不是当前逐片技术清单。

对 0.2.4，应按**具体媒体资源**判断：已识别 MediaKeys/加密保护的播放不在当前提前解码路径内；未登录、地区受限、仅有广告或没有媒体请求时，记录“正片未验证/访问条件未满足”，不能改写成“扩展不兼容”。`blob:`、MSE、`.mpd` 或 VIP 标签本身也不等于已证明 DRM。公开预告片读通，仍不能代表订阅正片读通。

## 海外订阅服务

| 平台 | 官方可确认的网页、账号与地区条件 | 对扩展结论的边界 |
| --- | --- | --- |
| Netflix | [浏览器要求](https://help.netflix.com/en/node/30081)：Windows 10/11、macOS 10.15.5+ 的 Chrome 最低 117；分辨率随系统而异。[M7702-1003 帮助](https://help.netflix.com/en/node/30321)明确涉及受保护内容设置和 Widevine 更新。[地区说明](https://help.netflix.com/en/node/14164)称覆盖 190 多个国家/地区，但不在中国等所列地区提供服务，片库随地区变化。 | 浏览器支持不提供可独立解码的明文音轨保证。本次没有会员正片样本，不能判整个站通过或失败；中国地区不可用与扩展缺陷分开记录。 |
| Prime Video | [电脑要求](https://www.primevideo.com/help?language=en_US&nodeId=GUX9FYHU5D8LC9EJ)：Windows/macOS/ChromeOS/Linux 支持最新版 Chrome 等浏览器；非 Windows/macOS 限 SD。[旅行说明](https://www.primevideo.com/help?language=en_US&nodeId=GJ2P83PMNC54XKV9)明确会员离开本国后可看片目会变化。 | 未核验当前地区的具体账号、订阅/单片权益或正片许可证；不能将免费频道、预告、租购和 Prime 正片混成一个结果。 |
| Disney+ | [浏览器要求](https://help.disneyplus.com/de/article/disneyplus-de-li-computer-browser-requirements)列 Windows 10+、macOS 11+ 的最新版 Chrome，另支持 ChromeOS。[订阅激活说明](https://help.disneyplus.com/en-GB/article/disneyplus-en-li-third-party-subscription)要求第三方订阅按渠道激活/登录；[地区说明](https://help.disneyplus.com/article/disneyplus-en-ph-location-availability)说明服务覆盖选定地区，片目随所在地变化。 | 文档涉及不同地区的站点版本，不能统一成全球同一片库、同一鉴权方式；订阅浏览器可观看不等于解码 Worker 可读取。 |
| Hulu（美国服务） | [电脑观看说明](https://help.hulu.com/article/hulu-watching-hulu-on-site)要求在 Hulu.com 登录，提供 Chrome Web App；[定位帮助](https://help.hulu.com/article/hulu-location-services)有 Chrome 设置步骤。[国际限制](https://help.hulu.com/article/hulu-cant-use-internationally?language=en_US)区分点播与 Live TV 的美国地区条件，并限制代理使用。 | 本次未取得电脑要求页的完整正文，因此不编造最低 Chrome 版本。不能将美国 Hulu 的结论套用于日本独立服务或其他地区的 Disney+ 片库。直播本来就不在扩展首版范围。 |
| Max / HBO Max | 当前官方名称为 HBO Max。[设备说明](https://help.hbomax.com/gb-en/answer/detail/000002506)支持 PC/Mac/Chromebook、当前版 Chrome，并列订阅/登录流程；[可用地区](https://help.hbomax.com/us-en/Answer/Detail/000002518)逐区列出市场，旅行片库会变化，未开放地区不能在线串流。 | 地区表没有中国大陆；这不是扩展运行失败证据。不同区域账号、套餐、片目及实际媒体保护仍需各自验证。 |

## 国内付费内容

| 平台 | 官方受限条件与技术证据 | 尚不能推断 |
| --- | --- | --- |
| 腾讯视频 | [官方用户协议](https://rule.tencent.com/rule/399ab3d0-4989-4f34-9d7b-99c579b4cbdf)的可检索正文 3.2.2–3.2.3 将操作范围关联账号身份/权限，并要求会员遵守对应规则；[官方会员协议入口](https://film.qq.com/support/term.html)存在，但本次匿名文本提取只返回页面框架，未取得当前完整条款。 | 不引用第三方转载补成“已核实当前条款”，不从腾讯云 DRM SDK 的能力推断腾讯视频每条正片使用同一 DRM。已知单个明文 HLS 样本与其他付费片源必须分开。 |
| 爱奇艺 | [2026-07-09 服务协议](https://www.iqiyi.com/common/loginProtocol.html)1.3 限中国境内（不含港澳台），2.1 说明部分服务需注册/登录，3.7 区分 VIP、单片付费等权益，4.1.3 禁止破坏安全措施。[2018 年官方公告](https://www.iqiyi.com/common/20181214/e9f320e07ea351ab.html)确认接入 Widevine，作为多 DRM 方案的一部分。 | 历史公告不能证明今天任意页面、清晰度或预告都走 Widevine；防盗链也不必然是 DRM。账号或会员未满足时，正片解码能力仍属未测。 |
| 优酷 | [2026-07-14 系列会员协议](https://svip.youku.com/trade/subscribeagreement)明确登录会员账号才能享受相应权益，其他单片付费另有规则，并区分网页端/客户端及设备限制；二（二）2.1 限制以非法破解等方式分离平台服务。 | 这份协议不是逐片 DRM/Chrome 版本表；本次未找到可核实全部正片保护方式的官方清单，不能声称“优酷全部 DRM”或“登录就能翻译”。 |

建议主兼容表使用“受保护正片：当前路径不支持；具体片源未做已授权实测”“登录/地区条件未满足：未验证”两类状态。只有真实观察到保护信号才能给具体样本标注 DRM；匿名公开样本的发现、暂停预读和译音播放由独立实测记录补充，不能由本资料表代替。

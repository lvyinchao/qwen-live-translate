# 在 Chrome 安装听译 TimbraDub

**从 [GitHub Releases](https://github.com/lvyinchao/timbradub/releases/latest) 下载 `timbradub-<版本>-chrome.zip`。**

1. 完整解压 ZIP，保留其中全部文件。
2. 在桌面 Chrome 116 或更新版本打开 `chrome://extensions`。
3. 打开右上角“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择**直接包含 `manifest.json` 的解压文件夹**。自 v0.2.2 起，安装包没有额外的 `extension` 子目录。
5. 固定 TimbraDub，并刷新安装前已打开的视频页面。

```text
timbradub-<版本>-chrome/  ← 选择这个解压文件夹
├── manifest.json
├── sidepanel.html
├── background.js
├── content-scripts/
├── icons/
├── licenses/
├── README.md
└── README.zh-CN.md
```

解压软件生成的文件夹名称可能不同。判断依据是：打开所选文件夹就能直接看到 `manifest.json`。如果提示“清单文件缺失或不可读取”，请确认 ZIP 已完整解压，并选择清单实际所在的文件夹。安装后保留该文件夹，移动或删除会使已解压扩展无法使用。

**v0.2.1 及更早版本**的安装包仍需选择里面的 `extension` 子目录。开发者从源码构建后选择 `.output/chrome-mv3`；本机打包生成的稳定目录仍为 `outputs/extension`。

## 三种 ZIP 的区别

| 文件                            | 用途                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| `timbradub-<版本>-chrome.zip`   | 本地安装：完整解压后，直接加载解压文件夹。含中英文安装说明。 |
| `timbradub-<版本>-webstore.zip` | 给 Chrome 商店开发者后台上传审核；不是可点击安装的签名 CRX。 |
| `timbradub-<版本>-source.zip`   | 开发源码和测试；需要先 `npm ci` 并构建，再安装构建产物。     |
| `SHA256SUMS.txt`                | 上述三个包的 SHA-256 校验值。                                |

不要把这些 ZIP 直接拖到扩展管理页安装。浏览器或 Chrome 商店也可能有组织/账号限制。商店审核状态见仓库的 `docs/store/STATUS.md`，GitHub 可下载与商店审核通过是两个独立状态。

## 开始翻译前

**用户需要自行到 [qianwenai.com](https://qianwenai.com/) 注册账号并申请自己的 API Key。** 在插件设置中填写密钥、Workspace ID 和对应地域，保存并测试连接。模型费用由用户自己的账号结算，项目不提供公共密钥或免费额度。

可使用已实测的 [Bilibili 示例视频](https://www.bilibili.com/video/BV13rsaeaEgE/)：先播放几秒，再选择播放器和目标语言，点击开始翻译。插件请求保留原说话人音色，并提前准备译音；相似度取决于模型和音源。完整用法与兼容限制见 [GitHub](https://github.com/lvyinchao/timbradub)。

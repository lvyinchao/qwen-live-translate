# Install TimbraDub in Chrome

**Download `timbradub-<version>-chrome.zip` from [GitHub Releases](https://github.com/lvyinchao/timbradub/releases/latest).**

1. Extract the ZIP completely. Keep all its files together.
2. Open `chrome://extensions` in desktop Chrome 116 or newer.
3. Turn on **Developer mode** and choose **Load unpacked**.
4. Select the extracted folder that **directly contains `manifest.json`**. From v0.2.2, there is no additional `extension` subfolder in this ZIP.
5. Pin TimbraDub and refresh video pages that were already open.

```text
timbradub-<version>-chrome/  ← select this extracted folder
├── manifest.json
├── sidepanel.html
├── background.js
├── content-scripts/
├── icons/
├── licenses/
├── README.md
└── README.zh-CN.md
```

The folder name may vary depending on your extraction app. The deciding factor is `manifest.json` directly inside it. “Manifest file is missing or unreadable” means the selected folder does not contain a readable `manifest.json`; check that the ZIP is fully extracted and that you selected the correct folder. Keep the folder afterward: deleting or moving an unpacked extension breaks its installation.

For **v0.2.1 and older** installation ZIPs, select the inner `extension` folder instead. For a developer checkout, build first and select `.output/chrome-mv3`; the locally packaged stable directory remains `outputs/extension`.

## Which download?

| Asset                              | Purpose                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `timbradub-<version>-chrome.zip`   | Install locally: extract and load its root folder. Includes these bilingual instructions. |
| `timbradub-<version>-webstore.zip` | Upload to the Chrome Web Store developer dashboard. Not a click-to-install signed CRX.    |
| `timbradub-<version>-source.zip`   | Source for development and tests. Run `npm ci`, then build before loading.                |
| `SHA256SUMS.txt`                   | SHA-256 checksums for those three archives.                                               |

Chrome does not directly install these ZIPs by dragging them onto the extensions page. The browser or Chrome Web Store may impose organization/account restrictions independently of the archive layout. Store review status is recorded in the repository's `docs/store/STATUS.md`; a GitHub download does not mean store approval.

## Before translating

**Register at [qianwenai.com](https://qianwenai.com/) and obtain your own API key.** Open extension settings, enter that key with its Workspace ID and matching region, save and test the connection. Usage is billed to your own provider account. This project supplies no shared key or credits.

Try the tested [Bilibili example](https://www.bilibili.com/video/BV13rsaeaEgE/). Play a few seconds, select its player and target language, then start translation. TimbraDub requests original-speaker voice and prepares audio ahead; voice similarity depends on the source and model. Compatibility limits and full usage instructions are on [GitHub](https://github.com/lvyinchao/timbradub).

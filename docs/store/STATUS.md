# Chrome Web Store status

As of 2026-10-16: **v0.2.3 submitted and pending review**. The developer console confirmed the submission, including the startup-race fix and independent source/target captions. Approval and public store availability are not confirmed.

- Product: **TimbraDub — Original-Voice Video Translation** / **TimbraDub 听译 — 原音色视频翻译**.
- Submitted version: **0.2.3**.
- Item ID: `knlbmnbdcnnhhpimbeagojbacmjkcald`.
- The earlier v0.2.1 and v0.2.2 reviews were cancelled to replace them with verified fixes.
- **Automatically publish after approval** was checked for this v0.2.3 submission.
- English and Simplified Chinese listing text explicitly requires users to register at [qianwenai.com](https://qianwenai.com/) and obtain their own API key; provider usage is billed to that account.
- Both descriptions list all 29 spoken target languages, lead with original-speaker voice and use the tested Bilibili walkthrough. Three screenshots, icon and small promotional tile were uploaded. Privacy disclosures and reviewer steps were saved.
- During this submission, Google warned that broad website permissions may require deeper review. The submitted permissions are unchanged; their media discovery and extension-authentication purpose is documented in `SUBMISSION.md`.

[GitHub v0.2.3 installation packages](https://github.com/lvyinchao/timbradub/releases/tag/v0.2.3) are public. The shared CI and an independent public-download check both passed actual download/extract/load and clean-source reproduction, including all nine offline browser gates. See the fixed [0.2.3 public-download receipt](https://github.com/lvyinchao/timbradub/releases/download/v0.2.3/public-download-verification.json). GitHub downloads are a separate distribution channel. Do not display a Chrome Web Store install badge or claim the item is available in the store until approval and an actual public listing are confirmed.

No review-completion date is promised. Check the developer console for the current verdict.

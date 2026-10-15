import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '听译 · Qwen Video Dub',
    description:
      '在原网页观看带有同步译音和双语字幕的视频。自用版，使用自己的百炼凭据。',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'activeTab',
      'tabs',
      'scripting',
      'webRequest',
      'declarativeNetRequestWithHostAccess',
      'offscreen',
      'sidePanel',
    ],
    // Chrome checks both the request URL and its initiator for modifyHeaders.
    // Narrow HTTP host grants failed for extension-initiated WebSockets in the
    // real browser gate. Rules themselves remain exact-origin / exact-endpoint.
    host_permissions: ['<all_urls>'],
    action: { default_title: '打开听译' },
    side_panel: { default_path: 'sidepanel.html' },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; worker-src 'self'; connect-src 'self' https: wss:; media-src 'self' blob:;",
    },
  },
  vite: () => ({ build: { sourcemap: false } }),
});

import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Qwen Video Dub',
    description:
      'Watch synchronized translated video in its original player or a buffered compatibility player. Use your own Model Studio account.',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'downloads',
      'activeTab',
      'tabCapture',
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
    action: { default_title: 'Open Qwen Video Dub' },
    side_panel: { default_path: 'sidepanel.html' },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; worker-src 'self'; connect-src 'self' https: wss:; media-src 'self' blob:;",
    },
  },
  vite: () => ({ build: { sourcemap: false } }),
});

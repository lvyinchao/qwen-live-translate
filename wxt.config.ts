import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    default_locale: 'en',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'downloads',
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
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
    homepage_url: 'https://github.com/lvyinchao/timbradub',
    action: {
      default_title: 'Open TimbraDub',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' },
    },
    side_panel: { default_path: 'sidepanel.html' },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; worker-src 'self'; connect-src 'self' https: wss:; media-src 'self' blob:;",
    },
  },
  vite: () => ({ build: { sourcemap: false } }),
});

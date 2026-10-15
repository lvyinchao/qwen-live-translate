import { parseTencentMedia, tencentInfoEndpoint } from '../lib/tencent-media';
import type { TencentMediaInfo } from '../lib/tencent-media';
import { observeTencentHls } from '../lib/tencent-hls';
export default defineContentScript({
  matches: ['https://v.qq.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const latest = new Map<string, TencentMediaInfo>();
    const publish = () => {
      for (const info of latest.values())
        if (location.pathname.endsWith(`/${info.videoId}.html`))
          window.postMessage(
            { type: 'qvd:tencent-media', media: info },
            location.origin,
          );
    };
    const inspect = (text: string) => {
      const info = parseTencentMedia(text, location.href);
      if (!info) return;
      latest.set(info.playerId ?? '', info);
      publish();
    };
    observeTencentHls((info) => {
      latest.set(info.playerId ?? '', info);
      // Bound retained episode/player metadata during single-page navigation.
      while (latest.size > 4) latest.delete(latest.keys().next().value!);
      publish();
    });
    window.addEventListener('message', (event) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.type === 'qvd:request-media'
      )
        publish();
    });
    const nativeFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const response = await Reflect.apply(nativeFetch, this, args);
      if (tencentInfoEndpoint(response.url)) {
        const copy = response.clone();
        void (async () => {
          const reader = copy.body?.getReader();
          if (!reader) return;
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          let size = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.length;
              if (size > 2 * 1024 ** 2) {
                await reader.cancel();
                return;
              }
              chunks.push(new Uint8Array(part.value));
            }
            inspect(await new Blob(chunks).text());
          } finally {
            reader.releaseLock();
          }
        })().catch(() => {});
      }
      return response;
    };
    const nativeOpen = XMLHttpRequest.prototype.open;
    // Keep the native overload semantics; observe only the returned media-info response.
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      ...args: any[]
    ) {
      const requested = new URL(String(args[1]), location.href).href;
      if (tencentInfoEndpoint(requested))
        this.addEventListener(
          'load',
          () => {
            try {
              if (this.status < 200 || this.status >= 300) return;
              if (this.responseType === 'json')
                inspect(JSON.stringify(this.response));
              else if (!this.responseType || this.responseType === 'text')
                inspect(this.responseText);
            } catch {
              /* Ignore responses outside the supported metadata shape. */
            }
          },
          { once: true },
        );
      return Reflect.apply(
        nativeOpen,
        this,
        args as Parameters<typeof nativeOpen>,
      );
    } as typeof nativeOpen;
  },
});

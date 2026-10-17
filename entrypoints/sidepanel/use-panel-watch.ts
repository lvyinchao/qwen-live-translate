import { useEffect, useRef } from 'react';

/** A port bounds passive observation to the tab that this visible panel watches. */
export function usePanelWatch() {
  const port = useRef<chrome.runtime.Port | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      port.current?.disconnect();
      port.current = null;
    };
  }, []);
  return (tab?: chrome.tabs.Tab) => {
    if (!mounted.current) return;
    if (tab?.id === undefined) {
      port.current?.disconnect();
      port.current = null;
      return;
    }
    if (!port.current) {
      const connected = chrome.runtime.connect({ name: 'timbradub-panel' });
      connected.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port.current === connected) port.current = null;
      });
      port.current = connected;
    }
    try {
      port.current.postMessage({ type: 'watch', tabId: tab.id, windowId: tab.windowId });
    } catch {
      port.current = null;
    }
  };
}

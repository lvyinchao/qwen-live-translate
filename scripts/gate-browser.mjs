import os from 'node:os';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const config = JSON.parse(
  await fs.readFile(path.join(os.homedir(), '.bailian/config.json'), 'utf8'),
);
const workspace = new URL(config.base_url).hostname.split('.')[0];
const executablePath = chromium.executablePath();
const extension = await fs.mkdtemp(path.resolve('work/extension-snapshot-'));
await fs.cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
console.log('Launching isolated extension browser');
const context = await chromium.launchPersistentContext(
  await fs.mkdtemp(path.resolve('work/provider-browser-')),
  {
    executablePath,
    headless: false,
    timeout: 25000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      '--autoplay-policy=no-user-gesture-required',
      '--no-proxy-server',
    ],
  },
);
const record = {
  at: new Date().toISOString(),
  scope:
    'Real isolated Chrome extension; local key kept in memory and browser-local storage only',
  model: 'qwen3.8-livetranslate-flash-realtime',
};
try {
  context.setDefaultTimeout(15000);
  const control = await context.browser().newBrowserCDPSession();
  await control.send('Extensions.loadUnpacked', { path: extension });
  console.log('Browser launched; waiting for extension service worker');
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error')
      console.log(
        'Browser error:',
        m.text().replaceAll(config.api_key, '[redacted]'),
      );
  });
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);
  await page.waitForTimeout(500);
  await page.evaluate(
    async (settings) => {
      await chrome.storage.local.set({ settings });
    },
    { apiKey: config.api_key, workspace, region: 'cn-beijing', language: 'zh' },
  );
  const auth = await page.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'background', type: 'auth:install' }),
  );
  if (!auth.ok) throw new Error(auth.error);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketHandshakeResponseReceived', (e) => {
    record.handshakeStatus = e.response.status;
  });
  cdp.on('Network.webSocketFrameError', (e) => {
    record.networkError = e.errorMessage;
  });
  const pcm = (
    await fs.readFile(process.env.PROBE_PCM ?? 'tests/fixtures/probe.pcm')
  ).toString('base64');
  record.result = await page.evaluate(
    async ({ url, pcm }) => {
      return await new Promise((resolve) => {
        const socket = new WebSocket(url),
          events = [],
          counts = {};
        let bytes = 0,
          text = '',
          done = false;
        const finish = (result) => {
          if (done) return;
          done = true;
          socket.close();
          resolve({ ...result, bytes, text, counts, events });
        };
        const timer = setTimeout(
          () => finish({ ok: false, error: 'timeout' }),
          45000,
        );
        socket.onerror = () => {
          clearTimeout(timer);
          finish({ ok: false, error: 'websocket handshake failed' });
        };
        socket.onclose = () => {
          if (!done) {
            clearTimeout(timer);
            finish({ ok: false, error: 'closed before session.finished' });
          }
        };
        socket.onmessage = async (e) => {
          const data = JSON.parse(e.data);
          counts[data.type] = (counts[data.type] ?? 0) + 1;
          if (data.type === 'response.audio.delta')
            bytes += atob(data.delta).length;
          else if (data.type === 'response.audio_transcript.delta')
            text += data.delta;
          if (
            ![
              'response.audio.delta',
              'response.audio_transcript.delta',
              'conversation.item.input_audio_transcription.delta',
            ].includes(data.type)
          )
            events.push(data);
          else if (data.type === 'response.audio.delta')
            events.push({ ...data, delta: data.delta });
          else events.push(data);
          if (data.type === 'error') {
            clearTimeout(timer);
            finish({
              ok: false,
              errorCode: data.error?.code,
              error: data.error?.message,
            });
          }
          if (data.type === 'session.created')
            socket.send(
              JSON.stringify({
                type: 'session.update',
                session: {
                  output_modalities: ['text', 'audio'],
                  translation: { language: 'zh' },
                  enable_voice_clone: false,
                },
              }),
            );
          if (data.type === 'session.updated') {
            const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
            for (let i = 0; i < bytes.length && !done; i += 3200) {
              let s = '';
              for (const b of bytes.subarray(i, i + 3200))
                s += String.fromCharCode(b);
              socket.send(
                JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: btoa(s),
                }),
              );
              await new Promise((r) => setTimeout(r, 100));
            }
            if (!done) socket.send(JSON.stringify({ type: 'session.finish' }));
          }
          if (data.type === 'session.finished') {
            clearTimeout(timer);
            finish({ ok: true });
          }
        };
      });
    },
    { url: auth.value, pcm },
  );
  const events = record.result.events;
  delete record.result.events;
  await fs.writeFile('work/provider-real-events.json', JSON.stringify(events));
  record.authRulesRemoved = await page.evaluate(async () => {
    await chrome.runtime.sendMessage({
      target: 'background',
      type: 'auth:remove',
    });
    return !(await chrome.declarativeNetRequest.getSessionRules()).some(
      (r) => r.id === 910001,
    );
  });
} catch (error) {
  record.error = String(error.message).replace(/sk-[\w-]+/g, '[redacted]');
} finally {
  await context.close();
}
await fs.writeFile('work/gate-provider.json', JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));

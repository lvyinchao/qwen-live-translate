import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/types';
import { mediaIdentity } from '../lib/adapters';

type Listener = (...args: any[]) => any;
const event = () => {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: vi.fn((listener: Listener) => {
      listeners.push(listener);
    }),
    removeListener: vi.fn((listener: Listener) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    }),
  };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const page = 'https://www.bilibili.com/video/BVfixture/';
const identity = mediaIdentity(page);
const sender = {
  id: 'fixture-extension',
  url: 'chrome-extension://fixture-extension/sidepanel.html',
};
let env: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const sessionData: Record<string, unknown> = {};
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'isolated-fixture-key', workspace: 'fixture' };
  const playerMessages: any[] = [],
    engineMessages: any[] = [];
  let offscreen = false;
  const muted = new Map<number, boolean>();
  const hooks: {
    create?: () => Promise<void>;
    engineStart?: (message: any) => Promise<any>;
    probe?: () => Promise<any>;
  } = {};
  const runtimeMessage = event(),
    runtimeConnect = event();
  const onBeforeRequest = event(),
    onBeforeSendHeaders = event(),
    onResponseStarted = event(),
    onErrorOccurred = event();
  const browser = {
    runtime: {
      id: sender.id,
      getURL: (path: string) => `chrome-extension://${sender.id}/${path}`,
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: vi.fn(async () => (offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [])),
      onMessage: runtimeMessage,
      onConnect: runtimeConnect,
      sendMessage: vi.fn(async (message: any) => {
        if (message.target !== 'offscreen') return undefined;
        engineMessages.push(message);
        if (message.type === 'engine:start') return hooks.engineStart?.(message) ?? { ok: true };
        if (message.type === 'engine:probe')
          return hooks.probe?.() ?? { ok: true, value: { translated: true } };
        return { ok: true, value: true };
      }),
    },
    offscreen: {
      Reason: { BLOBS: 'BLOBS', WORKERS: 'WORKERS' },
      createDocument: vi.fn(async () => {
        await hooks.create?.();
        offscreen = true;
      }),
    },
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async () => ({ settings })),
        set: vi.fn(async (_items: Record<string, unknown>) => {}),
      },
      session: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null) return { ...sessionData };
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [key, sessionData[key]]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionData, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionData[key];
        }),
      },
      onChanged: event(),
    },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    action: { setTitle: vi.fn(async () => {}) },
    declarativeNetRequest: {
      getSessionRules: vi.fn(async () => []),
      updateSessionRules: vi.fn(async () => {}),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: page })),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async (tabId: number, message: any) => {
        playerMessages.push({ tabId, ...message });
        if (message.type === 'player:attach') {
          muted.set(tabId, true);
          return { ok: true, rate: 1, position: 12 };
        }
        if (message.type === 'player:stop') muted.set(tabId, false);
        return { ok: true };
      }),
      onRemoved: event(),
      onUpdated: event(),
      onActivated: event(),
    },
    scripting: {
      executeScript: vi.fn(async (options: any) =>
        options.world === 'MAIN'
          ? [
              {
                frameId: 0,
                result: {
                  identity,
                  site: 'bilibili',
                  title: 'Isolated fixture',
                  ad: false,
                  source: {
                    url: 'https://cdn.bilivideo.com/main.m4a',
                    mime: 'audio/mp4',
                    identity,
                  },
                },
              },
            ]
          : [
              {
                frameId: 0,
                result: [
                  {
                    id: 'player',
                    url: 'blob:' + page,
                    frameUrl: page,
                    duration: 100,
                    currentTime: 12,
                    width: 640,
                    height: 360,
                    paused: false,
                    displayed: true,
                    protected: false,
                  },
                ],
              },
            ],
      ),
    },
    webRequest: { onBeforeRequest, onBeforeSendHeaders, onResponseStarted, onErrorOccurred },
    downloads: { onChanged: event() },
  };
  vi.stubGlobal('chrome', browser);
  vi.stubGlobal('defineBackground', (main: () => void) => main);
  const module = await import('../entrypoints/background');
  (module.default as unknown as () => void)();
  const call = (message: any, source: any = sender): Promise<any> =>
    new Promise((resolve, reject) => {
      const listener = runtimeMessage.listeners[0]!;
      if (listener(message, source, resolve) !== true)
        reject(new Error('Background did not accept message'));
    });
  // Await real initialization through the registered message handler.
  await call({ type: 'session:get' });
  return { browser, hooks, call, sessionData, playerMessages, engineMessages, muted };
}
beforeEach(async () => {
  vi.resetModules();
  env = await setup();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const start = (tabId = 1) =>
  env.call({
    type: 'session:start',
    candidate: { id: 'player', frameId: 0, tabId },
    language: 'zh',
  });

it('waits for an offscreen creation already in progress even when Chrome exposes its context', async () => {
  const creation = deferred<void>();
  env.hooks.create = () => creation.promise;
  const first = env.call({ type: 'files:status' });
  await vi.waitFor(() => expect(env.browser.offscreen.createDocument).toHaveBeenCalledOnce());
  const observed = deferred<void>();
  env.browser.runtime.getContexts.mockImplementationOnce(async () => {
    observed.resolve();
    return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
  });
  const second = env.call({ type: 'files:status' });
  await observed.promise;
  // Drain the real handler's await chain without completing document loading.
  await new Promise((resolve) => setImmediate(resolve));
  expect(env.engineMessages).toEqual([]);
  creation.resolve();
  expect(await first).toEqual({ ok: true, value: true });
  expect(await second).toEqual({ ok: true, value: true });
  expect(env.browser.offscreen.createDocument).toHaveBeenCalledOnce();
  expect(env.engineMessages.map((message) => message.type)).toEqual([
    'files:status',
    'files:status',
  ]);
});

it('rolls back player attachment and active session when offscreen creation fails', async () => {
  env.hooks.create = async () => {
    throw new Error('createDocument rejected');
  };
  expect(await start()).toMatchObject({ ok: false, error: 'createDocument rejected' });
  expect(env.playerMessages.map((message) => message.type)).toEqual([
    'player:attach',
    'player:stop',
  ]);
  expect(env.muted.get(1)).toBe(false);
  expect(await env.call({ type: 'session:get' })).toEqual({ ok: true, value: null });
  expect(env.sessionData.activeSession).toBeUndefined();
});
it('rolls back the native player and engine after engine:start rejects', async () => {
  env.hooks.engineStart = async () => {
    throw new Error('engine rejected');
  };
  expect(await start()).toMatchObject({ ok: false, error: 'engine rejected' });
  expect(env.muted.get(1)).toBe(false);
  expect(env.playerMessages.at(-1)).toMatchObject({ type: 'player:stop', tabId: 1 });
  expect(env.engineMessages.at(-1)).toMatchObject({ type: 'engine:stop' });
  expect(await env.call({ type: 'session:get' })).toEqual({ ok: true, value: null });
});
it('does not let an old rejected start or queued stop detach the newer session', async () => {
  const gate = deferred<any>();
  let first = true;
  env.hooks.engineStart = async () => {
    if (first) {
      first = false;
      return gate.promise;
    }
    return { ok: true };
  };
  const old = start(1);
  await vi.waitFor(() =>
    expect(env.engineMessages.some((message) => message.type === 'engine:start')).toBe(true),
  );
  const stopped = env.call({ type: 'session:stop' });
  const latest = start(2);
  gate.reject(new Error('old engine failed'));
  expect(await old).toMatchObject({ ok: false });
  await stopped;
  const result = await latest;
  expect(result.ok).toBe(true);
  expect(result.value.candidate.tabId).toBe(2);
  expect(env.muted.get(1)).toBe(false);
  expect(env.muted.get(2)).toBe(true);
  expect(
    env.playerMessages
      .filter((message) => message.type === 'player:stop')
      .every((message) => message.tabId === 1),
  ).toBe(true);
  expect((await env.call({ type: 'session:get' })).value.id).toBe(result.value.id);
});
it('serializes a credential probe with a new start and rejects probing an active translation', async () => {
  const probe = deferred<any>();
  env.hooks.probe = () => probe.promise;
  const checking = env.call({ type: 'settings:test' });
  await vi.waitFor(() =>
    expect(env.engineMessages.some((message) => message.type === 'engine:probe')).toBe(true),
  );
  const translating = start();
  await Promise.resolve();
  expect(env.playerMessages).toHaveLength(0);
  probe.resolve({ ok: true, value: { translated: true } });
  expect((await checking).ok).toBe(true);
  expect((await translating).ok).toBe(true);
  expect(await env.call({ type: 'settings:test' })).toMatchObject({
    ok: false,
    error: '请先停止翻译再测试连接',
  });
  expect(env.engineMessages.filter((message) => message.type === 'engine:probe')).toHaveLength(1);
});
it('ignores media requests from tabs without a panel or translation lease before tabs.get', async () => {
  const before = env.browser.tabs.get.mock.calls.length;
  const request = {
    tabId: 9,
    requestId: 'unwatched',
    url: 'https://cdn.bilivideo.com/audio.m4a',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'audio/mp4' }],
  };
  env.browser.webRequest.onBeforeRequest.listeners[0]!(request);
  env.browser.webRequest.onBeforeSendHeaders.listeners[0]!(request);
  env.browser.webRequest.onResponseStarted.listeners[0]!(request);
  await Promise.resolve();
  expect(env.browser.tabs.get.mock.calls.length).toBe(before);
  expect((await env.call({ type: 'media:diagnostics' })).value.sources).toEqual([]);
});
it('does not reuse an expired signed media source on a fresh discovery', async () => {
  env.sessionData['source:1'] = {
    identity,
    expiresAt: Date.now() - 1,
    source: {
      identity,
      url: 'https://cdn.bilivideo.com/expired.m4a?signature=old',
      mime: 'audio/mp4',
    },
  };
  const found = await env.call({ type: 'media:discover', tabId: 1 });
  expect(found.ok).toBe(true);
  expect(found.value[0].source.url).toBe('https://cdn.bilivideo.com/main.m4a');
  expect(env.sessionData['source:1']).toBeUndefined();
});
it('expires an observed in-memory media source before returning a later discovery', async () => {
  expect((await env.call({ type: 'media:discover', tabId: 1 })).ok).toBe(true);
  const request = {
    tabId: 1,
    frameId: 0,
    requestId: 'watched',
    method: 'GET',
    url: 'https://cdn.bilivideo.com/observed.m4a?signature=temporary',
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'audio/mp4' }],
  };
  env.browser.webRequest.onBeforeRequest.listeners[0]!(request);
  env.browser.webRequest.onBeforeSendHeaders.listeners[0]!(request);
  env.browser.webRequest.onResponseStarted.listeners[0]!(request);
  await vi.waitFor(() => expect(env.sessionData['source:1']).toBeDefined());
  expect((await env.call({ type: 'media:discover', tabId: 1 })).value[0].source.url).toBe(
    request.url,
  );
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
  try {
    const after = await env.call({ type: 'media:discover', tabId: 1 });
    expect(after.ok).toBe(true);
    expect(after.value[0].source.url).toBe('https://cdn.bilivideo.com/main.m4a');
    expect(env.sessionData['source:1']).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
it('restores the native player when engine startup returns an explicit error result', async () => {
  env.hooks.engineStart = async () => ({ ok: false, error: 'engine declined startup' });
  expect(await start()).toMatchObject({ ok: false, error: 'engine declined startup' });
  expect(env.muted.get(1)).toBe(false);
  expect((await env.call({ type: 'session:get' })).value).toBeNull();
});

function deferredSettingsRead() {
  let persisted = { ...DEFAULT_SETTINGS, apiKey: 'isolated-old-key', workspace: 'old-workspace' };
  let reads = 0;
  const blocked = deferred<void>();
  env.browser.storage.local.get.mockImplementation(async () => {
    const snapshot = structuredClone(persisted);
    if (++reads === 1) await blocked.promise;
    return { settings: snapshot };
  });
  env.browser.storage.local.set.mockImplementation(async (items: any) => {
    persisted = structuredClone(items.settings);
  });
  return { blocked, persisted: () => persisted, reading: () => reads };
}

it.each(['ui:set', 'files:set-enabled'])(
  'serializes a pending %s before forgetting credentials',
  async (type) => {
    const store = deferredSettingsRead();
    const preference = env.call({ type, language: 'zh', enabled: true });
    await vi.waitFor(() => expect(store.reading()).toBe(1));
    const forgetting = env.call({ type: 'settings:forget' });
    // A second panel can remove credentials while this panel's read is pending.
    for (let step = 0; step < 20; step++) await Promise.resolve();
    expect(store.reading()).toBe(1);
    store.blocked.resolve();
    expect((await preference).ok).toBe(true);
    expect((await forgetting).ok).toBe(true);
    expect(store.persisted().apiKey).toBe('');
    expect(store.persisted().workspace).toBe('');
  },
);

it.each(['ui:set', 'files:set-enabled'])(
  'reads fresh settings for %s queued after credential removal',
  async (type) => {
    const store = deferredSettingsRead();
    const forgetting = env.call({ type: 'settings:forget' });
    await vi.waitFor(() => expect(store.reading()).toBe(1));
    const preference = env.call({ type, language: 'zh', enabled: true });
    for (let step = 0; step < 20; step++) await Promise.resolve();
    expect(store.reading()).toBe(1);
    store.blocked.resolve();
    expect((await forgetting).ok).toBe(true);
    expect((await preference).ok).toBe(true);
    expect(store.persisted().apiKey).toBe('');
    expect(store.persisted().workspace).toBe('');
    if (type === 'ui:set') expect(store.persisted().uiLanguage).toBe('zh');
    else expect(store.persisted().autoSaveFiles).toBe(true);
  },
);

it.each(['ui:set', 'files:set-enabled'])(
  'cannot let a stale %s overwrite replacement API credentials and region',
  async (type) => {
    const store = deferredSettingsRead();
    const preference = env.call({ type, language: 'zh', enabled: true });
    await vi.waitFor(() => expect(store.reading()).toBe(1));
    const replacement = env.call({
      type: 'settings:save',
      settings: {
        apiKey: 'isolated-new-key',
        workspace: 'new-workspace',
        region: 'ap-southeast-1',
      },
    });
    for (let step = 0; step < 20; step++) await Promise.resolve();
    expect(store.reading()).toBe(1);
    store.blocked.resolve();
    expect((await preference).ok).toBe(true);
    expect((await replacement).ok).toBe(true);
    expect(store.persisted()).toMatchObject({
      apiKey: 'isolated-new-key',
      workspace: 'new-workspace',
      region: 'ap-southeast-1',
    });
  },
);

function youtubeDiscovery(initial = 'fr') {
  const url = 'https://www.youtube.com/watch?v=fixture';
  const pageId = mediaIdentity(url);
  let current = initial;
  env.browser.tabs.get.mockImplementation(async (id) => ({ id, url }));
  env.browser.scripting.executeScript.mockImplementation(async (options: any): Promise<any> => {
    const source = {
      url: `https://cdn.googlevideo.com/videoplayback?track=${current}`,
      mime: 'audio/mp4',
      identity: pageId,
      trackId: current,
    };
    return options.world === 'MAIN'
      ? [
          {
            frameId: 0,
            result: {
              identity: pageId,
              site: 'youtube',
              title: 'Track fixture',
              ad: false,
              currentAudioTrackId: current,
              source,
              audioSources: [source],
            },
          },
        ]
      : [
          {
            frameId: 0,
            result: [
              {
                id: 'player',
                url: 'blob:' + url,
                frameUrl: url,
                duration: 100,
                currentTime: 12,
                width: 640,
                height: 360,
                displayWidth: 640,
                displayHeight: 360,
                paused: false,
                displayed: true,
                protected: false,
                youtubeMain: true,
                index: 0,
              },
            ],
          },
        ];
  });
  return {
    pageId,
    select: (track: string) => {
      current = track;
    },
  };
}
it.each(['default', 'en-original'])(
  'rejects a saved %s YouTube direct source that would override the newly selected track',
  async (oldTrack) => {
    const f = youtubeDiscovery();
    env.sessionData['source:1'] = {
      identity: f.pageId,
      expiresAt: Date.now() + 60000,
      source: {
        identity: f.pageId,
        url: 'https://cdn.googlevideo.com/videoplayback?track=old',
        mime: 'audio/mp4',
        trackId: oldTrack,
      },
    };
    const found = await env.call({ type: 'media:discover', tabId: 1 });
    expect(found.ok).toBe(true);
    expect(found.value[0].source.trackId).toBe('fr');
    expect(found.value[0].source.url).toContain('track=fr');
  },
);
it('stops the old translation when native YouTube audio changes even without a new network response', async () => {
  const f = youtubeDiscovery('en-original');
  expect((await start()).ok).toBe(true);
  f.select('fr');
  const discovered = await env.call({ type: 'media:discover', tabId: 1 });
  expect(discovered.value[0].source.trackId).toBe('fr');
  expect((await env.call({ type: 'session:get' })).value).toBeNull();
  expect(env.playerMessages.at(-1)).toMatchObject({ type: 'player:stop', tabId: 1 });
});
it('does not revive a legacy observed track when current direct metadata is ambiguous', async () => {
  const f = youtubeDiscovery();
  const execute = env.browser.scripting.executeScript.getMockImplementation()!;
  env.browser.scripting.executeScript.mockImplementation(async (options: any): Promise<any> => {
    const result = await execute(options);
    if (options.world === 'MAIN')
      result[0]!.result = {
        identity: f.pageId,
        site: 'youtube',
        title: 'Ambiguous',
        ad: false,
        audioSources: [],
        sourceReason: '当前音轨无法确认',
      } as any;
    return result;
  });
  env.sessionData['source:1'] = {
    identity: f.pageId,
    expiresAt: Date.now() + 60000,
    source: {
      identity: f.pageId,
      url: 'https://cdn.googlevideo.com/videoplayback?track=old',
      mime: 'audio/mp4',
      trackId: 'default',
    },
  };
  const found = await env.call({ type: 'media:discover', tabId: 1 });
  expect(found.ok).toBe(true);
  expect(found.value[0].source).toBeUndefined();
  expect(found.value[0].sourceReason).toBe('当前音轨无法确认');
  expect(found.value[0].sourceStatus).toBe('unsupported');
});

it('delivers the captured owner terminal response before stopping its offscreen engine', async () => {
  const started = await start();
  const owner = started.value;
  const send = env.browser.tabs.sendMessage.getMockImplementation()!;
  env.browser.tabs.sendMessage.mockImplementation(async (tabId: number, message: any) => {
    const response = await send(tabId, message);
    if (message.type !== 'player:stop') return response;
    return {
      ok: true,
      terminals: [
        {
          type: 'player:metric',
          kind: 'terminal',
          sessionId: owner.id,
          epoch: owner.epoch,
          languageVersion: owner.languageVersion ?? 0,
          segmentId: 'utterance',
          reason: 'stop',
          audioTime: 0.74,
          remaining: 0.06,
          sourceTime: 12,
        },
        { type: 'player:metric', kind: 'terminal', sessionId: 'another-task', epoch: owner.epoch },
      ],
    };
  });
  await env.call({ type: 'session:stop' });
  const messages = env.engineMessages.filter((message) =>
    ['engine:terminals', 'engine:stop'].includes(message.type),
  );
  expect(messages.map((message) => message.type)).toEqual(['engine:terminals', 'engine:stop']);
  expect(messages[0].sessionId).toBe(owner.id);
  expect(messages[0].events).toHaveLength(1);
  expect(messages[0].events[0]).toMatchObject({ reason: 'stop', sessionId: owner.id });
});

it('still stops playback when terminal diagnostic forwarding fails', async () => {
  const owner = (await start()).value;
  const sendPlayer = env.browser.tabs.sendMessage.getMockImplementation()!;
  env.browser.tabs.sendMessage.mockImplementation(async (tabId: number, message: any) => {
    const response = await sendPlayer(tabId, message);
    return message.type === 'player:stop'
      ? {
          ok: true,
          terminals: [
            {
              type: 'player:metric',
              kind: 'terminal',
              sessionId: owner.id,
              epoch: owner.epoch,
              languageVersion: owner.languageVersion ?? 0,
              segmentId: 'utterance',
              reason: 'stop',
              audioTime: 0.74,
              remaining: 0.06,
              sourceTime: 12,
            },
          ],
        }
      : response;
  });
  const sendEngine = env.browser.runtime.sendMessage.getMockImplementation()!;
  env.browser.runtime.sendMessage.mockImplementation(async (message: any) => {
    if (message.type === 'engine:terminals') throw new Error('diagnostic transport unavailable');
    return sendEngine(message);
  });
  expect(await env.call({ type: 'session:stop' })).toEqual({ ok: true, value: true });
  expect(env.engineMessages.at(-1)).toMatchObject({ type: 'engine:stop', sessionId: owner.id });
  expect((await env.call({ type: 'session:get' })).value).toBeNull();
});

it('keeps independent caption choices through engine progress and rejects stale-language controls', async () => {
  const owner = (await start()).value;
  await env.call({
    type: 'session:mix',
    sessionId: owner.id,
    languageVersion: 0,
    sourceSubtitles: true,
    targetSubtitles: false,
  });
  expect((await env.call({ type: 'session:get' })).value).toMatchObject({
    sourceSubtitles: true,
    targetSubtitles: false,
    subtitles: true,
  });
  await env.call({
    type: 'engine:state',
    session: { ...owner, epoch: owner.epoch + 1, sourceSubtitles: false, targetSubtitles: true },
  });
  expect((await env.call({ type: 'session:get' })).value).toMatchObject({
    sourceSubtitles: true,
    targetSubtitles: false,
  });
  expect(
    await env.call({
      type: 'session:mix',
      sessionId: owner.id,
      languageVersion: 99,
      sourceSubtitles: false,
      targetSubtitles: true,
    }),
  ).toMatchObject({ ok: true, value: false });
  expect((await env.call({ type: 'session:get' })).value).toMatchObject({
    sourceSubtitles: true,
    targetSubtitles: false,
  });
  await env.call({ type: 'session:mix', sessionId: owner.id, subtitles: false });
  expect((await env.call({ type: 'session:get' })).value).toMatchObject({
    sourceSubtitles: false,
    targetSubtitles: false,
    subtitles: false,
  });
});

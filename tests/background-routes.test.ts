import { expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors';
import type { BackgroundContext } from '../lib/background/context';
import { fileRoutes, validDownload } from '../lib/background/handlers/files';
import { mediaRoutes } from '../lib/background/handlers/media';
import { sessionRoutes } from '../lib/background/handlers/session';
import { settingsRoutes } from '../lib/background/handlers/settings';
import { dispatch, type Routes } from '../lib/background/router';
import type { BackgroundMessage } from '../lib/messages';

const routes = { ...fileRoutes, ...settingsRoutes, ...mediaRoutes, ...sessionRoutes } as Routes;
const page = { id: 'other', url: 'https://example.com/' } as chrome.runtime.MessageSender;
const untrusted = { trusted: () => false } as unknown as BackgroundContext;
const send = (type: string) => dispatch(routes, untrusted, { type } as BackgroundMessage, page);

it('rejects every privileged route for web-page senders before running its handler', async () => {
  const privileged = Object.entries(routes).filter(
    ([, route]) => typeof route.privileged === 'string',
  );
  expect(privileged.length).toBeGreaterThan(20);
  for (const [type, route] of privileged) {
    const handle = vi.spyOn(route, 'handle');
    const rejection = await send(type).catch((error: unknown) => error);
    expect(rejection, type).toBeInstanceOf(AppError);
    expect((rejection as AppError).code).toBe('forbidden');
    expect((rejection as AppError).message).toBe(route.privileged);
    expect(handle).not.toHaveBeenCalled();
  }
});

it('answers quiet-fallback routes for web-page senders without running them', async () => {
  expect(await send('session:get')).toBeNull();
  expect(await send('session:mix')).toBe(false);
  expect(await send('engine:state')).toBe(false);
  expect(await send('engine:segment')).toBe(false);
});

it('ignores unknown and inherited message types', async () => {
  expect(await send('no:such-route')).toBeUndefined();
  expect(await send('toString')).toBeUndefined();
  expect(await send('__proto__')).toBeUndefined();
});

it('accepts only extension-owned zip downloads inside the TimbraDub folder', () => {
  const root = 'chrome-extension://abc/';
  const blob = `blob:${root}1234`;
  expect(validDownload(blob, 'TimbraDub/video/merged.zip', root)).toBe(true);
  for (const [url, filename] of [
    ['blob:https://example.com/1234', 'TimbraDub/a.zip'],
    [blob, 'Other/a.zip'],
    [blob, 'TimbraDub/a.exe'],
    [blob, 'TimbraDub/../a.zip'],
    [blob, 'TimbraDub//a.zip'],
    [blob, 'TimbraDub/a\\b.zip'],
    [blob, 'TimbraDub/a\nb.zip'],
  ])
    expect(validDownload(url!, filename!, root), filename).toBe(false);
});

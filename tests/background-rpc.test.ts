import { expect, it, vi } from 'vitest';
import { createBackgroundRpc } from '../lib/background-rpc';
const interrupted = () => new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received');

it.each(['settings:get', 'media:refresh', 'media:headers', 'auth:install', 'auth:remove', 'engine:state', 'engine:segment'])(
  'recovers an interrupted MV3 response for idempotent %s without weakening its payload', async (type) => {
    const send = vi.fn().mockRejectedValueOnce(interrupted()).mockResolvedValue({ ok: true, value: true });
    const sleep = vi.fn(async () => {});
    const rpc = createBackgroundRpc(send, sleep);
    expect(await rpc(type, { sessionId: 'active', epoch: 4, languageVersion: 2 })).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);
    expect(sleep.mock.calls).toEqual([[100]]);
  },
);
it('caps interruption recovery at three short retries', async () => {
  const error = interrupted();
  const send = vi.fn().mockRejectedValue(error);
  const sleep = vi.fn(async () => {});
  await expect(createBackgroundRpc(send, sleep)('auth:remove')).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(4);
  expect(sleep.mock.calls).toEqual([[100], [300], [800]]);
});
it('never duplicates a download whose acknowledgement was lost', async () => {
  const send = vi.fn().mockRejectedValue(interrupted());
  const sleep = vi.fn(async () => {});
  await expect(createBackgroundRpc(send, sleep)('files:download', { filename: 'output.zip' })).rejects.toThrow('message channel closed');
  expect(send).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});
it('does not retry an application rejection, even when its text resembles a transport failure', async () => {
  const send = vi.fn().mockResolvedValue({ ok: false, error: interrupted().message });
  const sleep = vi.fn(async () => {});
  await expect(createBackgroundRpc(send, sleep)('engine:segment')).rejects.toThrow('message channel closed');
  expect(send).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});
it('does not retry stale-epoch or invalid-credential application failures', async () => {
  for (const error of ['翻译任务已过期', '请填写有效的百炼 API Key']) {
    const send = vi.fn().mockResolvedValue({ ok: false, error });
    const sleep = vi.fn(async () => {});
    await expect(createBackgroundRpc(send, sleep)('auth:install')).rejects.toThrow(error);
    expect(send).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  }
});
it('fails immediately for unrelated exceptions and malformed successful transports', async () => {
  const send = vi.fn().mockRejectedValue(new Error('unexpected decoder error'));
  await expect(createBackgroundRpc(send)('media:headers')).rejects.toThrow('unexpected decoder error');
  expect(send).toHaveBeenCalledOnce();
  const empty = vi.fn().mockResolvedValue(undefined);
  await expect(createBackgroundRpc(empty)('engine:state')).rejects.toThrow('未返回有效响应');
  expect(empty).toHaveBeenCalledOnce();
});

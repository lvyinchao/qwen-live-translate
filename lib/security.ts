import { MODEL, type Settings } from './types';
export const AUTH_RULE = 910001;
export function endpoint(settings: Settings): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(settings.workspace))
    throw new Error('请填写有效的百炼 Workspace ID');
  if (!['cn-beijing', 'ap-southeast-1'].includes(settings.region))
    throw new Error('请选择北京或新加坡地域');
  return `wss://${settings.workspace}.${settings.region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${MODEL}`;
}
export function authRule(
  settings: Settings,
  extensionId: string,
): chrome.declarativeNetRequest.Rule {
  if (!settings.apiKey || /[\r\n]/.test(settings.apiKey))
    throw new Error('请填写有效的百炼 API Key');
  const url = endpoint(settings);
  return {
    id: AUTH_RULE,
    priority: 100,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'Authorization',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: `Bearer ${settings.apiKey}`,
        },
      ],
    },
    condition: {
      regexFilter: `^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      initiatorDomains: [extensionId],
      resourceTypes: ['websocket' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}
export function safeMediaUrl(value: string, otherPublicHosts = false): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (otherPublicHosts)
      return (
        host.includes('.') &&
        !/^[\d.]+$/.test(host) &&
        !host.includes(':') &&
        !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)
      );
    return [
      'googlevideo.com',
      'bilivideo.com',
      'bilivideo.cn',
      'akamaized.net',
      'youtube.com',
      'bilibili.com',
    ].some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
export function publicSettings(settings: Settings) {
  const { apiKey: _, ...rest } = settings;
  return { ...rest, hasKey: Boolean(settings.apiKey) };
}

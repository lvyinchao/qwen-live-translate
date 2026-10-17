import { MODEL, type Settings } from './types';
/** Session DNR rule ids owned by this extension: the model auth rule plus one
 * Referer/Origin rule per media host, allocated upward from MEDIA_RULE_BASE. */
export const RULE_ID_MIN = 910000;
export const AUTH_RULE = 910001;
export const MEDIA_RULE_BASE = 920000;
export const RULE_ID_MAX = 930000;
export const isOwnedRule = (id: number) => id >= RULE_ID_MIN && id < RULE_ID_MAX;
export const isMediaRule = (id: number) => id >= MEDIA_RULE_BASE && id < RULE_ID_MAX;
/** CDN domains whose subdomains share one media header rule. */
export const MEDIA_CDN_DOMAINS = [
  'googlevideo.com',
  'bilivideo.com',
  'bilivideo.cn',
  'akamaized.net',
] as const;
const NATIVE_MEDIA_DOMAINS = [...MEDIA_CDN_DOMAINS, 'youtube.com', 'bilibili.com'];
export const matchesDomain = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
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
    return NATIVE_MEDIA_DOMAINS.some((d) => matchesDomain(host, d));
  } catch {
    return false;
  }
}
export function publicSettings(settings: Settings) {
  const { apiKey: _, ...rest } = settings;
  return { ...rest, hasKey: Boolean(settings.apiKey) };
}

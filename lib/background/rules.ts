import {
  AUTH_RULE,
  MEDIA_CDN_DOMAINS,
  MEDIA_RULE_BASE,
  authRule,
  isMediaRule,
  isOwnedRule,
  matchesDomain,
} from '../security';
import type { AudioSource, Settings } from '../types';

/** Session DNR rules: model authentication and per-host media Referer/Origin. */
export class SessionRules {
  private nextMediaRule = MEDIA_RULE_BASE;
  private media = new Map<string, number>();

  /** Re-adopt media rules left by a worker that stopped mid-task. */
  async restore() {
    for (const rule of await chrome.declarativeNetRequest.getSessionRules()) {
      const domain = rule.condition.requestDomains?.[0];
      if (isMediaRule(rule.id) && domain) {
        this.media.set(domain, rule.id);
        this.nextMediaRule = Math.max(this.nextMediaRule, rule.id);
      }
    }
  }
  async clear() {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ids = existing.filter((r) => isOwnedRule(r.id)).map((r) => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    this.media.clear();
  }
  installAuth(settings: Settings) {
    return chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [AUTH_RULE],
      addRules: [authRule(settings, chrome.runtime.id)],
    });
  }
  removeAuth() {
    return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [AUTH_RULE] });
  }
  /** Only Referer/Origin are forwarded, and only on the extension's own XHRs. */
  async setMediaHeaders(source: AudioSource) {
    const exactHost = new URL(source.url).hostname;
    const host = MEDIA_CDN_DOMAINS.find((d) => matchesDomain(exactHost, d)) ?? exactHost;
    const id = this.media.get(host) ?? ++this.nextMediaRule;
    this.media.set(host, id);
    const headers = Object.entries(source.headers ?? {})
      .filter(([name]) => ['origin', 'referer'].includes(name.toLowerCase()))
      .map(([header, value]) => ({
        header,
        operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
        value,
      }));
    if (!headers.length) return;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 10,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: headers,
          },
          condition: {
            initiatorDomains: [chrome.runtime.id],
            requestDomains: [host],
            resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
          },
        },
      ],
    });
  }
}

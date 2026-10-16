/** Short, renewable leases bound to the panel's selected tabs. No global browsing
 * observation is enabled merely because the extension is installed. */
export class ObservationScope {
  private leases = new Map<number, number>();
  private revisions = new Map<number, number>();
  revision(tabId: number) { return this.revisions.get(tabId) ?? 0; }
  invalidate(tabId: number) { this.revisions.set(tabId, this.revision(tabId) + 1); }
  constructor(private now = () => Date.now(), private ttl = 15000) {}
  watch(tabId: number) {
    if (Number.isInteger(tabId) && tabId >= 0) {
      const expiry = this.leases.get(tabId);
      if (expiry !== undefined && expiry <= this.now()) this.invalidate(tabId);
      this.leases.set(tabId, this.now() + this.ttl);
    }
  }
  allows(tabId: number, activeSessionTab?: number): boolean {
    if (tabId === activeSessionTab) return true;
    const expiry = this.leases.get(tabId) ?? 0;
    if (expiry > this.now()) return true;
    if (this.leases.delete(tabId)) this.invalidate(tabId);
    return false;
  }
  release(tabId: number) { this.leases.delete(tabId); this.invalidate(tabId); }
  expired(): number[] {
    const ids = [...this.leases].filter(([, expiry]) => expiry <= this.now()).map(([id]) => id);
    for (const id of ids) this.release(id);
    return ids;
  }
}

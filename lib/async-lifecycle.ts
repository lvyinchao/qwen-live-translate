/** Serialize player-owning transitions. Invalidation is synchronous so a stop or
 * newer start can cancel an operation awaiting browser APIs before it attaches. */
export class SessionTransitions {
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  invalidate() {
    return ++this.revision;
  }
  current(revision: number) {
    return revision === this.revision;
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
}

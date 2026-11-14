/**
 * Keeps only the answer to the most recent request.
 * Route planning is asynchronous; when the plan is edited quickly, an answer to
 * an earlier edit can arrive after a later one was asked for and must be dropped.
 */
export class LatestOnly {
  private current = 0

  /** Starts a new request and returns its ticket. Every earlier ticket becomes stale. */
  next(): number {
    return ++this.current
  }

  isCurrent(ticket: number): boolean {
    return ticket === this.current
  }

  /** Makes every outstanding ticket stale without starting a new request. */
  cancel(): void {
    this.current++
  }
}

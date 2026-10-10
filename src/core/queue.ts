// Delivery queue for notifications: at most `workers` deliveries at once, a bounded wait list, results reported back.
export class DeliveryQueue {
  private jobs: Array<{ job: () => Promise<boolean | void>; done?: (ok: boolean) => void }> = [];
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private workers = 2, private maxQueued = 50) {}

  /** job() resolves to false (or throws) = failed. done(ok) follows. A full queue refuses the job (reported as failed). */
  submit(job: () => Promise<boolean | void>, done?: (ok: boolean) => void): boolean {
    if (this.jobs.length >= this.maxQueued) { done?.(false); return false; }
    this.jobs.push({ job, done });
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.active < this.workers && this.jobs.length) {
      const j = this.jobs.shift()!;
      this.active++;
      void (async () => {
        let ok = true;
        try { ok = (await j.job()) !== false; } catch { ok = false; }
        try { j.done?.(ok); } catch { /* a callback problem never stops the queue */ }
        this.active--;
        this.pump();
        if (this.active === 0 && this.jobs.length === 0) { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
      })();
    }
  }

  /** Resolves when nothing is running or waiting (tests, shutdown). */
  idle(): Promise<void> {
    return this.active === 0 && this.jobs.length === 0 ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }
}

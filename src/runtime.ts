/**
 * Live singletons, shared without a circular import.
 *
 * index.ts owns the tracker and paper trader; the dashboard needs the same
 * instances, not fresh ones. Both modules import this, index registers on boot,
 * and the dashboard reads.
 *
 * The distinction matters more than it looks: every one of these writes its file
 * FROM memory, so anything that edits calls.json or trades.json on disk is undone
 * by the next save. Mutations have to go through the live object.
 */
import type { PerformanceTracker } from './tracker.js';
import type { PaperTrader } from './paper-trader.js';

interface Runtime {
  tracker: PerformanceTracker | null;
  paperTrader: PaperTrader | null;
}

export const runtime: Runtime = { tracker: null, paperTrader: null };

export function registerRuntime(tracker: PerformanceTracker, paperTrader: PaperTrader): void {
  runtime.tracker = tracker;
  runtime.paperTrader = paperTrader;
}

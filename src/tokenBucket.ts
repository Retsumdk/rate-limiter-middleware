/**
 * tokenBucket.ts
 *
 * Core token-bucket algorithm. Kept dependency-free and lazily refilled:
 * instead of running a timer, we compute how many tokens should have
 * accumulated since the last request from elapsed time. This makes the
 * "clock" asynchronous and safe to run in single-threaded runtimes.
 */

/** Result of attempting to take tokens out of a bucket. */
export interface ConsumeResult {
  /** Whether the request was allowed. */
  allowed: boolean;
  /** Tokens remaining after (or despite) this attempt. */
  remaining: number;
  /** If denied, milliseconds to wait before the request would succeed. */
  retryAfterMs: number;
  /** Milliseconds until the bucket resets to full (0 if not deterministic). */
  resetMs: number;
}

/** Mutable per-key bucket state persisted by a backend. */
export interface BucketState {
  tokens: number;
  last: number;
  /** Optional per-key expiry/cap for maintenance backends. */
  lastFailureAt?: number;
}

/** Parameters every bucket uses. */
export interface WeightOptions {
  capacity: number;
  refillRate: number;
}

/**
 * Mutate the bucket state to reflect elapsed time up to `nowMs`, returning
 * a copy for the caller to inspect. Each request rehydrates the bucket by
 * adding `(now - last) * refillRate` tokens (capped at `capacity`).
 */
export function refill(
  state: BucketState,
  capacity: number,
  refillRate: number,
  nowMs = Date.now(),
): { tokens: number; last: number } {
  let tokens = state.tokens;
  let last = state.last;
  if (refillRate > 0 && nowMs > last) {
    const added = ((nowMs - last) / 1000) * refillRate;
    if (added > 0) {
      tokens = Math.min(capacity, tokens + added);
      last = nowMs;
    }
  }
  return { tokens, last };
}

/** The default weight for any unconfigured key or endpoint. */
export const DEFAULT_WEIGHTS: WeightOptions = { capacity: 60, refillRate: 1 };

/** Estimate the reset time (ms) for a full bucket. */
export function resetMs(capacity: number, refillRate: number): number {
  return refillRate > 0 ? Math.ceil((capacity / refillRate) * 1000) : 0;
}

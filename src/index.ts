/**
 * index.ts
 *
 * Public entry point for `rate-limiter-middleware`.
 *
 * ```ts
 * import { rateLimit } from "rate-limiter-middleware";
 *
 * const limiter = rateLimit({ capacity: 100, refillRate: 10 });
 * app.use(limiter.middleware());
 * ```
 */

import { EventEmitter } from "node:events";
import { MemoryBackend, RedisBackend, type StorageBackend, type RedisBackendOptions } from "./backends.js";
import { createLimiter, type RateLimiter, type RateLimiterOptions } from "./rateLimiter.js";
import { DEFAULT_WEIGHTS, type WeightOptions } from "./tokenBucket.js";

/**
 * Everything you can configure when building a limiter. Omitted weights fall
 * back to the default bucket (60 requests per second).
 */
export interface RateLimitConfig extends Partial<RateLimiterOptions> {
  /** Set `backend` to share state across processes instead of in-memory. */
  backend?: StorageBackend;
  /** Shortcut to build a Redis distributed backend with these options. */
  redis?: RedisBackendOptions;
  /** Per-path weight overrides — `{ "/api/search": { capacity: 30, refillRate: 5 } }`. */
  perPath?: Record<string, WeightOptions>;
}

/**
 * Create a rate limiter. In-memory by default; pass `redis` (or a custom
 * `backend`) to enable a distributed bucket shared across instances.
 */
export function rateLimit(config: RateLimitConfig = {}): RateLimiter {
  const { redis, perPath = {}, backend: givenBackend, ...opts } = config;
  let store: StorageBackend;
  if (givenBackend) {
    store = givenBackend;
  } else if (redis) {
    store = new RedisBackend(redis);
  } else {
    store = new MemoryBackend();
  }
  const base = {
    capacity: opts.capacity ?? DEFAULT_WEIGHTS.capacity,
    refillRate: opts.refillRate ?? DEFAULT_WEIGHTS.refillRate,
  };
  const fullOpts: RateLimiterOptions = { ...opts, ...base };
  const emitter = new EventEmitter();
  return createLimiter(store, fullOpts, perPath, emitter);
}

export { MemoryBackend, RedisBackend, DEFAULT_WEIGHTS };
export type { StorageBackend, RedisBackendOptions } from "./backends.js";
export type { RateLimiter, RateLimiterOptions } from "./rateLimiter.js";
export type { WeightOptions, BucketState, ConsumeResult } from "./tokenBucket.js";

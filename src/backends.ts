/**
 * backends.ts
 *
 * Storage abstractions for distributed rate limiting. A backend maps a
 * requester key to a token bucket and atomically debits it. One backend
 * may serve many buckets, keyed by an arbitrary string (IP, user id, API
 * route, etc.).
 */

import Redis from "ioredis";
import type { ConsumeResult } from "./tokenBucket.js";
import { refill } from "./tokenBucket.js";

/** Storage contract implemented by memory and Redis backends. */
export interface StorageBackend {
  /**
   * Atomically debit one token from the bucket identified by `key`.
   * Returns whether the request is allowed and the bucket's state.
   */
  consume(
    key: string,
    capacity: number,
    refillRate: number,
    cost?: number,
    nowMs?: number,
  ): Promise<ConsumeResult>;
  /** Remove the bucket for a key (used by maintenance/deregistration). */
  delete(key: string): Promise<boolean>;
  /** Close any held connections/resources. */
  dispose(): Promise<void>;
}

/** Number of buckets to scan per maintenance pass. */
const MAINTENANCE_BATCH = 1000;

/**
 * Process-local in-memory backend. Fast, zero-config, but state is lost on
 * restart and is not shared across processes. Ideal for single-instance
 * deployments (serverless warm, small services, dev).
 */
export class MemoryBackend implements StorageBackend {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
    cost = 1,
    nowMs = Date.now(),
  ): Promise<ConsumeResult> {
    let state = this.buckets.get(key);
    if (!state) {
      state = { tokens: capacity, last: nowMs };
      this.buckets.set(key, state);
    }
    const filled = refill(state, capacity, refillRate, nowMs);

    if (filled.tokens - cost < -1e-9) {
      const shortfall = cost - filled.tokens;
      const retryAfterMs =
        refillRate > 0 ? Math.ceil((shortfall / refillRate) * 1000) : Infinity;
      return {
        allowed: false,
        remaining: Math.max(0, filled.tokens),
        retryAfterMs,
        resetMs: 0,
      };
    }

    state.tokens = filled.tokens - cost;
    state.last = nowMs;
    return {
      allowed: true,
      remaining: state.tokens,
      retryAfterMs: 0,
      resetMs: 0,
    };
  }

  async delete(key: string): Promise<boolean> {
    return this.buckets.delete(key);
  }

  /** Number of live buckets (useful for observability). */
  get size(): number {
    return this.buckets.size;
  }

  async dispose(): Promise<void> {
    this.buckets.clear();
  }

  /**
   * Drop buckets that hold zero tokens and have not seen activity in
   * `idleMs`, preventing unbounded growth from many distinct keys.
   */
  async prune(idleMs: number, nowMs = Date.now()): Promise<number> {
    let removed = 0;
    let scanned = 0;
    for (const [key, state] of this.buckets) {
      if (scanned++ >= MAINTENANCE_BATCH) break;
      if (state.tokens <= 0 && nowMs - state.last > idleMs) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

/** Redis backend powered by an atomic Lua script. */
const CONSUME_SCRIPT = `
local state = redis.call('HGETALL', KEYS[1])
local tokens = tonumber(ARGV[1])
local last
if #state > 0 then
  tokens = tonumber(state[2])
  last = tonumber(state[4])
else
  last = tonumber(ARGV[2])
end
local now = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local rate = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
if rate > 0 and now > last then
  local added = (now - last) / 1000 * rate
  if added > 0 then
    tokens = math.min(capacity, tokens + added)
    last = now
  end
end
if tokens - cost < 0 then
  local shortfall = cost - tokens
  local retry = 0
  if rate > 0 then
    retry = math.ceil(shortfall / rate * 1000)
  end
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'last', last)
  redis.call('PEXPIRE', KEYS[1], 86400000)
  return {0, tokens, retry}
end
tokens = tokens - cost
redis.call('HSET', KEYS[1], 'tokens', tokens, 'last', last)
redis.call('PEXPIRE', KEYS[1], 86400000)
return {1, tokens, 0}
`;

export interface RedisBackendOptions {
  /** An ioredis client to reuse, or a connection URL to create one. */
  client?: Redis | string;
  /** Key prefix to scope all buckets (default "rlm:"). */
  prefix?: string;
}

/**
 * Distributed backend using Redis. Bucket state is shared across all
 * processes/instances connected to the same Redis, so limits hold globally.
 */
export class RedisBackend implements StorageBackend {
  private readonly client: Redis;
  private readonly owned: boolean;
  private readonly prefix: string;

  constructor(opts: RedisBackendOptions = {}) {
    this.prefix = opts.prefix ?? "rlm:";
    if (opts.client instanceof Redis) {
      this.client = opts.client;
      this.owned = false;
    } else if (typeof opts.client === "string") {
      this.client = new Redis(opts.client);
      this.owned = true;
    } else {
      this.client = new Redis();
      this.owned = true;
    }
  }

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
    cost = 1,
    nowMs = Date.now(),
  ): Promise<ConsumeResult> {
    const redisKey = this.prefix + key;
    const result = (await this.client.eval(
      CONSUME_SCRIPT,
      1,
      redisKey,
      String(capacity),
      String(nowMs),
      String(capacity),
      String(refillRate),
      String(cost),
    )) as [number, number, number];

    const allowed = result[0] === 1;
    const remaining = result[1] ?? 0;
    const retryAfterMs = result[2] ?? 0;
    return {
      allowed,
      remaining,
      retryAfterMs,
      resetMs: refillRate > 0 ? Math.ceil((capacity / refillRate) * 1000) : 0,
    };
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.client.del(this.prefix + key);
    return deleted > 0;
  }

  async dispose(): Promise<void> {
    if (this.owned) {
      this.client.disconnect();
    }
  }
}

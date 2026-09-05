/**
 * rateLimiter.ts
 *
 * The public rate-limiter facade plus the framework adapters (Express and a
 * generic fetch/function handle). It composes a backend (memory or Redis)
 * with the weighted token bucket to answer "may this key proceed?" for every
 * incoming request through a pluggable key generator.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type { StorageBackend } from "./backends.js";
import {
  DEFAULT_WEIGHTS,
  resetMs,
  refill,
  type BucketState,
  type WeightOptions,
} from "./tokenBucket.js";

/** A function that derives the limiter key for a request. */
export type KeyGenerator = (req: IncomingMessage, res: ServerResponse) => string;

/** What an individual request is allowed to do. */
export type LimitParams = WeightOptions & {
  /** Optional fixed cost (default 1 token per request). */
  cost?: number;
};

/** Configuration passed to `createLimiter`. */
export interface RateLimiterOptions extends WeightOptions {
  /** Identity of the caller, used for key generation. */
  keyGenerator?: KeyGenerator;
  /** String prefixed to every key to avoid collisions across apps. */
  keyPrefix?: string;
  /** Let a failure of the underlying backend fail open instead of closed. */
  failOpen?: boolean;
  /** Emit "decision" events (see `onDecision`) when true. */
  emitEvents?: boolean;
}

function defaultKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * A running limiter, returned by `createLimiter` / `rateLimit`. You call
 * `middleware()` in Express or `handle()` directly in any other runtime.
 */
export interface RateLimiter {
  /** Express-style middleware. */
  middleware(): (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => Promise<void>;
  /** Framework-agnostic request wrapper (fetch / hono / bare node). */
  handle(
    req: { socket: { remoteAddress?: string | null }; url?: string },
    handler: (req: unknown, res: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>;
  /** Current state of a bucket for observability/tests. */
  inspect(key: string): Promise<BucketState | undefined>;
  /** Delete the bucket for a key. */
  reset(key: string): Promise<boolean>;
  /** Subscribe to internal "decision" events. Returns an unsubscribe fn. */
  onDecision(cb: (d: { key: string; allowed: boolean; remaining: number; retryAfterMs: number }) => void): () => void;
  /** Number of keys tracked by the backend (memory only). */
  activeKeys(): Promise<number>;
  /** Release any held connections (Redis, etc). */
  dispose(): Promise<void>;
}

/* ----------------------------------------------------------------------- */
/* Implementation                                                           */
/* ----------------------------------------------------------------------- */

/** Match per-path weight overrides against the request URL. */
function weightFor(
  base: WeightOptions,
  perPath: Record<string, WeightOptions> | undefined,
  req: { url?: string },
): WeightOptions {
  let w = base;
  if (perPath && req.url) {
    const path = req.url.split("?")[0]!;
    const found = perPath[path] ?? perPath["*"];
    if (found) w = found;
  }
  return w;
}

const HTTP_429 = 429;

function parseRetryAfter(value: string): number {
  const ms = Number.parseInt(value, 10);
  return Number.isFinite(ms) ? ms * 1000 : 30_000;
}

const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

/**
 * Compose a backend + options into a runner that enforces a weighted token
 * bucket for every incoming request.
 */
export function createLimiter(
  backend: StorageBackend,
  opts: RateLimiterOptions,
  perPath: Record<string, WeightOptions> | undefined,
  emitter: EventEmitter,
): RateLimiter {
  const { keyGenerator = defaultKey, keyPrefix = "", failOpen = false } = opts;
  const base: WeightOptions = { capacity: opts.capacity, refillRate: opts.refillRate };

  async function unbounded(
    key: string,
    req: { url?: string },
  ): Promise<import("./tokenBucket.js").ConsumeResult> {
    const w = weightFor(base, perPath, req);
    return backend.consume(key, w.capacity, w.refillRate, 1);
  }

  function emitDecision(
    key: string,
    allowed: boolean,
    remaining: number,
    retryAfterMs: number,
  ): void {
    if (opts.emitEvents !== false) {
      emitter.emit("decision", { key, allowed, remaining, retryAfterMs });
    }
  }

  /** Resolve the key for a request, run the bucket, and emit the decision. */
  async function check(req: { socket: { remoteAddress?: string | null }; url?: string }): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
    resetMs: number;
    key: string;
  }> {
    const key = keyPrefix + (keyGenerator(req as IncomingMessage, {} as ServerResponse) ?? "unknown");
    const dec = await unbounded(key, req);
    emitDecision(key, dec.allowed, dec.remaining, dec.retryAfterMs);
    return { ...dec, key };
  }

  const bucketHeaders = (d: { remaining: number; resetMs: number }): Record<string, string> => ({
    "X-RateLimit-Limit": String(base.capacity),
    "X-RateLimit-Remaining": String(d.remaining),
    "X-RateLimit-Reset": String(Math.round(Date.now() / 1000) + d.resetMs / 1000),
  });

  const limiter: RateLimiter = {
    middleware() {
      return async (
        req: IncomingMessage,
        res: ServerResponse,
        next: (err?: unknown) => void,
      ): Promise<void> => {
        try {
          const d = await check(req);
          if (!d.allowed) {
            res.statusCode = HTTP_429;
            for (const [k, v] of Object.entries(bucketHeaders(d))) {
              if (!res.headersSent) res.setHeader(k, v);
            }
            res.setHeader("Retry-After", String(Math.max(1, d.retryAfterMs / 1000)));
            res.end(JSON.stringify({ error: "Too many requests" }));
            return;
          }
          for (const [k, v] of Object.entries(bucketHeaders(d))) {
            if (!res.headersSent) res.setHeader(k, v);
          }
          next();
        } catch (err) {
          if (failOpen) {
            next();
            return;
          }
          next(err instanceof Error ? err : new Error(String(err)));
        }
      };
    },

    async handle(req, handler) {
      let d: Awaited<ReturnType<typeof check>>;
      try {
        d = await check(req);
      } catch (err) {
        if (failOpen) return handler(req, {});
        throw err;
      }

      if (!d.allowed) {
        const res = {
          statusCode: HTTP_429,
          headers: {} as Record<string, string>,
          setHeader(k: string, v: string) {
            this.headers[k] = v;
          },
          status(c: number) {
            this.statusCode = c;
            return this;
          },
          send(body: unknown) {
            const text = typeof body === "string" ? body : JSON.stringify(body);
            return Promise.resolve({
              statusCode: this.statusCode,
              headers: { ...this.headers, "Content-Type": "application/json" },
              text,
              json() {
                return JSON.parse(text);
              },
            });
          },
        };
        res.setHeader("Retry-After", String(Math.max(1, d.retryAfterMs / 1000)));
        for (const [k, v] of Object.entries(bucketHeaders(d))) res.setHeader(k, v);
        return res.send({ error: "Too many requests" });
      }

      const out = await handler(req, {});
      if (out && typeof out === "object" && "headers" in (out as object)) {
        const target = out as { headers?: Record<string, string> };
        if (target.headers && typeof target.headers === "object" && !Array.isArray(target.headers)) {
          for (const [k, v] of Object.entries(bucketHeaders(d))) target.headers[k] = v;
        }
      }
      return out;
    },

    async inspect(key: string): Promise<BucketState | undefined> {
      const probe = await backend.consume(keyPrefix + key, base.capacity, base.refillRate, 0);
      if (probe.allowed) {
        return { tokens: probe.remaining, last: Date.now() };
      }
      return { tokens: 0, last: Date.now() };
    },

    async reset(key: string): Promise<boolean> {
      return backend.delete(keyPrefix + key);
    },

    onDecision(cb) {
      const fn = (d: unknown) => cb(d as never);
      emitter.on("decision", fn);
      return () => emitter.off("decision", fn);
    },

    async activeKeys(): Promise<number> {
      try {
        return (backend as { size?: number }).size ?? 0;
      } catch {
        return 0;
      }
    },

    async dispose() {
      await backend.dispose();
    },
  };

  return limiter;
}

/** Re-exported for consumers that want the header parser. */
export function retryAfterSeconds(value: string): number {
  return parseRetryAfter(value);
}

/** Utility exported mainly for tests / header building. */
export function backoffJitter(): number {
  return 0.5 + secureRandom() * 0.5;
}

export { defaultKey };
export { refill, resetMs };

// Re-export DEFAULT_WEIGHTS for parity with the public API surface.
export { DEFAULT_WEIGHTS };

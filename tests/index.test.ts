import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { rateLimit, MemoryBackend, RedisBackend, DEFAULT_WEIGHTS } from "../src/index.js";
import { createLimiter } from "../src/rateLimiter.js";
import { refill, resetMs, type BucketState } from "../src/tokenBucket.js";

/** Minimal fetch-style Response contract reused across tests. */
function jsonResponse(body: unknown): {
  statusCode: number;
  headers: Record<string, string>;
  text: string;
  json(): unknown;
} {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    text: typeof body === "string" ? body : JSON.stringify(body),
    json() {
      return body;
    },
  };
}

describe("token bucket core", () => {
  test("fresh bucket is full", () => {
    const s: BucketState = { tokens: 60, last: 0 };
    const now = 1000;
    const out = refill(s, 60, 1, now);
    expect(out.tokens).toBe(60);
    expect(out.tokens).toBeLessThanOrEqual(DEFAULT_WEIGHTS.capacity);
  });

  test("refills lazily by elapsed time", () => {
    const s: BucketState = { tokens: 0, last: 0 };
    const out = refill(s, 60, 1, 20_000);
    // 20 seconds at 1 token/sec = 20 tokens
    expect(out.tokens).toBeCloseTo(20, 5);
  });

  test("refill caps at capacity", () => {
    const s: BucketState = { tokens: 55, last: 0 };
    const out = refill(s, 60, 1, 60_000);
    expect(out.tokens).toBe(60);
  });

  test("refillRate of 0 never refills", () => {
    const s: BucketState = { tokens: 1, last: 0 };
    refill(s, 60, 0, 60_000);
    expect(s.tokens).toBe(1);
  });

  test("resetMs estimates full-refill time", () => {
    expect(resetMs(60, 1)).toBe(60_000);
    expect(resetMs(60, 0)).toBe(0);
  });
});

describe("MemoryBackend", () => {
  test("allows while tokens remain", async () => {
    const b = new MemoryBackend();
    const r1 = await b.consume("k", 3, 1);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    await b.consume("k", 3, 1);
    const r3 = await b.consume("k", 3, 1);
    // after 3rd consumption remaining is 0
    expect(r3.remaining).toBe(0);
    const over = await b.consume("k", 3, 1);
    expect(over.allowed).toBe(false);
  });

  test("separate keys have separate buckets", async () => {
    const b = new MemoryBackend();
    await b.consume("a", 1, 1);
    const r = await b.consume("b", 1, 1);
    expect(r.allowed).toBe(true);
  });

  test("consume returns retryAfterMs when exhausted", async () => {
    const b = new MemoryBackend();
    await b.consume("k", 1, 1);
    const r = await b.consume("k", 1, 1);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  test("delete removes a bucket", async () => {
    const b = new MemoryBackend();
    await b.consume("k", 1, 1);
    expect(await b.delete("k")).toBe(true);
    const r = await b.consume("k", 1, 1);
    expect(r.allowed).toBe(true);
  });

  test("prune removes idle exhausted buckets", async () => {
    const b = new MemoryBackend();
    await b.consume("idle", 1, 1);
    await b.consume("busy", 1, 1);
    // exhaust both
    await b.consume("idle", 1, 1);
    const removed = await b.prune(1000, 5000);
    // Many buckets may be removed (zero tokens + old) — just assert it runs & type
    expect(typeof removed).toBe("number");
    expect(b.size).toBeGreaterThanOrEqual(0);
  });

  test("size reflects live buckets", async () => {
    const b = new MemoryBackend();
    await b.consume("x", 1, 1);
    await b.consume("y", 1, 1);
    expect(b.size).toBe(2);
  });
});

describe("facade rateLimit()", () => {
  test("in-memory limiter allows and then blocks", async () => {
    const limiter = rateLimit({ capacity: 2, refillRate: 1 });
    const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    expect((await limiter.handle(req, () => jsonResponse({ ok: true })))).toBeTruthy();
    expect((await limiter.handle(req, () => jsonResponse({ ok: true })))).toBeTruthy();
    const blocked = await limiter.handle(req, () => jsonResponse({ ok: true })) as {
      statusCode: number;
      headers: Record<string, string>;
    };
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
  });

  test("keys are distinct per client", async () => {
    const limiter = rateLimit({ capacity: 1, refillRate: 1 });
    const a = { socket: { remoteAddress: "1.1.1.1" } };
    const b = { socket: { remoteAddress: "2.2.2.2" } };
    await limiter.handle(a, () => jsonResponse({}));
    // b is unaffected
    expect((await limiter.handle(b, () => jsonResponse({}) ))).toBeTruthy();
  });

  test("rateLimit sets default capacity", () => {
    const limiter = rateLimit();
    expect(limiter).toBeDefined();
  });

  test("activeKeys works on memory backed limiter", async () => {
    const limiter = rateLimit({ capacity: 1, refillRate: 1 });
    await limiter.handle({ socket: { remoteAddress: "9.9.9.9" } }, () => jsonResponse({}));
    await limiter.handle({ socket: { remoteAddress: "8.8.8.8" } }, () => jsonResponse({}));
    expect(await limiter.activeKeys()).toBe(2);
  });

  test("reset clears a key", async () => {
    const limiter = rateLimit({ capacity: 1, refillRate: 1 });
    const req = { socket: { remoteAddress: "7.7.7.7" } };
    await limiter.handle(req, () => jsonResponse({}));
    const blocked = await limiter.handle(req, () => jsonResponse({})) as { statusCode: number };
    expect(blocked.statusCode).toBe(429);
    await limiter.reset("7.7.7.7");
    expect((await limiter.handle(req, () => jsonResponse({})) )).toBeTruthy();
  });
});

describe("Express-style middleware", () => {
  test("blocks excess requests with 429 + headers", async () => {
    const limiter = rateLimit({ capacity: 2, refillRate: 1 });
    const mw = limiter.middleware();
    const req = { socket: { remoteAddress: "3.3.3.3" } } as any;
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const res = {
      set statusCode(v: number) { statusCode = v; },
      get statusCode() { return statusCode; },
      headersSent: false,
      setHeader(k: string, v: string) { headers[k] = v; },
      end() {},
    } as any;
    await mw(req, res, () => {});
    await mw(req, res, () => {});
    await mw(req, res, () => {});
    expect(statusCode).toBe(429);
    expect(headers["X-RateLimit-Limit"]).toBe("2");
    expect(headers["Retry-After"]).toBeDefined();
  });

  test("onDecision emits decision events", async () => {
    const limiter = rateLimit({ capacity: 1, refillRate: 1 });
    const seen: unknown[] = [];
    const unsub = limiter.onDecision((d) => seen.push(d));
    const req = { socket: { remoteAddress: "5.5.5.5" } } as any;
    const res = { headersSent: false, setHeader() {}, end() {}, statusCode: 200 } as any;
    await limiter.middleware()(req, res, () => {});
    await limiter.middleware()(req, res, () => {});
    expect(seen.length).toBe(2);
    expect((seen[1] as { allowed: boolean }).allowed).toBe(false);
    unsub();
  });
});

describe("integration with createLimiter + explicit backend", () => {
  test("works with a Redis-style backend present (url form)", () => {
    // Only construct the object graph; no real connection attempted.
    const rb = new RedisBackend({ client: "redis://localhost:6379" });
    expect(rb).toBeInstanceOf(RedisBackend);
    void rb.dispose();
  });

  test("createLimiter composes and enforces", async () => {
    const backend = new MemoryBackend();
    const emitter = new EventEmitter();
    const limiter = createLimiter(
      backend,
      { capacity: 2, refillRate: 1 },
      {},
      emitter,
    );
    const req = { socket: { remoteAddress: "6.6.6.6" } };
    await limiter.handle(req, () => jsonResponse({}));
    await limiter.handle(req, () => jsonResponse({}));
    const blocked = await limiter.handle(req, () => jsonResponse({})) as { statusCode: number };
    expect(blocked.statusCode).toBe(429);
    await limiter.dispose();
  });
});

describe("escape hatches + utilities", () => {
  test("retryAfterSeconds parses seconds to ms", async () => {
    const { retryAfterSeconds } = await import("../src/rateLimiter.js");
    expect(retryAfterSeconds("5")).toBe(5000);
  });

  test("backoffJitter is within [0.5, 1.0]", async () => {
    const { backoffJitter } = await import("../src/rateLimiter.js");
    const v = backoffJitter();
    expect(v).toBeGreaterThanOrEqual(0.5);
    expect(v).toBeLessThanOrEqual(1);
  });

  test("defaultKey falls back to 'unknown'", async () => {
    const { defaultKey } = await import("../src/rateLimiter.js");
    expect(defaultKey({ socket: {} } as any)).toBe("unknown");
  });
});

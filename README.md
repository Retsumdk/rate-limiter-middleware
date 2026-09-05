# rate-limiter-middleware

[![CI](https://github.com/Retsumdk/rate-limiter-middleware/workflows/CI/badge.svg)](https://github.com/Retsumdk/rate-limiter-middleware/actions)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.0-f9f9f3.svg)](https://bun.sh/)
[![Bundle](https://img.shields.io/badge/dependencies-1%20(ioredis)-green.svg)](package.json)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A strictly-typed **weighted token-bucket rate limiter** for Node.js and Bun. Use it to protect your API from abuse, enforce fair per-user or per-endpoint limits, and — with a single Redis flag — enforce the same limit **across every instance** of a horizontally scaled service.

The package ships both a **framework-agnostic `handle()`** (works with `fetch`, Hono, bare Node `http`, etc.) and an **Express-style `middleware()`**.

---

## Why this exists

Most rate-limiters fall into two camps:

- **Fixed-window counters** (e.g. "max 100 requests per minute"). Simple, but bursty at window edges and leaky under unpredictable traffic.
- **`express-rate-limit`-style request counting.** Easy, but it counts *requests*, not *weight* — a cheap status-check counts the same as a heavy report query, and there's no clean way to give power users higher caps without code forks.

This library is built around the **token bucket**: tokens refill continuously at a configurable rate, each request costs a configurable weight, so a few heavy requests can share a budget with many light ones. Crucially, buckets in Redis are updated by one **atomic Lua script**, so distributed limits have no read-modify-write race — the exact correctness problem that naive Redis counters get wrong.

## How it works

```
                  ┌────────────────────────────────────────────┐
   request ──► key│   token bucket (capacity, refillRate)       │
   (IP / user /   │   ┌──────────────────────────────────────┐ │
    route)        │   │  tokens = min(capacity, tokens +      │ │
                  │   │            elapsed_time × rate)       │ │
                  │   │  if tokens >= cost ──► allow, tokens─=│ │
                  │   │  else ───────────────► 429 + Retry-After│ │
                  │   └──────────────────────────────────────┘ │
                  └────────────────────────────────────────────┘
                        │                  │
                   MemoryBackend       RedisBackend
                   (in-process)      (atomic Lua, shared)
```

- **Lazy refill** — no timers. Tokens are computed from elapsed time on demand, so a single idle instance costs nothing.
- **Pluggable key** — default is the client IP; supply your own `keyGenerator` for user IDs, API keys, or paths.
- **Per-path weights** — `{ "/api/search": { capacity: 30, refillRate: 5 } }` gives heavy endpoints their own budget.
- **Fail-open safe** — if Redis is down, the limiter degrades gracefully instead of blocking all traffic.
- **Observable** — every decision emits an event (key, allowed, remaining, retry-after) for metrics, and `activeKeys()`/`inspect(key)` expose backend state.

## Installation

```bash
npm install rate-limiter-middleware
# or
bun add rate-limiter-middleware
# or
pnpm add rate-limiter-middleware
```

The only runtime dependency is `ioredis` (used only when you enable the Redis backend; the in-memory backend needs nothing).

## Getting started

### In-memory (zero config)

```ts
import { rateLimit } from "rate-limiter-middleware";

const limiter = rateLimit({ capacity: 100, refillRate: 10 }); // 100 tokens, +10/s
```

### Back an HTTP handler (framework-agnostic)

```ts
import { rateLimit } from "rate-limiter-middleware";

const limiter = rateLimit({ capacity: 3, refillRate: 0.5 });

export default {
  async fetch(req: Request) {
    // Bundle helpers not shown; the limiter takes a Node-style { socket, url } shape.
    const out = await limiter.handle(
      { socket: { remoteAddress: "127.0.0.1" }, url: new URL(req.url).pathname },
      () => new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );
    if (out.statusCode === 429) {
      return new Response(JSON.stringify(out.json()), { status: 429, headers: out.headers });
    }
    return out as Response;
  },
};
```

### Express-style middleware

```ts
import express from "express";
import { rateLimit } from "rate-limiter-middleware";

const app = express();
const limiter = rateLimit({ capacity: 100, refillRate: 10 });

app.use(limiter.middleware());

app.get("/api/data", (_req, res) => {
  res.json({ data: "Your content here" });
});
```

When a bucket is exhausted the middleware responds with **HTTP 429** plus `Retry-After` and `X-RateLimit-*` headers:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 2
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 6000
```

## Distributed limiting with Redis

Pass the Redis backend to enforce limits across every instance sharing the same server. Buckets are keyed under a configurable prefix and updated with a single atomic Lua script:

```ts
import { rateLimit } from "rate-limiter-middleware";

const limiter = rateLimit({
  capacity: 1000,
  refillRate: 50,
  redis: { client: "redis://:password@cache.internal:6379", prefix: "api:" },
});
```

You can also reuse an existing ioredis client and dispose cleanly:

```ts
import Redis from "ioredis";
import { rateLimit } from "rate-limiter-middleware";

const redis = new Redis("redis://cache.internal:6379");
const limiter = rateLimit({ capacity: 1000, refillRate: 50, redis: { client: redis } });
// ... later
await limiter.dispose(); // disconnects only if this limiter owns the client
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `capacity` | `number` | `60` | Max tokens a bucket can hold. |
| `refillRate` | `number` | `1` | Tokens added per second. |
| `cost` | `number` | `1` | Tokens debited per request. |
| `keyGenerator` | `(req, res) => string` | client IP | Which key to limit per request. |
| `keyPrefix` | `string` | `""` | Prefix for all keys (avoids cross-app collisions). |
| `perPath` | `Record<string, WeightOptions>` | `{}` | Override `capacity`/`refillRate` per URL path. |
| `failOpen` | `boolean` | `false` | Allow requests when the backend errors, instead of failing closed. |
| `emitEvents` | `boolean` | `false` | Emit `decision` events (see below). |
| `redis` | `RedisBackendOptions` | none | Enable distributed limiting via Redis. |

## Examples

### Per-endpoint budgets

```ts
import { rateLimit } from "rate-limiter-middleware";

const limiter = rateLimit({
  capacity: 100,
  refillRate: 10,
  perPath: {
    "/api/search":   { capacity: 30, refillRate: 5 },  // expensive endpoint
    "/api/login":    { capacity: 5,  refillRate: 0.2 }, // brute-force guard
    "/api/slow":     { capacity: 1000, refillRate: 200 },
  },
});
```

### Key by API key instead of IP

```ts
import { rateLimit } from "rate-limiter-middleware";

const limiter = rateLimit({
  capacity: 500,
  refillRate: 25,
  keyGenerator: (req) => (req.headers["x-api-key"] as string) ?? "anonymous",
});
```

### Observe every decision for metrics

```ts
const limiter = rateLimit({ capacity: 100, refillRate: 10, emitEvents: true });
const off = limiter.onDecision(({ key, allowed, remaining, retryAfterMs }) => {
  if (!allowed) console.log(`rate-limited ${key}, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
});
// later
off(); // unsubscribe
```

### Expected behavior (verified)

Starting with `capacity: 3, refillRate: 0.5` and a client IP key, five rapid requests produce:

```
request 1 → 200
request 2 → 200
request 3 → 200
request 4 → 429
request 5 → 429
```

After ~2s (≈ +1 token), the sixth request succeeds with `200`.

## Public API

```
rateLimit(config?: RateLimitConfig)  →  RateLimiter
RateLimiter:
  .handle(req, handler)   →  runs handler, or 429 response object when blocked
  .middleware()           →  Express-style (req, res, next)
  .inspect(key)           →  current bucket state
  .reset(key)             →  delete a bucket
  .activeKeys()           →  number of tracked buckets (memory)
  .onDecision(fn)         →  subscribe to decisions, returns unsubscribe
  .dispose()              →  release backend connections
```

Advanced users can import `MemoryBackend` / `RedisBackend` directly and compose a limiter with `createLimiter`, or use the token-bucket core (`refill`, `resetMs`, `DEFAULT_WEIGHTS`) as a dependency-free building block.

## Development

```bash
bun install --frozen-lockfile   # install deps
bun run typecheck               # strict tsc, no emit
bun test                        # 23 tests / 39 assertions
bun run build                   # emits dist/ with .d.ts + sourcemaps
```

## License

MIT — see [LICENSE](LICENSE).

Built by [Retsumdk](https://github.com/Retsumdk).

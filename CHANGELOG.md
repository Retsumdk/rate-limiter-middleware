# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-07

### Added

- Weighted token-bucket rate limiter core (`rateLimiter.ts`, `tokenBucket.ts`):
  - Fixed-capacity and weighted-cost token buckets.
  - Per-key active tracking, `reset`, `activeKeys`, and configurable capacities.
- Pluggable storage backends (`backends.ts`):
  - In-memory backend (zero config) for single-process / development use.
  - Redis-backed backend for distributed, multi-instance rate limiting.
- `rateLimit()` facade — one-call composition with default settings.
- `createLimiter()` — explicit backend + configuration composition.
- Express-style middleware with `429` responses and standard `Retry-After` headers.
- `onDecision` event emission for metrics and observability hooks.
- Escape-hatch utilities: `retryAfterSeconds`, `backoffJitter`, `defaultKey`.
- Full test suite (23 tests) covering capacity, distributed backends, middleware,
  and the verified behavior documented in the README.
- MIT license, TypeScript types, and package exports for Node.js and Bun.

<!-- Keep a Changelog / SemVer templates -->
[1.0.0]: https://github.com/Retsumdk/rate-limiter-middleware/releases/tag/v1.0.0

# rate-limiter-middleware

[![Build](https://github.com/Retsumdk/rate-limiter-middleware/workflows/Test/badge.svg)](https://github.com/Retsumdk/rate-limiter-middleware/actions)
[![TypeScript](https://img.shields.io/badge/typescript-4.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Token bucket rate limiting for Node.js APIs. A production-ready middleware for protecting your APIs from abuse and ensuring fair resource usage.

## Features

- **Token bucket algorithm** - Efficient and fair rate limiting
- **Express integration** - Easy to use middleware for Express.js
- **Customizable limits** - Per-user, per-IP, or per-endpoint limits
- **Redis support** - Distributed rate limiting across multiple servers
- **TypeScript support** - Full type safety with comprehensive types

## Installation

```bash
npm install rate-limiter-middleware
# or
pnpm add rate-limiter-middleware
```

## Quick Start

```typescript
import express from 'express';
import { RateLimiter } from 'rate-limiter-middleware';

const app = express();

const rateLimiter = new RateLimiter({
  windowMs: 60000,      // 1 minute window
  max: 100,             // 100 requests per window
  message: 'Too many requests',
});

app.use(rateLimiter.middleware());

app.get('/api/data', (req, res) => {
  res.json({ data: 'Your content here' });
});
```

## Configuration

```typescript
{
  windowMs: number;           // Time window in milliseconds
  max: number;                // Max requests per window
  keyGenerator?: Function;     // Custom key function (default: IP)
  skipFailedRequests?: boolean; // Skip failed requests (default: false)
  redis?: RedisClient;         // Optional Redis for distributed limiting
}
```

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built by [The BookMaster](https://github.com/Retsumdk) with [Zo Computer](https://zo.computer)

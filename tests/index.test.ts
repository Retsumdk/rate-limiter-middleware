import { describe, test, expect } from "bun:test";
describe("rate-limiter-middleware", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});

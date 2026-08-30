/**
 * Rate limiter tests.
 *
 * The behaviour worth pinning is not "it counts" but the three decisions around
 * the counting: that a throttled caller cannot extend their own penalty, that a
 * successful sign-in does not spend the budget meant for failed ones, and that
 * X-Forwarded-For is only believed when there is a proxy to believe.
 */

import { expect, test, describe } from "bun:test";
import { rateLimiter, clientAddress, tooMany } from "../src/ratelimit.js";

describe("counting", () => {
  test("allows up to the limit, then refuses", () => {
    const limiter = rateLimiter({ limit: 3, windowMs: 60_000 });
    expect([1, 2, 3].map(() => limiter.check("a").ok)).toEqual([true, true, true]);
    expect(limiter.check("a").ok).toBe(false);
  });

  test("counts each caller separately", () => {
    const limiter = rateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("b").ok).toBe(true);
    expect(limiter.check("a").ok).toBe(false);
  });

  test("reports how much budget is left", () => {
    const limiter = rateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.check("a").remaining).toBe(2);
    expect(limiter.check("a").remaining).toBe(1);
    expect(limiter.check("a").remaining).toBe(0);
  });

  test("the window slides, so budget returns", async () => {
    const limiter = rateLimiter({ limit: 2, windowMs: 120 });
    limiter.check("a");
    limiter.check("a");
    expect(limiter.check("a").ok).toBe(false);

    await new Promise((r) => setTimeout(r, 160));
    expect(limiter.check("a").ok).toBe(true);
  });

  test("says when to come back, and never says zero seconds", () => {
    const limiter = rateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check("a");
    const refused = limiter.check("a");
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("hammering", () => {
  test("a refused attempt does not extend the penalty", async () => {
    const limiter = rateLimiter({ limit: 1, windowMs: 150 });
    limiter.check("a");

    // Keep trying throughout the window; the window must still expire on time.
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("a").ok).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(limiter.check("a").ok).toBe(true);
  });
});

describe("forgiveness", () => {
  test("an attempt can be handed back", () => {
    const limiter = rateLimiter({ limit: 2, windowMs: 60_000 });
    limiter.check("a");
    limiter.check("a");
    expect(limiter.check("a").ok).toBe(false);

    limiter.forgive("a");
    expect(limiter.check("a").ok).toBe(true);
  });

  test("forgiving an unknown caller is harmless", () => {
    const limiter = rateLimiter({ limit: 1, windowMs: 60_000 });
    expect(() => limiter.forgive("nobody")).not.toThrow();
  });
});

describe("identifying the caller", () => {
  const request = (headers) => new Request("http://localhost/", { headers });
  const server = { requestIP: () => ({ address: "10.0.0.1" }) };

  test("behind a proxy, the left-most forwarded address is the client", () => {
    const req = request({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" });
    expect(clientAddress(req, server, { trustProxy: true })).toBe("203.0.113.7");
  });

  test("falls back to the socket when the header is absent", () => {
    expect(clientAddress(request({}), server, { trustProxy: true })).toBe("10.0.0.1");
  });

  test("without a proxy the header is ignored, because anyone can send it", () => {
    const req = request({ "x-forwarded-for": "1.2.3.4" });
    // Trusting this unproxied would let a caller invent an address per request
    // and walk straight past every limit.
    expect(clientAddress(req, server, { trustProxy: false })).toBe("10.0.0.1");
  });

  test("copes with no address at all", () => {
    expect(clientAddress(request({}), {}, { trustProxy: false })).toBe("unknown");
  });
});

describe("the refusal", () => {
  test("is a 429 carrying Retry-After", async () => {
    const response = tooMany({ retryAfter: 42 }, "Slow down.");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toEqual({ error: "Slow down.", retryAfter: 42 });
  });
});

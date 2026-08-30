/**
 * ratelimit.js — keep one visitor from being all of them.
 *
 * There were no limits at all: a script could register ten thousand couriers,
 * grind the login endpoint for passwords, or fire messages until the disk
 * filled. None of that needs sophistication to stop, only a ceiling.
 *
 * Sliding-window counters held in memory. That is the right size for a service
 * running as a single process — and it is worth being clear about the
 * trade-off, which is that a restart forgets every counter. For send limits
 * that is harmless. For login attempts it means a determined attacker gains a
 * little from a deploy, which is a fair price for not writing a row per failed
 * password.
 */

/**
 * A window of `limit` events per `windowMs`, keyed by whatever identifies the
 * caller. Keys are swept lazily, so an idle limiter costs nothing.
 */
export function rateLimiter({ limit, windowMs, name = "requests" }) {
  const hits = new Map();
  let lastSweep = Date.now();

  const sweep = (now) => {
    for (const [key, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length) hits.set(key, live);
      else hits.delete(key);
    }
    lastSweep = now;
  };

  return {
    name,
    limit,
    windowMs,

    /**
     * Record an attempt and say whether it is allowed. Rejected attempts are
     * not recorded, so a caller being throttled cannot extend their own
     * penalty by hammering.
     */
    check(key) {
      const now = Date.now();
      if (now - lastSweep > windowMs) sweep(now);

      const times = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

      if (times.length >= limit) {
        hits.set(key, times);
        const retryAfter = Math.ceil((windowMs - (now - times[0])) / 1000);
        return { ok: false, remaining: 0, retryAfter: Math.max(1, retryAfter) };
      }

      times.push(now);
      hits.set(key, times);
      return { ok: true, remaining: limit - times.length, retryAfter: 0 };
    },

    /** Undo an attempt — for when it turned out to be legitimate after all. */
    forgive(key) {
      const times = hits.get(key);
      if (times?.length) times.pop();
    },

    size: () => hits.size,
  };
}

/**
 * The caller's address.
 *
 * This runs behind a proxy, so the socket address is the proxy's and the real
 * client is in X-Forwarded-For. That header is trivially forged when it is
 * *not* behind a proxy, which would let an attacker sidestep every limit here
 * by inventing an address per request — so it is only trusted when the
 * deployment says there is a proxy in front.
 */
export function clientAddress(req, server, { trustProxy = true } = {}) {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    // Left-most entry is the original client; the rest are intermediaries.
    if (forwarded) return forwarded.split(",")[0].trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return server?.requestIP?.(req)?.address ?? "unknown";
}

/** A 429 that tells the caller when to come back. */
export function tooMany(result, message) {
  return new Response(
    JSON.stringify({ error: message, retryAfter: result.retryAfter }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfter),
      },
    }
  );
}

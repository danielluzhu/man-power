/**
 * clock.js — keep an eye on the one number the whole product rests on.
 *
 * Every delivery time is `now + journey seconds`, stored absolutely and never
 * recomputed. That makes arrivals immune to the server being down — but it also
 * means a wrong clock at *send* time bakes a wrong arrival in permanently. A
 * message is not late; it is wrong, and nothing downstream can tell.
 *
 * This host takes its time from the hypervisor (kvm-clock, /dev/ptp_kvm), which
 * is why systemd-timesyncd is masked and why `timedatectl` reports the clock as
 * unsynchronised even though it is accurate. Running an NTP daemon here would
 * fight the paravirtualised clock rather than help it. So instead of trying to
 * *set* the time, this checks it: independent sources, on boot and hourly, with
 * the result exposed on /api/health.
 */

/**
 * Sources are read for their Date header only, so any reliable HTTPS host will
 * do. Two independent ones, so a single misconfigured server cannot raise a
 * false alarm on its own.
 */
const SOURCES = ["https://www.cloudflare.com", "https://www.google.com"];

/** Beyond this the clock is a product bug, not a rounding error. */
export const DRIFT_LIMIT_SECONDS = 30;

const TIMEOUT_MS = 8000;

/** Drift against one source, in seconds. Positive means we are ahead. */
async function driftAgainst(url) {
  const before = Date.now();
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const after = Date.now();

  const header = res.headers.get("date");
  if (!header) throw new Error("no Date header");
  const remote = Date.parse(header);
  if (Number.isNaN(remote)) throw new Error(`unparseable Date: ${header}`);

  // The header is whole seconds and was true somewhere inside the round trip,
  // so compare against the midpoint and allow for the truncation.
  const midpoint = (before + after) / 2;
  return { url, drift: (midpoint - (remote + 500)) / 1000, roundTrip: after - before };
}

/**
 * Check the clock against every source, and report the smallest drift found —
 * the most favourable reading, so a slow or misconfigured source cannot raise a
 * false alarm.
 */
export async function checkClock() {
  const readings = [];
  const failures = [];

  for (const url of SOURCES) {
    try {
      readings.push(await driftAgainst(url));
    } catch (err) {
      failures.push(`${url}: ${err.message}`);
    }
  }

  if (!readings.length) {
    return {
      ok: null, // unknown, which is not the same as wrong
      checkedAt: Date.now(),
      reason: `no source reachable (${failures.join("; ")})`,
    };
  }

  const best = readings.reduce((a, b) => (Math.abs(a.drift) <= Math.abs(b.drift) ? a : b));
  return {
    ok: Math.abs(best.drift) <= DRIFT_LIMIT_SECONDS,
    driftSeconds: Math.round(best.drift * 10) / 10,
    source: best.url,
    roundTripMs: best.roundTrip,
    sourcesChecked: readings.length,
    checkedAt: Date.now(),
    ...(failures.length ? { unreachable: failures } : {}),
  };
}

/**
 * Check now, then hourly, keeping the latest result for /api/health. Never
 * throws and never blocks startup: an unreachable time source is not a reason
 * to refuse to serve.
 */
export function monitorClock({ intervalMs = 3600_000, onResult } = {}) {
  const state = { last: { ok: null, reason: "not checked yet" } };

  const run = async () => {
    try {
      state.last = await checkClock();
    } catch (err) {
      state.last = { ok: null, checkedAt: Date.now(), reason: err.message };
    }
    onResult?.(state.last);
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return state;
}

/** One line for the log, saying plainly whether arrivals can be trusted. */
export function describeClock(result) {
  if (result.ok === null) return `Clock: unverified (${result.reason})`;
  const drift = result.driftSeconds;
  const sign = drift >= 0 ? "ahead of" : "behind";
  if (result.ok) return `Clock: ${Math.abs(drift)}s ${sign} ${new URL(result.source).hostname} — within tolerance`;
  return `Clock: WRONG BY ${Math.abs(drift)}s (${sign} ${new URL(result.source).hostname}). ` +
         `Delivery times computed now will be wrong by the same amount, permanently.`;
}

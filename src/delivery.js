/**
 * delivery.js — the thing that notices a courier has arrived.
 *
 * Arrival was only ever evaluated lazily, when someone happened to load the
 * page. That is fine for deciding whether to show a message, and useless as a
 * product: nobody keeps a tab open for three weeks, so a message could land and
 * no one would ever be told.
 *
 * This closes that gap. Every tick it asks the database what has arrived and
 * not yet been announced, hands each one to the notification channels, and
 * marks it. State lives entirely in the database rather than in scheduled
 * timers, which matters because a timer set for three weeks' time does not
 * survive a deploy — and this service will be deployed many times before some
 * of its couriers land.
 *
 * AT LEAST ONCE, NOT AT MOST ONCE
 * -------------------------------
 * A message is marked as announced only after its channels have run. If the
 * process dies mid-dispatch, the arrival is announced again on restart rather
 * than being lost. For this product a duplicate notification is a small
 * annoyance and a missing one defeats the entire premise, so the choice is
 * easy.
 */

import { pendingArrivals, markNotified, deliveryBacklog } from "./db.js";

/**
 * A channel is anything with a name and a deliver(). They are run in parallel
 * per message and their failures are isolated: one broken channel must not stop
 * the others, and must not stop the arrival being recorded.
 */
export function journalChannel() {
  return {
    name: "journal",
    async deliver(arrival) {
      const days = (arrival.total_seconds / 86400).toFixed(1);
      console.log(
        `Delivered #${arrival.id}: ${arrival.sender_handle} → ${arrival.recipient_handle}, ` +
        `${arrival.from_city} to ${arrival.to_city}, ${days} days on the road`
      );
    },
  };
}

/**
 * Announce one arrival on every channel. Resolves to the channels that failed,
 * so the caller can log them without letting them block the mark.
 */
async function announce(arrival, channels) {
  const results = await Promise.allSettled(
    channels.map((channel) => channel.deliver(arrival))
  );
  return results
    .map((result, i) => (result.status === "rejected" ? { channel: channels[i].name, error: result.reason } : null))
    .filter(Boolean);
}

/**
 * Start the delivery worker.
 *
 * Returns a handle carrying counters for /api/health and a stop().
 */
export function startDelivery(db, { channels = [], intervalMs = 30_000, batchSize = 50 } = {}) {
  const stats = {
    delivered: 0,
    failures: 0,
    lastRunAt: null,
    lastDeliveredAt: null,
    running: false,
    channels: channels.map((c) => c.name),
  };

  const tick = async () => {
    // One pass at a time. A slow channel must not let the next tick pick up the
    // same arrivals and announce them twice.
    if (stats.running) return;
    stats.running = true;

    try {
      const arrivals = pendingArrivals(db, batchSize);
      for (const arrival of arrivals) {
        const failed = await announce(arrival, channels);
        for (const { channel, error } of failed) {
          stats.failures++;
          console.error(`Delivery #${arrival.id} failed on ${channel}: ${error?.message ?? error}`);
        }
        // Marked regardless: every channel that could deliver has, and leaving
        // it unmarked would replay the working channels on the next tick too.
        if (markNotified(db, arrival.id)) {
          stats.delivered++;
          stats.lastDeliveredAt = Date.now();
        }
      }
    } catch (err) {
      console.error("Delivery worker error:", err);
    } finally {
      stats.lastRunAt = Date.now();
      stats.running = false;
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stats,
    backlog: () => deliveryBacklog(db),
    runNow: tick,
    stop: () => clearInterval(timer),
  };
}

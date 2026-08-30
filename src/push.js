/**
 * push.js — reaching someone who is not looking at the page.
 *
 * Web Push is the right fit here. It needs no mail provider, no domain and no
 * account with anyone: the browser hands us an endpoint, we encrypt a payload
 * to it, and the browser's own push service delivers it. For a service whose
 * whole point is that you go away and come back weeks later, that matters.
 *
 * The catch worth knowing: on iOS this only works once the site has been added
 * to the home screen as a web app. Desktop and Android need nothing.
 *
 * VAPID KEYS
 * ----------
 * The keypair identifies this server to push services, and every existing
 * subscription is bound to it — regenerate it and every browser already
 * subscribed becomes unreachable. So it is generated once, written outside the
 * repository, and reused for the life of the deployment.
 */

import webpush from "web-push";
import { subscriptionsFor, deleteSubscription } from "./db.js";

const KEYS_PATH = process.env.VAPID_KEYS_PATH || "data/vapid.json";

/**
 * Load the VAPID keypair, generating it on first run.
 *
 * `subject` must be a mailto: or https: URL identifying whoever runs this;
 * push services use it to get in touch if the server misbehaves.
 */
export async function loadVapid(subject = process.env.VAPID_SUBJECT || "mailto:postmaster@localhost") {
  const file = Bun.file(KEYS_PATH);

  let keys;
  if (await file.exists()) {
    keys = await file.json();
  } else {
    keys = webpush.generateVAPIDKeys();
    await Bun.write(KEYS_PATH, JSON.stringify(keys, null, 2));
    // The private key is a credential; nobody else needs to read it.
    await Bun.$`chmod 600 ${KEYS_PATH}`.quiet().catch(() => {});
    console.log(`Generated a VAPID keypair at ${KEYS_PATH}`);
  }

  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  return { publicKey: keys.publicKey };
}

/** One week: long enough to survive a phone being off for a holiday. */
const TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * The actual network call, kept separate so the delivery logic around it —
 * which subscriptions to try, which to throw away — can be tested without a
 * push service. Real end-to-end delivery ends at Google's or Mozilla's servers
 * and cannot be tested here.
 */
const deliver = (subscription, body) =>
  webpush.sendNotification(subscription, body, { TTL: TTL_SECONDS });

/**
 * Build the encrypted request for a subscription without sending it. Used by
 * the tests to check that payloads really are encrypted and signed.
 */
export function describeRequest(subscription, payload) {
  return webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
    TTL: TTL_SECONDS,
  });
}

/**
 * Send to every browser a courier has registered.
 *
 * A push service replying 404 or 410 means the subscription is dead — the
 * browser was uninstalled, or the permission revoked — and it is deleted rather
 * than retried forever. Anything else is left in place and counted, since a
 * push service having a bad afternoon is not a reason to forget someone.
 */
export async function pushToUser(db, userId, payload, { send = deliver } = {}) {
  const subscriptions = subscriptionsFor(db, userId);
  if (!subscriptions.length) return { sent: 0, pruned: 0, failed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0, pruned = 0, failed = 0;

  await Promise.all(
    subscriptions.map(async (row) => {
      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        await send(subscription, body);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deleteSubscription(db, row.endpoint);
          pruned++;
        } else {
          failed++;
          throw err;
        }
      }
    })
  );

  return { sent, pruned, failed };
}

/**
 * The delivery channel. Notifications say who the message is from and how far
 * they came, but never carry the message itself — the point of the thing is
 * that you open it.
 */
export function pushChannel(db, options = {}) {
  return {
    name: "web-push",
    async deliver(arrival) {
      const days = arrival.total_seconds / 86400;
      const travelled =
        days >= 1
          ? `${days.toFixed(1)} days on the road`
          : `${Math.round(arrival.total_seconds / 3600)} hours on the road`;

      await pushToUser(db, arrival.recipient_id, {
        title: `A courier reached you`,
        body: `From ${arrival.sender_handle}, out of ${arrival.from_city} — ${travelled}.`,
        tag: `message-${arrival.id}`,
        url: `/?message=${arrival.id}`,
      }, options);
    },
  };
}

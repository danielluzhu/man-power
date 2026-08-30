/**
 * Web Push tests.
 *
 * Real delivery ends at Google's or Mozilla's servers, so it cannot be tested
 * here and these do not pretend to. What they do cover is everything up to the
 * wire — that a payload really is encrypted and signed rather than sent in the
 * clear — and everything after it, which is the logic worth protecting: which
 * browsers get told, and which subscriptions get thrown away.
 *
 * The network call itself is injectable for that reason. An earlier attempt
 * stood a local HTTP server in for a push service, which failed for an
 * unrelated reason (Bun's node:http shim and the push library disagree), and
 * would have been testing the library rather than this code either way.
 */

import { expect, test, describe, beforeAll } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import {
  openDatabase, createUser, saveSubscription, subscriptionsFor, countSubscriptions,
} from "../src/db.js";
import { loadVapid, pushToUser, describeRequest, pushChannel } from "../src/push.js";

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");

/** A subscription shaped exactly like a browser's, with real ECDH keys. */
function fakeSubscription(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: base64url(ecdh.getPublicKey()), auth: base64url(randomBytes(16)) },
  };
}

let db;
let handles = 0;
const courier = () =>
  createUser(db, {
    handle: `push-${++handles}-${Date.now()}`, password: "testtest",
    city: "Madrid", country: "Spain", lat: 40.4168, lon: -3.7038,
  });

/** A stand-in for the push service that records calls and can be made to fail. */
function recorder(status = null) {
  const calls = [];
  const send = async (subscription, body) => {
    calls.push({ endpoint: subscription.endpoint, body });
    if (status) {
      const err = new Error(`push service returned ${status}`);
      err.statusCode = status;
      throw err;
    }
  };
  return { calls, send };
}

beforeAll(async () => {
  process.env.VAPID_KEYS_PATH = `/tmp/vapid-test-${Date.now()}.json`;
  await loadVapid("mailto:test@example.com");
  db = openDatabase(":memory:");
});

describe("encryption", () => {
  test("the payload goes out encrypted and signed, not in the clear", () => {
    const subscription = fakeSubscription("https://push.example.com/abc");
    const request = describeRequest(subscription, {
      title: "A courier reached you",
      body: "From alice, out of Madrid — 1.9 days on the road.",
    });

    expect(request.endpoint).toBe(subscription.endpoint);
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    // VAPID: the server identifies itself to the push service with a signed JWT.
    expect(request.headers.Authorization).toMatch(/^vapid /i);
    expect(request.body.length).toBeGreaterThan(0);

    // Nothing recognisable should survive on the wire.
    const wire = Buffer.from(request.body).toString("latin1");
    expect(wire).not.toContain("alice");
    expect(wire).not.toContain("Madrid");
    expect(wire).not.toContain("courier");
  });
});

describe("who gets told", () => {
  test("every browser a courier has registered", async () => {
    const user = await courier();
    saveSubscription(db, user.id, fakeSubscription("https://push.example.com/laptop"));
    saveSubscription(db, user.id, fakeSubscription("https://push.example.com/phone"));

    const { calls, send } = recorder();
    const result = await pushToUser(db, user.id, { title: "landed" }, { send });

    expect(result.sent).toBe(2);
    expect(calls.map((c) => c.endpoint).sort()).toEqual([
      "https://push.example.com/laptop",
      "https://push.example.com/phone",
    ]);
  });

  test("only that courier's browsers", async () => {
    const mine = await courier();
    const theirs = await courier();
    saveSubscription(db, mine.id, fakeSubscription("https://push.example.com/mine"));
    saveSubscription(db, theirs.id, fakeSubscription("https://push.example.com/theirs"));

    const { calls, send } = recorder();
    await pushToUser(db, mine.id, { title: "landed" }, { send });

    expect(calls.map((c) => c.endpoint)).toEqual(["https://push.example.com/mine"]);
  });

  test("a courier with no browsers registered is not an error", async () => {
    const user = await courier();
    const { calls, send } = recorder();
    const result = await pushToUser(db, user.id, { title: "nobody home" }, { send });

    expect(result).toEqual({ sent: 0, pruned: 0, failed: 0 });
    expect(calls).toEqual([]);
  });
});

describe("dead subscriptions", () => {
  for (const status of [404, 410]) {
    test(`a ${status} removes the subscription`, async () => {
      const user = await courier();
      saveSubscription(db, user.id, fakeSubscription(`https://push.example.com/gone-${status}`));
      expect(subscriptionsFor(db, user.id).length).toBe(1);

      const { send } = recorder(status);
      const result = await pushToUser(db, user.id, { title: "gone" }, { send });

      expect(result.pruned).toBe(1);
      expect(subscriptionsFor(db, user.id).length).toBe(0);
    });
  }

  test("a temporary failure keeps the subscription", async () => {
    const user = await courier();
    saveSubscription(db, user.id, fakeSubscription("https://push.example.com/flaky"));

    const { send } = recorder(500);
    await expect(pushToUser(db, user.id, { title: "later" }, { send })).rejects.toThrow();
    // A push service having a bad afternoon is not a reason to forget someone.
    expect(subscriptionsFor(db, user.id).length).toBe(1);
  });
});

describe("storage", () => {
  test("re-subscribing the same browser updates rather than duplicates", async () => {
    const user = await courier();
    const before = countSubscriptions(db);

    const first = fakeSubscription("https://push.example.com/same-browser");
    saveSubscription(db, user.id, first);
    const second = { ...first, keys: fakeSubscription("x").keys };
    saveSubscription(db, user.id, second);

    expect(countSubscriptions(db)).toBe(before + 1);
    expect(subscriptionsFor(db, user.id)[0].p256dh).toBe(second.keys.p256dh);
  });
});

describe("what the notification says", () => {
  test("names the sender and the journey, but never the message", async () => {
    const user = await courier();
    saveSubscription(db, user.id, fakeSubscription("https://push.example.com/x"));

    const { calls, send } = recorder();
    await pushChannel(db, { send }).deliver({
      id: 7,
      recipient_id: user.id,
      sender_handle: "alice",
      from_city: "Madrid",
      total_seconds: 165_000, // 1.9 days
    });

    const payload = JSON.parse(calls[0].body);
    expect(payload.body).toContain("alice");
    expect(payload.body).toContain("Madrid");
    expect(payload.body).toContain("1.9 days");
    // The whole point is that you open it to read it.
    expect(JSON.stringify(payload)).not.toMatch(/\bbody:\s*"[^"]*message/i);
    expect(payload.url).toBe("/?message=7");
  });
});

/**
 * server.js — Man Power HTTP server.
 *
 * Messages carried on foot, at world-record pace.
 * Send a message and it does not appear in the recipient's inbox until enough
 * real time has passed for a world-record athlete to have physically covered
 * the distance — running the land, swimming the water.
 */

import { LandMask, buildRoute, positionAt } from "./src/geo.js";
import { RUN_LADDER, SWIM_LADDER } from "./src/records.js";
import { Elevation } from "./src/terrain.js";
import { RoutingGrid } from "./src/router.js";
import { monitorClock, describeClock } from "./src/clock.js";
import { startDelivery, journalChannel } from "./src/delivery.js";
import { loadVapid, pushChannel } from "./src/push.js";
import { rateLimiter, clientAddress, tooMany } from "./src/ratelimit.js";
// Both aliased: `mask` is already the land mask, and `countries` the city
// gazetteer's country names.
import { normalise, mask as maskPhone, countries as callingCodes } from "./src/phone.js";
import { smsTransport } from "./src/sms.js";
import { issueCode, verifyCode, pruneCodes, CODE_LENGTH } from "./src/verification.js";
import * as store from "./src/db.js";

const PORT = Number(process.env.PORT) || 4321;

const mask = await LandMask.load();
const elevation = await Elevation.fromGzip(await Bun.file("data/elevation.bin.gz").arrayBuffer());

// Planning happens on a 0.2 degree grid; the 1 degree grid is the relaxed one
// the A* heuristic is drawn from. Both are derived once at boot.
const grid = RoutingGrid.downsample(mask, elevation, 0.2);
const coarse = RoutingGrid.downsample(mask, elevation, 1.0, { optimistic: true });
const world = { mask, elevation, grid, coarse };

const db = store.openDatabase();
const { cities, countries } = await Bun.file("data/cities.json").json();

/** Strip diacritics and case so "Reykjavik" can match "Reykjavík". */
const fold = (str) => str.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * Folded names, computed once at boot.
 * GeoNames stores "Reykjavík" and "São Paulo" with their diacritics, but people
 * type "Reykjavik" and "Sao Paulo", so matching happens on the folded forms.
 */
const folded = cities.map((c) => fold(c[0]));

console.log(`Land mask ${mask.width}×${mask.height} · elevation ${elevation.width}×${elevation.height} · routing ${grid.width}×${grid.height} · ${cities.length} cities`);

const startedAt = Date.now();

// Delivery times are computed once and stored, so a wrong clock at send time is
// baked in permanently. Watch it rather than trust it.
const vapid = await loadVapid();
const sms = smsTransport();

/**
 * Where this app answers from, as browsers see it.
 *
 * Needed because WebOTP — the API that lets Android read the code straight out
 * of the message — only fires when the SMS names the exact origin it is for.
 * That binding is the whole point of it: a code texted for one site cannot be
 * autofilled into another.
 */
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "https://man-4321.another.ac").replace(/\/+$/, "");
const OTP_DOMAIN = new URL(PUBLIC_ORIGIN).host;
console.log(`SMS transport: ${sms.name}${sms.live ? "" : " (development — codes go to this log)"} · origin ${PUBLIC_ORIGIN}`);

// Expired codes and abandoned enrolments are worthless; sweep them hourly.
setInterval(() => {
  pruneCodes(db);
  store.pruneEnrolments(db);
}, 60 * 60 * 1000).unref?.();

// Nothing else notices that a courier has arrived, so this does.
const delivery = startDelivery(db, { channels: [journalChannel(), pushChannel(db)] });

const clock = monitorClock({
  onResult: (result) => {
    const line = describeClock(result);
    if (result.ok === false) console.error(line);
    else console.log(line);
  },
});

/* --------------------------------------------------------- rate limits --- */

/**
 * Ceilings, chosen to be invisible to anyone using the app and firmly in the
 * way of anyone scripting it.
 *
 * Registration is per address and deliberately not tight: an office, a campus
 * or a phone network puts a great many legitimate people behind one IP, and a
 * limit low enough to be interesting to an attacker is low enough to lock out a
 * classroom. Twenty an hour stops bulk enrolment without doing that.
 *
 * Sending is the most generous relative to real use — nobody dispatches twenty
 * couriers an hour, and the ones who try are not writing letters.
 *
 * Every ceiling is overridable, so they can be tightened under abuse without a
 * deploy.
 */
const ceiling = (name, fallback) => Number(process.env[`LIMIT_${name.toUpperCase()}`]) || fallback;

const LIMITS = {
  // Each SMS costs money, which makes the request endpoint the one an attacker
  // profits from: pointing it at numbers they control turns a sign-in form into
  // a bill. Hence a tight per-number ceiling as well as a per-address one.
  codePerPhone: rateLimiter({ limit: ceiling("code_per_phone", 3),  windowMs: 60 * 60 * 1000, name: "code/phone" }),
  codePerHost:  rateLimiter({ limit: ceiling("code_per_host", 15),  windowMs: 60 * 60 * 1000, name: "code/host" }),
  // Guessing is really bounded by the five attempts a single code allows; these
  // stop someone working through numbers. Keyed on the number first, because
  // that is what is under attack — an address-only limit would have a whole
  // office sharing one allowance and locking itself out.
  verifyPerPhone: rateLimiter({ limit: ceiling("verify_per_phone", 10), windowMs: 15 * 60 * 1000, name: "verify/phone" }),
  verifyPerHost:  rateLimiter({ limit: ceiling("verify_per_host", 60),  windowMs: 15 * 60 * 1000, name: "verify/host" }),
  enrol:        rateLimiter({ limit: ceiling("register", 20),       windowMs: 60 * 60 * 1000, name: "enrol" }),
  send:     rateLimiter({ limit: ceiling("send", 20),     windowMs: 60 * 60 * 1000, name: "send" }),
  preview:  rateLimiter({ limit: ceiling("preview", 60),  windowMs: 60 * 1000,      name: "preview" }),
  search:   rateLimiter({ limit: ceiling("search", 120),  windowMs: 60 * 1000,      name: "search" }),
};

// The app sits behind the host's proxy, so X-Forwarded-For carries the real
// client. Set TRUST_PROXY=0 when running it directly, or the header becomes a
// way to invent a new address per request and walk past every limit above.
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";

/* ----------------------------------------------------- security headers --- */

/**
 * Headers every response carries.
 *
 * This is about to be reachable from the open internet rather than from one
 * developer's laptop, and none of these were set.
 *
 * The content policy is strict on purpose, including for styles: the two inline
 * style attributes the app used to generate were moved into the stylesheet so
 * 'unsafe-inline' would not be needed anywhere. A violation logs to the console,
 * and the browser suite fails on any console error, so this cannot rot quietly.
 */
const CONTENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // The favicon is an inline SVG data URI; the globe texture is a same-origin PNG.
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** True when the request reached the proxy over HTTPS. */
const isSecure = (req) =>
  req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";

function harden(response, req) {
  const headers = response.headers;
  headers.set("content-security-policy", CONTENT_POLICY);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("cross-origin-opener-policy", "same-origin");
  // Nothing here needs a camera, a microphone or a location.
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");

  if (isSecure(req)) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  // Anything carrying a session or a phone number must not sit in a shared cache.
  if (new URL(req.url).pathname.startsWith("/api/")) {
    headers.set("cache-control", "no-store");
  }
  return response;
}

/* ------------------------------------------------------------- helpers --- */

function json(data, status = 200, headers = {}) {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
  for (const [name, value] of Object.entries(headers)) {
    // Several Set-Cookie headers have to be appended, not merged into one.
    if (Array.isArray(value)) for (const entry of value) response.headers.append(name, entry);
    else response.headers.set(name, value);
  }
  return response;
}

const fail = (message, status = 400) => json({ error: message }, status);

const cookieToken = (req) => cookie(req, "mp_session");

/**
 * Session cookies. `Secure` is added when the request arrived over HTTPS, so
 * the cookie is never sent in the clear in production but development over
 * plain HTTP still works.
 */
const sessionCookie = (token, req) =>
  `mp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}` +
  (isSecure(req) ? "; Secure" : "");

const enrolmentCookie = (token, req) =>
  `mp_enrol=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600` +
  (isSecure(req) ? "; Secure" : "");

const CLEARED_ENROLMENT = "mp_enrol=; Path=/; Max-Age=0";

function cookie(req, name) {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

const currentUser = (req) => store.userForToken(db, cookieToken(req));

/** City tuples are [name, cc, admin1, lat, lon, population]. */
const cityObject = (c) => ({
  name: c[0],
  country: countries[c[1]] || c[1],
  countryCode: c[1],
  admin: c[2],
  lat: c[3],
  lon: c[4],
  population: c[5],
});

/**
 * Substring city search. `cities` is pre-sorted by population, so scanning in
 * order and taking the first N matches ranks by prominence for free; exact and
 * prefix matches are promoted above interior matches.
 */
function searchCities(query, limit = 12) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const exact = [], prefix = [], contains = [];
  for (let i = 0; i < cities.length; i++) {
    const name = folded[i];
    if (name === q) exact.push(cities[i]);
    else if (name.startsWith(q)) prefix.push(cities[i]);
    else if (name.includes(q)) contains.push(cities[i]);
    if (exact.length + prefix.length >= limit) break;
  }
  return [...exact, ...prefix, ...contains].slice(0, limit).map(cityObject);
}

/**
 * Shape a message row for the client.
 *
 * This is the chokepoint for the app's central rule: until `arrives_at`, the
 * recipient gets the envelope and the courier's live position but never the
 * body. Senders always see what they wrote.
 */
function serializeMessage(row, viewerId, { includeRoute = false } = {}) {
  const arrived = Date.now() >= row.arrives_at;
  const isSender = row.sender_id === viewerId;
  const route = JSON.parse(row.route_json);

  const out = {
    id: row.id,
    direction: isSender ? "sent" : "received",
    correspondent: isSender ? row.recipient_handle : row.sender_handle,
    from: { city: row.from_city, lat: row.from_lat, lon: row.from_lon },
    to: { city: row.to_city, lat: row.to_lat, lon: row.to_lon },
    sentAt: row.sent_at,
    arrivesAt: row.arrives_at,
    readAt: row.read_at,
    arrived,
    totalMetres: row.total_metres,
    runMetres: row.run_metres,
    swimMetres: row.swim_metres,
    totalSeconds: row.total_seconds,
    ascent: route.ascent,
    descent: route.descent,
    peak: route.peak,
    directMetres: route.directMetres,
    detour: route.detour,
    straight: route.straight,
    secondsSaved: route.secondsSaved,
    speedup: route.speedup,
    effectiveSpeed: route.effectiveSpeed,
    straightSpeed: route.straightSpeed,
    body: arrived || isSender ? row.body : null,
    charCount: row.body.length,
  };

  if (!arrived) {
    out.courier = positionAt(route, (Date.now() - row.sent_at) / 1000);
  }
  if (includeRoute) out.route = route;
  return out;
}

/** Resolve a destination from either a registered handle or raw coordinates. */
function resolveDestination(payload) {
  if (payload.toHandle) {
    const user = store.findUserByHandle(db, payload.toHandle);
    if (!user) return { error: `No courier registered as "${payload.toHandle}"` };
    return { point: { lat: user.lat, lon: user.lon }, city: user.city, user };
  }
  const lat = Number(payload.lat), lon = Number(payload.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: "Destination required" };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: "Coordinates out of range" };
  return { point: { lat, lon }, city: payload.city || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
}

/* -------------------------------------------------------------- routes --- */

const routes = {
  /** Country calling codes, so nobody has to remember their own. */
  "GET /api/auth/countries": () => json({ countries: callingCodes() }),

  /**
   * Step one: prove you can receive a message at this number.
   *
   * Signing in and signing up are the same request. That is partly kindness —
   * one field, one button — and partly that a separate sign-up would answer the
   * question "is this number registered?" for anyone who asked.
   */
  "POST /api/auth/request": async (req, server) => {
    const { phone, country } = await req.json();

    const number = normalise(phone, country);
    if (!number.ok) return fail(number.reason);

    const host = clientAddress(req, server, { trustProxy: TRUST_PROXY });
    const byHost = LIMITS.codePerHost.check(host);
    if (!byHost.ok) return tooMany(byHost, "Too many codes requested from here. Try again later.");

    const byPhone = LIMITS.codePerPhone.check(number.e164);
    if (!byPhone.ok) {
      return tooMany(byPhone, "A code has already been sent to that number. Wait a little, or use the one you have.");
    }

    const { code, expiresInSeconds } = await issueCode(db, number.e164);
    try {
      await sms.send({
        to: number.e164,
        // The last line is the WebOTP handshake: origin, then the code. It has
        // to be exactly this shape and exactly last, or Android ignores it and
        // the message is merely readable rather than fillable.
        body:
          `${code} is your Man Power code. It expires in ten minutes.\n\n` +
          `@${OTP_DOMAIN} #${code}`,
      });
    } catch (err) {
      console.error(`Could not send a code to ${maskPhone(number.e164)}: ${err.message}`);
      return fail("Could not send a code to that number just now. Try again shortly.", 502);
    }

    // The normalised number goes back so the next step is unambiguous, and the
    // masked form so the page can show which number it went to.
    //
    // `delivered` says whether a message was actually sent. Without a provider
    // the code goes to the server log, and a page claiming it is "on its way"
    // would be lying to someone staring at a phone that will never buzz.
    return json({
      ok: true,
      phone: number.e164,
      masked: maskPhone(number.e164),
      codeLength: CODE_LENGTH,
      expiresInSeconds,
      delivered: sms.live,
    });
  },

  /**
   * Step two: the code. A known number signs in; an unknown one gets a
   * short-lived enrolment to finish setting up.
   */
  "POST /api/auth/verify": async (req, server) => {
    const { phone, code } = await req.json();

    const number = normalise(phone);
    if (!number.ok) return fail(number.reason);

    const byPhone = LIMITS.verifyPerPhone.check(number.e164);
    if (!byPhone.ok) return tooMany(byPhone, "Too many attempts on that number. Try again shortly.");

    const host = clientAddress(req, server, { trustProxy: TRUST_PROXY });
    const byHost = LIMITS.verifyPerHost.check(host);
    if (!byHost.ok) return tooMany(byHost, "Too many attempts from here. Try again shortly.");

    const result = await verifyCode(db, number.e164, code);
    if (!result.ok) return json({ error: result.reason, attemptsRemaining: result.attemptsRemaining }, 401);

    // Getting in should not spend the allowance meant for people guessing.
    LIMITS.verifyPerPhone.forgive(number.e164);
    LIMITS.verifyPerHost.forgive(host);

    const existing = store.findUserByPhone(db, number.e164);
    if (existing) {
      const token = store.createSession(db, existing.id);
      return json({ user: store.publicUser(existing) }, 200, {
        "set-cookie": sessionCookie(token, req),
      });
    }

    const enrolment = store.createEnrolment(db, number.e164);
    return json({ needsProfile: true, masked: maskPhone(number.e164) }, 200, {
      "set-cookie": enrolmentCookie(enrolment, req),
    });
  },

  /** Step three, for a number nobody has used before: a handle and a home. */
  "POST /api/auth/enrol": async (req, server) => {
    const enrolment = store.enrolmentFor(db, cookie(req, "mp_enrol"));
    if (!enrolment) return fail("That took too long — start again with your number.", 401);

    const allowed = LIMITS.enrol.check(clientAddress(req, server, { trustProxy: TRUST_PROXY }));
    if (!allowed.ok) return tooMany(allowed, "Too many couriers enlisted from here. Try again later.");

    const { handle, city } = await req.json();
    if (!handle || !/^[a-zA-Z0-9_-]{2,24}$/.test(handle))
      return fail("Handle must be 2–24 characters: letters, numbers, dashes or underscores");
    if (!city?.name || !Number.isFinite(city.lat)) return fail("Pick your home city");
    if (store.findUserByHandle(db, handle)) return fail("That handle is taken", 409);

    // The number could have been claimed since the code was verified.
    if (store.findUserByPhone(db, enrolment.phone)) {
      store.consumeEnrolment(db, enrolment.token);
      return fail("That number is already enlisted. Start again to sign in.", 409);
    }

    const user = store.createUser(db, {
      handle,
      phone: enrolment.phone,
      city: city.name,
      country: city.country || "",
      lat: city.lat,
      lon: city.lon,
    });
    store.consumeEnrolment(db, enrolment.token);

    const token = store.createSession(db, user.id);
    return json({ user: store.publicUser(user) }, 200, {
      "set-cookie": [sessionCookie(token, req), CLEARED_ENROLMENT],
    });
  },

  "POST /api/logout": (req) => {
    store.destroySession(db, cookieToken(req));
    return json({ ok: true }, 200, { "set-cookie": "mp_session=; Path=/; Max-Age=0" });
  },

  "GET /api/me": (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);
    return json({
      // Only the owner sees their own number, and only masked.
      user: { ...store.publicUser(user), phone: maskPhone(user.phone) },
      unread: store.unreadCount(db, user.id),
      couriers: store.listOtherUsers(db, user.id),
    });
  },

  "POST /api/me/location": async (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);
    const { city } = await req.json();
    if (!city?.name || !Number.isFinite(city.lat)) return fail("Pick a city");
    const updated = store.updateUserLocation(db, user.id, {
      city: city.name, country: city.country || "", lat: city.lat, lon: city.lon,
    });
    return json({ user: store.publicUser(updated) });
  },

  "GET /api/cities": (req, server) => {
    const allowed = LIMITS.search.check(clientAddress(req, server, { trustProxy: TRUST_PROXY }));
    if (!allowed.ok) return tooMany(allowed, "Slow down a moment.");

    const q = new URL(req.url).searchParams.get("q") || "";
    return json({ results: searchCities(q) });
  },

  "GET /api/records": () => json({ running: RUN_LADDER, swimming: SWIM_LADDER }),

  /** The public half of the VAPID keypair, which the browser needs to subscribe. */
  "GET /api/push/key": () => json({ publicKey: vapid.publicKey }),

  "POST /api/push/subscribe": async (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);

    const subscription = await req.json();
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return fail("Incomplete push subscription");
    }
    store.saveSubscription(db, user.id, subscription);
    return json({ ok: true });
  },

  "POST /api/push/unsubscribe": async (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);
    const { endpoint } = await req.json();
    if (endpoint) store.deleteSubscription(db, endpoint);
    return json({ ok: true });
  },

  /**
   * Health, for monitoring. Reports the clock explicitly: a service whose whole
   * promise is a timer should say out loud whether it still knows the time.
   */
  "GET /api/health": () => {
    const counts = db
      .query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN arrives_at > ? THEN 1 ELSE 0 END) AS inFlight
           FROM messages`
      )
      .get(Date.now());

    const backlog = delivery.backlog();
    // A growing backlog means arrivals are landing and not being announced,
    // which is the failure this service most needs to notice about itself.
    const healthy = clock.last.ok !== false && backlog < 100;

    return json(
      {
        ok: healthy,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        clock: clock.last,
        messages: { total: counts.total, inFlight: counts.inFlight ?? 0 },
        couriers: db.query("SELECT COUNT(*) AS n FROM users").get().n,
        delivery: { ...delivery.stats, backlog, subscriptions: store.countSubscriptions(db) },
        sms: { transport: sms.name, live: sms.live },
      },
      healthy ? 200 : 503
    );
  },

  /** Quote a journey without sending anything. */
  "POST /api/preview": async (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);

    // Quoting runs the pathfinder, which is the most expensive thing here.
    const allowed = LIMITS.preview.check(`user:${user.id}`);
    if (!allowed.ok) return tooMany(allowed, "Too many routes at once. Give it a second.");

    const payload = await req.json();
    const dest = resolveDestination(payload);
    if (dest.error) return fail(dest.error);

    const route = buildRoute(world, { lat: user.lat, lon: user.lon }, dest.point);
    return json({
      from: { city: user.city, lat: user.lat, lon: user.lon },
      to: { city: dest.city, ...dest.point },
      route,
    });
  },

  "POST /api/messages": async (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);

    const allowed = LIMITS.send.check(`user:${user.id}`);
    if (!allowed.ok) {
      return tooMany(allowed, "You have dispatched a lot of couriers. Let some of them arrive first.");
    }

    const { toHandle, body } = await req.json();

    const text = String(body || "").trim();
    if (!text) return fail("Write something for the courier to carry");
    if (text.length > 2000) return fail("Messages are limited to 2000 characters");

    const recipient = store.findUserByHandle(db, toHandle || "");
    if (!recipient) return fail(`No courier registered as "${toHandle}"`);
    if (recipient.id === user.id) return fail("You cannot send a message to yourself");

    const from = { lat: user.lat, lon: user.lon };
    const to = { lat: recipient.lat, lon: recipient.lon };
    const route = buildRoute(world, from, to);
    if (route.totalSeconds <= 0) return fail("You are both in the same place — just talk");

    const sentAt = Date.now();
    const row = store.insertMessage(db, {
      senderId: user.id, recipientId: recipient.id, body: text,
      sentAt, arrivesAt: sentAt + Math.round(route.totalSeconds * 1000),
      fromCity: user.city, fromLat: user.lat, fromLon: user.lon,
      toCity: recipient.city, toLat: recipient.lat, toLon: recipient.lon,
      totalMetres: route.totalMetres, runMetres: route.runMetres,
      swimMetres: route.swimMetres, totalSeconds: route.totalSeconds,
      routeJson: JSON.stringify(route),
    });

    row.recipient_handle = recipient.handle;
    row.sender_handle = user.handle;
    return json({ message: serializeMessage(row, user.id, { includeRoute: true }) });
  },

  "GET /api/inbox": (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);
    return json({ messages: store.inboxFor(db, user.id).map((m) => serializeMessage(m, user.id)) });
  },

  "GET /api/outbox": (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);
    return json({ messages: store.outboxFor(db, user.id).map((m) => serializeMessage(m, user.id)) });
  },
};

/** GET /api/messages/:id — full detail, including the route polyline. */
function messageDetail(req, id) {
  const user = currentUser(req);
  if (!user) return fail("Not signed in", 401);
  const row = store.messageForUser(db, Number(id), user.id);
  if (!row) return fail("No such message", 404);
  if (Date.now() >= row.arrives_at) store.markRead(db, row.id, user.id);
  return json({ message: serializeMessage(row, user.id, { includeRoute: true }) });
}

/* -------------------------------------------------------------- server --- */

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,

  // Bun hands the server in, which is how a handler reaches the peer address.
  async fetch(req, server) {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;

    if (routes[key]) {
      try {
        return harden(await routes[key](req, server), req);
      } catch (err) {
        console.error(key, err);
        return harden(fail("Something went wrong on the server", 500), req);
      }
    }

    const detail = url.pathname.match(/^\/api\/messages\/(\d+)$/);
    if (detail && req.method === "GET") return harden(messageDetail(req, detail[1]), req);
    if (url.pathname.startsWith("/api/")) return harden(fail("Not found", 404), req);

    // Shared great-circle math, so the browser animates the courier with the
    // same code the server used to time the journey.
    if (url.pathname === "/sphere.js") {
      return harden(new Response(Bun.file("src/sphere.js"), {
        headers: { "content-type": "text/javascript" },
      }), req);
    }

    // Static files, with index.html as the fallback for client-side routes.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`public${path}`);
    if (await file.exists()) return harden(new Response(file), req);
    return harden(new Response(Bun.file("public/index.html")), req);
  },
});

console.log(`Man Power running at http://localhost:${server.port}`);

/**
 * server.js — Man Power HTTP server.
 *
 * Carrier-pigeon messaging, except the courier is the fastest human alive.
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

// Nothing else notices that a courier has arrived, so this does.
const delivery = startDelivery(db, { channels: [journalChannel(), pushChannel(db)] });

const clock = monitorClock({
  onResult: (result) => {
    const line = describeClock(result);
    if (result.ok === false) console.error(line);
    else console.log(line);
  },
});

/* ------------------------------------------------------------- helpers --- */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const fail = (message, status = 400) => json({ error: message }, status);

function cookieToken(req) {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "mp_session") return decodeURIComponent(v.join("="));
  }
  return null;
}

const sessionCookie = (token) =>
  `mp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

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
  "POST /api/register": async (req) => {
    const { handle, password, city } = await req.json();
    if (!handle || !/^[a-zA-Z0-9_-]{2,24}$/.test(handle))
      return fail("Handle must be 2–24 characters: letters, numbers, dashes or underscores");
    if (!password || password.length < 6) return fail("Password must be at least 6 characters");
    if (!city?.name || !Number.isFinite(city.lat)) return fail("Pick your home city");
    if (store.findUserByHandle(db, handle)) return fail("That handle is taken", 409);

    const user = await store.createUser(db, {
      handle, password,
      city: city.name, country: city.country || "",
      lat: city.lat, lon: city.lon,
    });
    const token = store.createSession(db, user.id);
    return json({ user: store.publicUser(user) }, 200, { "set-cookie": sessionCookie(token) });
  },

  "POST /api/login": async (req) => {
    const { handle, password } = await req.json();
    const user = store.findUserByHandle(db, handle || "");
    if (!user || !(await store.verifyPassword(user, password || "")))
      return fail("Wrong handle or password", 401);
    const token = store.createSession(db, user.id);
    return json({ user: store.publicUser(user) }, 200, { "set-cookie": sessionCookie(token) });
  },

  "POST /api/logout": (req) => {
    store.destroySession(db, cookieToken(req));
    return json({ ok: true }, 200, { "set-cookie": "mp_session=; Path=/; Max-Age=0" });
  },

  "GET /api/me": (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);
    return json({
      user: store.publicUser(user),
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

  "GET /api/cities": (req) => {
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
      },
      healthy ? 200 : 503
    );
  },

  /** Quote a journey without sending anything. */
  "POST /api/preview": async (req) => {
    const user = currentUser(req);
    if (!user) return fail("Not signed in", 401);
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

  async fetch(req) {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;

    if (routes[key]) {
      try {
        return await routes[key](req);
      } catch (err) {
        console.error(key, err);
        return fail("Something went wrong on the server", 500);
      }
    }

    const detail = url.pathname.match(/^\/api\/messages\/(\d+)$/);
    if (detail && req.method === "GET") return messageDetail(req, detail[1]);
    if (url.pathname.startsWith("/api/")) return fail("Not found", 404);

    // Shared great-circle math, so the browser animates the courier with the
    // same code the server used to time the journey.
    if (url.pathname === "/sphere.js") {
      return new Response(Bun.file("src/sphere.js"), {
        headers: { "content-type": "text/javascript" },
      });
    }

    // Static files, with index.html as the fallback for client-side routes.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`public${path}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file("public/index.html"));
  },
});

console.log(`Man Power running at http://localhost:${server.port}`);

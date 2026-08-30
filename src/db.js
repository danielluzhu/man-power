/**
 * db.js — SQLite storage for couriers, messages and sessions.
 *
 * The one rule the schema exists to enforce: a message body is not readable
 * until the courier arrives. Every message stores `arrives_at` at send time,
 * computed once from the route, and the read paths below refuse to return the
 * body before then.
 */

import { Database } from "bun:sqlite";

export function openDatabase(path = "data/manpower.sqlite") {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      city          TEXT NOT NULL,
      country       TEXT NOT NULL,
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    -- Sign-in codes, stored as an HMAC and short-lived. See src/verification.js.
    CREATE TABLE IF NOT EXISTS verification_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER
    );

    -- Where to reach a courier when something lands. One row per browser, so a
    -- person with a laptop and a phone is reachable on both.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      failures   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body          TEXT NOT NULL,
      sent_at       INTEGER NOT NULL,
      arrives_at    INTEGER NOT NULL,
      read_at       INTEGER,
      from_city     TEXT NOT NULL,
      from_lat      REAL NOT NULL,
      from_lon      REAL NOT NULL,
      to_city       TEXT NOT NULL,
      to_lat        REAL NOT NULL,
      to_lon        REAL NOT NULL,
      notified_at   INTEGER,
      total_metres  REAL NOT NULL,
      run_metres    REAL NOT NULL,
      swim_metres   REAL NOT NULL,
      total_seconds REAL NOT NULL,
      route_json    TEXT NOT NULL
    );

  `);

  // Migrations run between the tables and the indexes: an existing database
  // reaches this point without the columns some indexes are defined over.
  migrate(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, arrives_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages(sender_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_user           ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_codes_phone          ON verification_codes(phone, created_at);

    -- The delivery worker's hot query: what has landed and not been announced.
    CREATE INDEX IF NOT EXISTS idx_messages_pending
      ON messages(arrives_at) WHERE notified_at IS NULL;
  `);

  return db;
}

/**
 * Bring an existing database up to the schema above.
 *
 * Deliberately additive and idempotent: it compares the columns that are there
 * against the ones that should be, and adds what is missing. A service holding
 * messages that are weeks from arriving cannot be migrated by dropping and
 * recreating anything, so the only safe migration is one that adds.
 */
function migrate(db) {
  const expected = {
    messages: {
      notified_at: "INTEGER",
    },
  };

  for (const [table, columns] of Object.entries(expected)) {
    const present = new Set(db.query(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (present.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      console.log(`Migrated: added ${table}.${name}`);
    }
  }
}

const now = () => Date.now();

/* ---------------------------------------------------------------- users --- */

export async function createUser(db, { handle, password, city, country, lat, lon }) {
  const hash = await Bun.password.hash(password);
  const stmt = db.query(
    `INSERT INTO users (handle, password_hash, city, country, lat, lon, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  );
  return stmt.get(handle.trim(), hash, city, country, lat, lon, now());
}

export function findUserByHandle(db, handle) {
  return db.query("SELECT * FROM users WHERE handle = ?").get(String(handle).trim());
}

export function findUserById(db, id) {
  return db.query("SELECT * FROM users WHERE id = ?").get(id);
}

export async function verifyPassword(user, password) {
  return Bun.password.verify(password, user.password_hash);
}

export function updateUserLocation(db, userId, { city, country, lat, lon }) {
  db.query("UPDATE users SET city = ?, country = ?, lat = ?, lon = ? WHERE id = ?")
    .run(city, country, lat, lon, userId);
  return findUserById(db, userId);
}

/** Everyone else, so the compose screen can list who you can write to. */
export function listOtherUsers(db, userId) {
  return db
    .query("SELECT id, handle, city, country, lat, lon FROM users WHERE id != ? ORDER BY handle")
    .all(userId);
}

/** Strip the password hash before anything leaves the server. */
export const publicUser = (u) =>
  u && { id: u.id, handle: u.handle, city: u.city, country: u.country, lat: u.lat, lon: u.lon };

/* ------------------------------------------------------------- sessions --- */

export function createSession(db, userId) {
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  db.query("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, now());
  return token;
}

export function userForToken(db, token) {
  if (!token) return null;
  return db
    .query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
    .get(token);
}

export function destroySession(db, token) {
  db.query("DELETE FROM sessions WHERE token = ?").run(token);
}

/* ------------------------------------------------------------- messages --- */

export function insertMessage(db, msg) {
  return db
    .query(
      `INSERT INTO messages (
         sender_id, recipient_id, body, sent_at, arrives_at,
         from_city, from_lat, from_lon, to_city, to_lat, to_lon,
         total_metres, run_metres, swim_metres, total_seconds, route_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(
      msg.senderId, msg.recipientId, msg.body, msg.sentAt, msg.arrivesAt,
      msg.fromCity, msg.fromLat, msg.fromLon, msg.toCity, msg.toLat, msg.toLon,
      msg.totalMetres, msg.runMetres, msg.swimMetres, msg.totalSeconds, msg.routeJson
    );
}

export function inboxFor(db, userId) {
  return db
    .query(
      `SELECT m.*, u.handle AS sender_handle
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.recipient_id = ? ORDER BY m.arrives_at ASC`
    )
    .all(userId);
}

export function outboxFor(db, userId) {
  return db
    .query(
      `SELECT m.*, u.handle AS recipient_handle
         FROM messages m JOIN users u ON u.id = m.recipient_id
        WHERE m.sender_id = ? ORDER BY m.sent_at DESC`
    )
    .all(userId);
}

export function messageForUser(db, id, userId) {
  return db
    .query(
      `SELECT m.*, s.handle AS sender_handle, r.handle AS recipient_handle
         FROM messages m
         JOIN users s ON s.id = m.sender_id
         JOIN users r ON r.id = m.recipient_id
        WHERE m.id = ? AND (m.sender_id = ? OR m.recipient_id = ?)`
    )
    .get(id, userId, userId);
}

export function markRead(db, id, userId) {
  db.query(
    "UPDATE messages SET read_at = ? WHERE id = ? AND recipient_id = ? AND read_at IS NULL AND arrives_at <= ?"
  ).run(now(), id, userId, now());
}

/* ----------------------------------------------------- push subscriptions --- */

/**
 * Remember where to reach someone. Keyed on the endpoint, so re-subscribing the
 * same browser updates rather than duplicates — browsers hand out a new key
 * pair for the same endpoint from time to time.
 */
export function saveSubscription(db, userId, { endpoint, keys }) {
  db.query(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at, failures)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh  = excluded.p256dh,
       auth    = excluded.auth,
       failures = 0`
  ).run(endpoint, userId, keys.p256dh, keys.auth, now());
}

export function subscriptionsFor(db, userId) {
  return db.query("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId);
}

export function deleteSubscription(db, endpoint) {
  return db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes;
}

export function countSubscriptions(db) {
  return db.query("SELECT COUNT(*) AS n FROM push_subscriptions").get().n;
}

/* ------------------------------------------------------------- delivery --- */

/**
 * Messages whose courier has arrived but whose arrival has not been announced.
 *
 * Ordered oldest first and capped, so a backlog — the service was down for a
 * week, or a database was just restored — drains steadily instead of firing
 * every notification at once.
 */
export function pendingArrivals(db, limit = 50) {
  return db
    .query(
      `SELECT m.id, m.recipient_id, m.sender_id, m.arrives_at, m.from_city, m.to_city,
              m.total_seconds, m.total_metres,
              s.handle AS sender_handle,
              r.handle AS recipient_handle
         FROM messages m
         JOIN users s ON s.id = m.sender_id
         JOIN users r ON r.id = m.recipient_id
        WHERE m.arrives_at <= ? AND m.notified_at IS NULL
        ORDER BY m.arrives_at ASC
        LIMIT ?`
    )
    .all(now(), limit);
}

/** Record that an arrival has been announced, so it is not announced twice. */
export function markNotified(db, id) {
  return db
    .query("UPDATE messages SET notified_at = ? WHERE id = ? AND notified_at IS NULL")
    .run(now(), id).changes;
}

/** How far behind the delivery worker is, for /api/health. */
export function deliveryBacklog(db) {
  return db
    .query("SELECT COUNT(*) AS n FROM messages WHERE arrives_at <= ? AND notified_at IS NULL")
    .get(now()).n;
}

/** Delivered but unread — what the inbox badge counts. */
export function unreadCount(db, userId) {
  return db
    .query(
      "SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND arrives_at <= ? AND read_at IS NULL"
    )
    .get(userId, now()).n;
}

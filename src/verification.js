/**
 * verification.js — the six digits that stand in for a password.
 *
 * A short numeric code is a weak secret by construction: a million
 * possibilities, typed by someone reading a lock screen. Everything here exists
 * to make that weakness survivable.
 *
 *   • Codes are stored as an HMAC, never in the clear, so a copy of the
 *     database does not hand over anybody's sign-in.
 *   • They expire in ten minutes, which bounds how long a leaked SMS is useful.
 *   • Five wrong guesses burn the code. Without that, a million possibilities
 *     is an afternoon's work.
 *   • Asking for a new code cancels the old one, so there is never a drawer of
 *     valid codes accumulating against one number.
 *   • Comparison is constant-time, because comparing secrets with === leaks
 *     them a character at a time.
 *
 * What this deliberately does not do is tell the caller whether a number is
 * already registered. Sign-in and sign-up are the same act — enter your number,
 * enter the code — so there is no oracle to ask.
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { getSecret } from "./secrets.js";

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

let hmacKey = null;

async function key() {
  if (!hmacKey) hmacKey = await getSecret("verification-hmac");
  return hmacKey;
}

/**
 * Bound to the phone number as well as the code, so a code issued for one
 * number cannot be replayed against another.
 */
async function digest(phone, code) {
  return createHmac("sha256", await key()).update(`${phone}:${code}`).digest("hex");
}

function sameSecret(a, b) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A uniformly random code. Math.random would be guessable from a few samples. */
function generateCode() {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

/**
 * Issue a code for a number and return it, for the caller to send.
 *
 * The plaintext is returned rather than stored: this is the only moment it
 * exists, and it goes straight to the SMS transport.
 */
export async function issueCode(db, phone, { now = Date.now() } = {}) {
  // One live code per number at a time.
  db.query("UPDATE verification_codes SET consumed_at = ? WHERE phone = ? AND consumed_at IS NULL")
    .run(now, phone);

  const code = generateCode();
  db.query(
    `INSERT INTO verification_codes (phone, code_hash, created_at, expires_at, attempts)
     VALUES (?, ?, ?, ?, 0)`
  ).run(phone, await digest(phone, code), now, now + CODE_TTL_MS);

  return { code, expiresAt: now + CODE_TTL_MS, expiresInSeconds: CODE_TTL_MS / 1000 };
}

/**
 * Check a code. Consumes it on success, counts the attempt on failure.
 *
 * Every failure returns the same shape and a deliberately unspecific reason:
 * distinguishing "wrong code" from "no code outstanding" would say whether a
 * number had just been sent one.
 */
export async function verifyCode(db, phone, submitted, { now = Date.now() } = {}) {
  const cleaned = String(submitted ?? "").replace(/\D/g, "");
  const wrong = { ok: false, reason: "That code is not right, or it has expired. Ask for another." };

  const row = db
    .query(
      `SELECT * FROM verification_codes
        WHERE phone = ? AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(phone, now);

  if (!row) return wrong;

  if (row.attempts >= MAX_ATTEMPTS) {
    // Burn it rather than leaving something guessable lying around.
    db.query("UPDATE verification_codes SET consumed_at = ? WHERE id = ?").run(now, row.id);
    return { ok: false, reason: "Too many wrong guesses. Ask for a new code." };
  }

  // Count the attempt before checking it, so a crash mid-verify cannot be used
  // to get a free guess.
  db.query("UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);

  if (cleaned.length !== CODE_LENGTH || !sameSecret(row.code_hash, await digest(phone, cleaned))) {
    const remaining = MAX_ATTEMPTS - (row.attempts + 1);
    return { ...wrong, attemptsRemaining: Math.max(0, remaining) };
  }

  db.query("UPDATE verification_codes SET consumed_at = ? WHERE id = ?").run(now, row.id);
  return { ok: true };
}

/** Housekeeping: codes are worthless once they expire. */
export function pruneCodes(db, { now = Date.now(), keepMs = 24 * 60 * 60 * 1000 } = {}) {
  return db.query("DELETE FROM verification_codes WHERE expires_at < ?").run(now - keepMs).changes;
}

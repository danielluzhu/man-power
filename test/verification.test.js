/**
 * Verification code tests.
 *
 * A six-digit code is a weak secret by construction — a million possibilities,
 * typed off a lock screen. These pin the things that make that survivable, each
 * of which is a real attack if it is missing.
 */

import { expect, test, describe, beforeAll } from "bun:test";
import { openDatabase } from "../src/db.js";
import {
  issueCode, verifyCode, pruneCodes, CODE_LENGTH, CODE_TTL_MS, MAX_ATTEMPTS,
} from "../src/verification.js";

const PHONE = "+447911123456";
const OTHER = "+14155552671";

let db;
beforeAll(() => {
  process.env.SECRETS_PATH = `/tmp/secrets-test-${Date.now()}.json`;
  db = openDatabase(":memory:");
});

describe("issuing", () => {
  test("produces a code of the stated length, all digits", async () => {
    const { code } = await issueCode(db, PHONE);
    expect(code).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`));
  });

  test("codes differ from one another", async () => {
    const codes = new Set();
    for (let i = 0; i < 20; i++) codes.add((await issueCode(db, PHONE)).code);
    // Twenty draws from a million; a collision would mean it is not random.
    expect(codes.size).toBe(20);
  });

  test("the code is never stored in the clear", async () => {
    const { code } = await issueCode(db, PHONE);
    const rows = db.query("SELECT code_hash FROM verification_codes").all();
    for (const row of rows) expect(row.code_hash).not.toContain(code);
  });

  test("asking for another cancels the one before it", async () => {
    const first = await issueCode(db, PHONE);
    const second = await issueCode(db, PHONE);

    expect((await verifyCode(db, PHONE, first.code)).ok).toBe(false);
    expect((await verifyCode(db, PHONE, second.code)).ok).toBe(true);
  });
});

describe("verifying", () => {
  test("the right code is accepted", async () => {
    const { code } = await issueCode(db, PHONE);
    expect(await verifyCode(db, PHONE, code)).toEqual({ ok: true });
  });

  test("a code works only once", async () => {
    const { code } = await issueCode(db, PHONE);
    expect((await verifyCode(db, PHONE, code)).ok).toBe(true);
    expect((await verifyCode(db, PHONE, code)).ok).toBe(false);
  });

  test("a code issued for one number cannot be used on another", async () => {
    const { code } = await issueCode(db, PHONE);
    expect((await verifyCode(db, OTHER, code)).ok).toBe(false);
    // And it is still good for the number it was meant for.
    expect((await verifyCode(db, PHONE, code)).ok).toBe(true);
  });

  test("spaces and punctuation in what was typed are ignored", async () => {
    const { code } = await issueCode(db, PHONE);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await verifyCode(db, PHONE, spaced)).ok).toBe(true);
  });

  test("an expired code is refused", async () => {
    const now = Date.now();
    const { code } = await issueCode(db, PHONE, { now });
    const later = now + CODE_TTL_MS + 1000;
    expect((await verifyCode(db, PHONE, code, { now: later })).ok).toBe(false);
  });

  test("nothing outstanding is refused without saying so", async () => {
    const fresh = "+34600123456";
    const result = await verifyCode(db, fresh, "123456");
    expect(result.ok).toBe(false);
    // Saying "no code outstanding" would reveal whether one had just been sent.
    expect(result.reason).not.toMatch(/no code|not found|unknown/i);
  });
});

describe("guessing", () => {
  test("the code burns after too many wrong attempts", async () => {
    const { code } = await issueCode(db, PHONE);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect((await verifyCode(db, PHONE, wrong)).ok).toBe(false);
    }
    // Even the correct code is now worthless — a million guesses is otherwise
    // an afternoon's work.
    expect((await verifyCode(db, PHONE, code)).ok).toBe(false);
  });

  test("attempts remaining are counted down", async () => {
    const { code } = await issueCode(db, PHONE);
    const wrong = code === "000000" ? "111111" : "000000";

    const first = await verifyCode(db, PHONE, wrong);
    const second = await verifyCode(db, PHONE, wrong);
    expect(first.attemptsRemaining).toBe(MAX_ATTEMPTS - 1);
    expect(second.attemptsRemaining).toBe(MAX_ATTEMPTS - 2);
  });

  test("a wrong length is refused without spending a free guess", async () => {
    const { code } = await issueCode(db, PHONE);
    await verifyCode(db, PHONE, "12");
    await verifyCode(db, PHONE, "1234567890");
    // Those still counted as attempts; the real code must survive them.
    expect((await verifyCode(db, PHONE, code)).ok).toBe(true);
  });
});

describe("housekeeping", () => {
  test("long-expired codes are cleared out", async () => {
    const ancient = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await issueCode(db, "+34600999888", { now: ancient });
    const removed = pruneCodes(db);
    expect(removed).toBeGreaterThan(0);
  });
});

/**
 * phone.js — turning what someone typed into an identity.
 *
 * A phone number is now the account, which makes normalising it a correctness
 * problem rather than a formatting one. "+44 7911 123456", "07911 123456" and
 * "00447911123456" are one person; if they normalise differently, that person
 * gets three accounts and loses two of them. Numbering plans are genuinely
 * irregular — variable-length country codes, national trunk prefixes that are
 * dropped internationally, ranges reserved and never assigned — so this leans
 * on libphonenumber rather than a regular expression that looks about right.
 *
 * Everything is stored and compared in E.164 (+ country code, then digits, no
 * spaces). That is the only form guaranteed to be unique worldwide.
 */

import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from "libphonenumber-js";

/**
 * Normalise typed input to E.164.
 *
 * `defaultCountry` lets someone enter a local number without the country code,
 * which is how most people write their own. It is ignored when the input
 * already starts with +.
 */
export function normalise(input, defaultCountry) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, reason: "Enter your phone number." };

  // "00" is the international prefix in much of the world; libphonenumber wants
  // the + form.
  const cleaned = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(cleaned, cleaned.startsWith("+") ? undefined : defaultCountry);
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      ok: false,
      reason: cleaned.startsWith("+")
        ? "That does not look like a phone number."
        : "Add your country code, starting with +.",
    };
  }
  if (!parsed.isValid()) {
    return { ok: false, reason: "That number is not one this country issues." };
  }

  // Landlines cannot receive the code, so there is no point accepting one.
  const type = parsed.getType();
  if (type && type !== "MOBILE" && type !== "FIXED_LINE_OR_MOBILE") {
    return { ok: false, reason: "That looks like a landline. A mobile number is needed for the code." };
  }

  return {
    ok: true,
    e164: parsed.number,
    country: parsed.country ?? null,
    national: parsed.formatNational(),
    international: parsed.formatInternational(),
  };
}

/**
 * A number safe to show back to its owner: enough to recognise, not enough to
 * be useful to anyone reading over a shoulder or a log.
 */
export function mask(e164) {
  const parsed = parsePhoneNumberFromString(String(e164 ?? ""));
  if (!parsed) return "·····";
  const digits = parsed.nationalNumber;
  const tail = digits.slice(-3);
  return `+${parsed.countryCallingCode} ${"·".repeat(Math.max(2, digits.length - 3))}${tail}`;
}

/** Country codes for a picker, so nobody has to remember their own. */
export function countries() {
  return getCountries()
    .map((code) => ({ code, callingCode: `+${getCountryCallingCode(code)}` }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

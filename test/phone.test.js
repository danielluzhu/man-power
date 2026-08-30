/**
 * Phone normalisation tests.
 *
 * A phone number is the account, so the property that matters is not "does this
 * parse" but "do all the ways one person writes their own number collapse to
 * exactly one identity". If they do not, that person ends up with several
 * accounts and loses the messages in all but one.
 */

import { expect, test, describe } from "bun:test";
import { normalise, mask, countries } from "../src/phone.js";

describe("one person, one identity", () => {
  test("every way of writing a UK mobile normalises the same", () => {
    const forms = [
      ["+447911123456", undefined],
      ["+44 7911 123456", undefined],
      ["00447911123456", undefined],
      ["07911123456", "GB"],
      ["07911 123456", "GB"],
      ["  +44 (0) 7911 123456  ", undefined],
    ];
    const normalised = new Set(forms.map(([input, country]) => normalise(input, country).e164));
    expect([...normalised]).toEqual(["+447911123456"]);
  });

  test("a national number needs its country to be unambiguous", () => {
    // The same digits are a different person in a different country.
    expect(normalise("0600123456", "FR").e164).toBe("+33600123456");
    expect(normalise("0600123456", "NL").e164).toBe("+31600123456");
  });

  test("results are always E.164 — a leading plus and digits only", () => {
    for (const input of ["+1 415 555 2671", "+34 600 123 456", "+254 712 345 678"]) {
      expect(normalise(input).e164).toMatch(/^\+[1-9]\d{6,14}$/);
    }
  });
});

describe("what is rejected", () => {
  test("nothing at all", () => {
    for (const input of ["", "   ", null, undefined]) {
      expect(normalise(input).ok).toBe(false);
    }
  });

  test("a number with no country code and no country to assume", () => {
    expect(normalise("5551234").ok).toBe(false);
  });

  test("digits that no numbering plan issues", () => {
    expect(normalise("+1 000 000 0000").ok).toBe(false);
    expect(normalise("+99999999999999").ok).toBe(false);
  });

  test("a landline, which cannot receive the code", () => {
    const result = normalise("+442071838750"); // a London landline
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/landline/i);
  });

  test("every rejection explains itself", () => {
    for (const input of ["", "5551234", "+1 000 000 0000", "+442071838750"]) {
      const result = normalise(input);
      expect(result.ok).toBe(false);
      expect(result.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("showing a number back", () => {
  test("keeps the country and the last three digits, hides the rest", () => {
    const masked = mask("+447911123456");
    expect(masked).toContain("+44");
    expect(masked).toContain("456");
    expect(masked).not.toContain("7911");
    expect(masked).not.toContain("123");
  });

  test("never returns the number it was given", () => {
    for (const number of ["+14155552671", "+34600123456", "+254712345678"]) {
      expect(mask(number)).not.toContain(number.replace("+", ""));
    }
  });

  test("copes with rubbish rather than throwing", () => {
    expect(() => mask("nonsense")).not.toThrow();
    expect(() => mask(null)).not.toThrow();
  });
});

describe("country list", () => {
  test("covers the world and carries calling codes", () => {
    const list = countries();
    expect(list.length).toBeGreaterThan(200);
    expect(list.find((c) => c.code === "GB").callingCode).toBe("+44");
    expect(list.find((c) => c.code === "KE").callingCode).toBe("+254");
  });
});

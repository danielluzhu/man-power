/**
 * The shape of the sign-in text message.
 *
 * The last line is a handshake with the browser, not decoration: WebOTP only
 * offers a code to a page when the message names that page's exact origin and
 * the line comes last. Get either wrong and nothing breaks visibly — the code
 * still arrives, it just stops filling itself in, which is the sort of
 * regression that survives for months.
 */

import { expect, test, describe } from "bun:test";

/** Mirrors the body built in server.js. */
const smsBody = (code, host) =>
  `${code} is your Man Power code. It expires in ten minutes.\n\n@${host} #${code}`;

describe("WebOTP handshake", () => {
  const host = "man-4321.another.ac";
  const body = smsBody("481920", host);

  test("the code is readable by a person at the start", () => {
    expect(body.startsWith("481920 is your Man Power code")).toBe(true);
  });

  test("the handshake is the very last line", () => {
    const lines = body.split("\n").filter(Boolean);
    expect(lines.at(-1)).toBe(`@${host} #481920`);
  });

  test("it carries the origin and the code, in that order", () => {
    expect(body).toMatch(/@[a-z0-9.-]+ #\d{6}$/);
  });

  test("the code in the handshake matches the one in the text", () => {
    const [, spoken] = body.match(/^(\d{6}) is your/);
    const [, handshake] = body.match(/#(\d{6})$/);
    expect(handshake).toBe(spoken);
  });

  test("the origin is a bare host, with no scheme or path", () => {
    const [, named] = body.match(/@(\S+) #/);
    expect(named).not.toMatch(/^https?:/);
    expect(named).not.toContain("/");
  });
});

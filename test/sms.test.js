/**
 * SMS provider tests.
 *
 * No account here, and no network, so what these check is the part that is
 * actually mine: the request each provider is handed, and what happens when it
 * says no. Both matter more than they look.
 *
 * Credentials that appear to work and do not are the expensive failure in this
 * system — the app starts, the page says a code is on its way, and nobody finds
 * out until someone waits for a text that is sitting in a log.
 */

import { expect, test, describe } from "bun:test";
import { smsTransport, twilioTransport, vonageTransport, journalTransport } from "../src/sms.js";

/** Stands in for the network, recording the request and replying to order. */
function recorder(reply = { ok: true, status: 201, json: async () => ({}) }) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options, body: options.body?.toString() });
    return { ...reply, json: reply.json ?? (async () => ({})) };
  };
  return { calls, fetch };
}

const TWILIO = { accountSid: "AC123", authToken: "secret", from: "+15550001111" };
const VONAGE = { apiKey: "key123", apiSecret: "secret", from: "ManPower" };

describe("choosing a provider", () => {
  test("nothing configured means codes go to the log", () => {
    const transport = smsTransport({});
    expect(transport.name).toBe("journal");
    expect(transport.live).toBe(false);
  });

  test("a full set of credentials selects that provider", () => {
    expect(smsTransport({
      TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+1555",
    }).name).toBe("twilio");

    expect(smsTransport({
      VONAGE_API_KEY: "k", VONAGE_API_SECRET: "s", VONAGE_FROM: "MP",
    }).name).toBe("vonage");
  });

  test("a half-configured provider refuses to start, and says what is missing", () => {
    // Falling back to the log here would look like it works, right up until
    // somebody waits for a text that never comes.
    expect(() => smsTransport({ TWILIO_ACCOUNT_SID: "AC1" })).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => smsTransport({ VONAGE_API_KEY: "k", VONAGE_API_SECRET: "s" })).toThrow(/VONAGE_FROM/);
  });

  test("a live provider is marked live, so the UI can stop promising delivery", () => {
    expect(journalTransport().live).toBe(false);
    expect(smsTransport({ TWILIO_ACCOUNT_SID: "A", TWILIO_AUTH_TOKEN: "B", TWILIO_FROM: "C" }).live).toBe(true);
  });
});

describe("Twilio", () => {
  test("posts the message to the account's endpoint with basic auth", async () => {
    const { calls, fetch } = recorder();
    await twilioTransport({ ...TWILIO, fetch }).send({ to: "+447911123456", body: "123456 is your code" });

    const [call] = calls;
    expect(call.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(call.options.method).toBe("POST");
    expect(call.options.headers.authorization)
      .toBe(`Basic ${Buffer.from("AC123:secret").toString("base64")}`);

    const form = new URLSearchParams(call.body);
    expect(form.get("To")).toBe("+447911123456");
    expect(form.get("From")).toBe("+15550001111");
    expect(form.get("Body")).toBe("123456 is your code");
  });

  test("surfaces what Twilio said, not just the status", async () => {
    const { fetch } = recorder({
      ok: false, status: 400,
      json: async () => ({ message: "The number is unverified", code: 21608 }),
    });
    // "unverified number" and "no credit" are the two everyone hits, and a bare
    // 400 tells you neither.
    await expect(
      twilioTransport({ ...TWILIO, fetch }).send({ to: "+447911123456", body: "x" })
    ).rejects.toThrow(/unverified.*21608/);
  });

  test("never puts the recipient's full number in the error", async () => {
    const { fetch } = recorder({ ok: false, status: 400, json: async () => ({}) });
    try {
      await twilioTransport({ ...TWILIO, fetch }).send({ to: "+447911123456", body: "x" });
    } catch (err) {
      expect(err.message).not.toContain("7911123456");
      expect(err.message).toContain("456");
    }
  });
});

describe("Vonage", () => {
  test("posts credentials in the body, with the plus stripped from the recipient", async () => {
    const { calls, fetch } = recorder({ ok: true, status: 200, json: async () => ({ messages: [{ status: "0" }] }) });
    await vonageTransport({ ...VONAGE, fetch }).send({ to: "+447911123456", body: "123456 is your code" });

    const form = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe("https://rest.nexmo.com/sms/json");
    expect(form.get("api_key")).toBe("key123");
    expect(form.get("api_secret")).toBe("secret");
    expect(form.get("to")).toBe("447911123456");
    expect(form.get("from")).toBe("ManPower");
  });

  test("a failure wearing a 200 is still a failure", async () => {
    // Vonage answers 200 and puts the real outcome in the payload, so the
    // status code alone cannot be trusted.
    const { fetch } = recorder({
      ok: true, status: 200,
      json: async () => ({ messages: [{ status: "4", "error-text": "Bad credentials" }] }),
    });
    await expect(
      vonageTransport({ ...VONAGE, fetch }).send({ to: "+447911123456", body: "x" })
    ).rejects.toThrow(/Bad credentials.*status 4/);
  });

  test("a success is not mistaken for one", async () => {
    const { fetch } = recorder({ ok: true, status: 200, json: async () => ({ messages: [{ status: "0" }] }) });
    await expect(
      vonageTransport({ ...VONAGE, fetch }).send({ to: "+447911123456", body: "x" })
    ).resolves.toBeUndefined();
  });
});

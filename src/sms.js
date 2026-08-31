/**
 * sms.js — getting a code to a phone.
 *
 * Sending real SMS needs an account with somebody, so this is written as a
 * transport that can be swapped. Without credentials it writes codes to the
 * journal, which makes the whole sign-in flow work end to end on a development
 * machine; with credentials in the environment it sends over Twilio and nothing
 * else changes.
 *
 * The journal transport is emphatically not for production — anyone who can
 * read the log can sign in as anyone — so it says so, loudly, once.
 */

import { mask } from "./phone.js";

/**
 * Development transport: writes the code where a developer can see it.
 *
 * The number is masked even here. The code is not, because that is the entire
 * point of this transport, and pretending otherwise would just mean nobody
 * could sign in locally.
 */
export function journalTransport() {
  let warned = false;

  return {
    name: "journal",
    live: false,
    async send({ to, body }) {
      if (!warned) {
        console.warn(
          "SMS: no provider configured — codes are being written to the log. " +
          "Anyone who can read it can sign in as anyone. Set TWILIO_* before this is public."
        );
        warned = true;
      }
      console.log(`SMS to ${mask(to)}: ${body}`);
    },
  };
}

/**
 * Twilio. The one most people already have, and its send API is a single form
 * POST with basic auth.
 *
 * `send` is injectable so the request this builds can be checked without a
 * network or an account — which is the only way any of this gets tested here.
 */
export function twilioTransport({ accountSid, authToken, from, fetch = globalThis.fetch }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  return {
    name: "twilio",
    live: true,
    from,
    async send({ to, body }) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        // Twilio explains itself in JSON. Surface that rather than a bare
        // status — "unverified number" and "no credit" are the two everyone
        // hits, and a 400 alone says neither.
        let detail = `HTTP ${res.status}`;
        try {
          const problem = await res.json();
          if (problem?.message) detail = `${problem.message} (Twilio code ${problem.code})`;
        } catch {}
        const error = new Error(`SMS to ${mask(to)} failed: ${detail}`);
        error.statusCode = res.status;
        throw error;
      }
    },
  };
}

/**
 * Vonage. Worth having as an alternative: its trial is less restrictive than
 * Twilio's, and it takes a plain form POST with the credentials in the body.
 *
 * It also answers 200 for failures, putting the real outcome in the payload, so
 * the status code alone cannot be trusted here.
 */
export function vonageTransport({ apiKey, apiSecret, from, fetch = globalThis.fetch }) {
  return {
    name: "vonage",
    live: true,
    from,
    async send({ to, body }) {
      const res = await fetch("https://rest.nexmo.com/sms/json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          api_key: apiKey,
          api_secret: apiSecret,
          // Vonage wants the number without its leading plus.
          to: String(to).replace(/^\+/, ""),
          from,
          text: body,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const payload = await res.json().catch(() => null);
      const first = payload?.messages?.[0];

      // "0" means delivered to the carrier. Anything else is a failure that
      // arrived wearing a 200.
      if (!res.ok || !first || first.status !== "0") {
        const detail = first?.["error-text"]
          ? `${first["error-text"]} (Vonage status ${first.status})`
          : `HTTP ${res.status}`;
        const error = new Error(`SMS to ${mask(to)} failed: ${detail}`);
        error.statusCode = res.ok ? 502 : res.status;
        throw error;
      }
    },
  };
}

/** Providers, in the order they are looked for. */
const PROVIDERS = [
  {
    name: "Twilio",
    vars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"],
    build: ([accountSid, authToken, from], fetch) =>
      twilioTransport({ accountSid, authToken, from, fetch }),
  },
  {
    name: "Vonage",
    vars: ["VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_FROM"],
    build: ([apiKey, apiSecret, from], fetch) =>
      vonageTransport({ apiKey, apiSecret, from, fetch }),
  },
];

/**
 * Pick a transport from the environment.
 *
 * Configuring a provider is deliberately all-or-nothing. A half-filled
 * configuration means someone meant to send real messages, and quietly falling
 * back to writing codes into a log is the worst outcome available — it looks
 * like it works, right up until somebody waits for a text that is sitting in
 * the server's journal. So it refuses to start instead.
 */
export function smsTransport(env = process.env, fetch = globalThis.fetch) {
  for (const provider of PROVIDERS) {
    const values = provider.vars.map((name) => env[name]);
    const provided = values.filter(Boolean).length;

    if (provided === provider.vars.length) return provider.build(values, fetch);
    if (provided > 0) {
      const missing = provider.vars.filter((name) => !env[name]);
      throw new Error(
        `${provider.name} is half-configured — missing ${missing.join(", ")}. ` +
        `Set all of ${provider.vars.join(", ")}, or none of them.`
      );
    }
  }
  return journalTransport();
}

/** The providers this knows about, for error messages and documentation. */
export const knownProviders = () => PROVIDERS.map((p) => ({ name: p.name, vars: p.vars }));

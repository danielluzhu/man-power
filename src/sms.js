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
 * Twilio. Chosen because it is the one most people already have, and because
 * its send API is a single form POST with basic auth.
 */
export function twilioTransport({ accountSid, authToken, from }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  return {
    name: "twilio",
    live: true,
    async send({ to, body }) {
      const form = new URLSearchParams({ To: to, From: from, Body: body });

      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        // Twilio explains itself in JSON; surface that rather than a bare status,
        // but never echo the body of the message back into a log.
        let detail = `HTTP ${res.status}`;
        try {
          const problem = await res.json();
          if (problem?.message) detail = `${problem.message} (code ${problem.code})`;
        } catch {}
        const error = new Error(`SMS to ${mask(to)} failed: ${detail}`);
        error.statusCode = res.status;
        throw error;
      }
    },
  };
}

/**
 * Pick a transport from the environment.
 *
 * Configuring a provider is deliberately all-or-nothing: a half-filled
 * configuration means someone meant to send real messages, and silently falling
 * back to writing codes into the log would be the worst possible outcome.
 */
export function smsTransport(env = process.env) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = env;
  const provided = [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM].filter(Boolean).length;

  if (provided === 3) {
    return twilioTransport({
      accountSid: TWILIO_ACCOUNT_SID,
      authToken: TWILIO_AUTH_TOKEN,
      from: TWILIO_FROM,
    });
  }
  if (provided > 0) {
    throw new Error(
      "Twilio is half-configured. TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM " +
      "are all required, or none of them."
    );
  }
  return journalTransport();
}

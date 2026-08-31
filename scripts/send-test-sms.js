/**
 * send-test-sms.js — prove the SMS provider actually works.
 *
 *   bun run sms:test +447911123456
 *
 * Credentials that look right and do not work are the expensive failure here:
 * the app starts, the sign-in page says a code is on its way, and nobody finds
 * out until someone waits for a text that never comes. This sends one real
 * message and reports exactly what the provider said.
 */

import { smsTransport, knownProviders } from "../src/sms.js";
import { normalise, mask } from "../src/phone.js";

const [, , recipient] = process.argv;

if (!recipient) {
  console.error("Usage: bun run sms:test +447911123456\n");
  console.error("Configure one of these first:");
  for (const provider of knownProviders()) {
    console.error(`  ${provider.name.padEnd(8)} ${provider.vars.join(", ")}`);
  }
  process.exit(2);
}

const number = normalise(recipient);
if (!number.ok) {
  console.error(`${recipient}: ${number.reason}`);
  process.exit(2);
}

let transport;
try {
  transport = smsTransport();
} catch (err) {
  console.error(`Configuration problem: ${err.message}`);
  process.exit(1);
}

if (!transport.live) {
  console.error("No SMS provider is configured, so there is nothing to test.");
  console.error("Codes are being written to the log instead of sent. Set one of:\n");
  for (const provider of knownProviders()) {
    console.error(`  ${provider.name.padEnd(8)} ${provider.vars.join(", ")}`);
  }
  process.exit(1);
}

console.log(`Provider : ${transport.name}`);
console.log(`From     : ${transport.from}`);
console.log(`To       : ${mask(number.e164)}`);
console.log("Sending…");

try {
  await transport.send({
    to: number.e164,
    body: "Test message from Man Power. If this arrived, sign-in codes will too.",
  });
  console.log("\nSent. If it does not arrive within a minute, the provider accepted it " +
              "but the carrier did not deliver it — check the provider's own logs.");
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  console.error(
    "\nThe usual causes:\n" +
    "  · trial accounts can only text numbers verified with the provider\n" +
    "  · the From number must be one the provider issued you\n" +
    "  · no credit on the account"
  );
  process.exit(1);
}

/**
 * secrets.js — server-side keys that must survive a restart but never reach the
 * repository.
 *
 * Generated on first use and kept in data/, alongside the database they protect,
 * so a deployment needs no key ceremony to start. Losing the file is not fatal —
 * a new key is generated — but it invalidates anything derived from the old one,
 * which for verification codes means outstanding codes stop working.
 */

import { randomBytes } from "node:crypto";

const PATH = process.env.SECRETS_PATH || "data/secrets.json";

let cache = null;

async function load() {
  if (cache) return cache;
  const file = Bun.file(PATH);
  cache = (await file.exists()) ? await file.json() : {};
  return cache;
}

async function save() {
  await Bun.write(PATH, JSON.stringify(cache, null, 2));
  await Bun.$`chmod 600 ${PATH}`.quiet().catch(() => {});
}

/** Fetch a named secret, minting one the first time it is asked for. */
export async function getSecret(name, bytes = 32) {
  const secrets = await load();
  if (!secrets[name]) {
    secrets[name] = randomBytes(bytes).toString("base64url");
    await save();
    console.log(`Generated a new secret: ${name}`);
  }
  return secrets[name];
}

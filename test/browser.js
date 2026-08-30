/**
 * Browser smoke test — drives the real app in headless Chromium.
 *
 * The unit tests cover the pace model and routing, but neither can catch the
 * failures that actually broke this app during development: a CSS rule that
 * silently defeated the [hidden] attribute, and an invalid pattern attribute.
 * Those only show up in a browser, so this walks the whole flow and fails on
 * any console error.
 *
 *   bun run test:browser        (needs a chromium binary; see CHROMIUM below)
 */

import puppeteer from "puppeteer-core";
import { $ } from "bun";

const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const BASE = process.env.BASE_URL || "http://localhost:4321";
const stamp = Date.now().toString(36);

/**
 * Read the code out of the journal, which is where the development SMS
 * transport puts it.
 *
 * Deliberately not a test-only endpoint. A back door that hands out codes is
 * exactly the thing that gets left switched on in production, and reading the
 * log exercises the real path — issue, send, transport — rather than
 * side-stepping it.
 */
async function latestCode() {
  const log = await $`sudo journalctl -u man-power --no-pager --since "-60s" -o cat`.text();
  const matches = [...log.matchAll(/SMS to .*?: (\d{6})/g)];
  if (!matches.length) throw new Error("no code found in the journal");
  return matches.at(-1)[1];
}

/** Phone numbers that no real person has, in a range Spain issues to mobiles. */
let issued = 0;
const testNumber = () => `6${String(10_000_000 + (Date.now() % 80_000_000) + issued++ * 7).slice(0, 8)}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// A 401 from the /api/me probe is how the app discovers it is signed out.
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await wait(1200);

  check("sign-in screen is visible", await page.$eval("#auth", (el) => !el.hidden));
  check("app is hidden behind it", await page.$eval("#app", (el) => el.hidden));

  /**
   * Enlist a courier: a number, the code that number receives, then a handle
   * and a home. Returns the number, so the same person can sign in again.
   */
  const enlist = async (handle, cityQuery) => {
    const number = testNumber();
    await signInWith(number);

    await page.waitForSelector("#profile-form:not([hidden])", { timeout: 20_000 });
    await page.type('#profile-form input[name="handle"]', handle);
    await page.type("#profile-form .citypick__input", cityQuery);
    // The picker debounces, so wait for a real result rather than a fixed delay.
    await page.waitForSelector("#profile-form .citypick__results li", { visible: true });
    await page.click("#profile-form .citypick__results li");
    await page.click('#profile-form button[type="submit"]');
    await page.waitForSelector("#app:not([hidden])", { timeout: 20_000 });
    await wait(1200);
    return number;
  };

  /** Whatever the sign-in forms are currently complaining about. */
  const authComplaint = async () => {
    const messages = await page.$$eval("#auth [data-error]", (nodes) =>
      nodes.map((n) => n.textContent.trim()).filter(Boolean)
    );
    return messages.join(" / ") || "(no message on the page)";
  };

  /** The two steps every sign-in shares, new courier or returning. */
  const signInWith = async (number) => {
    await page.waitForSelector("#phone-form:not([hidden])", { visible: true });
    await page.select("#calling-code", "ES");
    await page.type("#phone", number);
    await page.click('#phone-form button[type="submit"]');

    try {
      await page.waitForSelector("#code-form:not([hidden])", { timeout: 20_000 });
    } catch {
      throw new Error(`never reached the code step — the page said: ${await authComplaint()}`);
    }

    await page.type("#code", await latestCode());
    await page.click('#code-form button[type="submit"]');
    await wait(800);

    const complaint = await authComplaint();
    if (complaint !== "(no message on the page)") {
      throw new Error(`the code was refused — the page said: ${complaint}`);
    }
  };

  const signOut = async () => {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#logout"),
    ]);
    await page.waitForSelector("#auth:not([hidden])");
    await wait(600);
  };

  const senderNumber = await enlist(`sender-${stamp}`, "Eldoret");
  check("app opens after enlisting", await page.$eval("#app", (el) => !el.hidden));

  await signOut();
  const recipientNumber = await enlist(`getter-${stamp}`, "Reykjavik");
  await signOut();

  // A number that has enlisted before signs straight in, with no profile step.
  await signInWith(senderNumber);
  await page.waitForSelector("#app:not([hidden])", { timeout: 20_000 });
  await wait(1200);
  check("a returning number signs in without enlisting again",
        await page.$eval("#profile-form", (el) => el.hidden));
  check("signed in as the right courier",
        (await page.$eval("[data-me-handle]", (el) => el.textContent)) === `sender-${stamp}`);

  await page.select("#recipient", `getter-${stamp}`);
  await wait(1500);
  const quote = await page.$eval("#quote", (el) => el.innerText);
  check("route is quoted before sending", /run/.test(quote) && /swim/.test(quote), quote.replace(/\n/g, " / "));
  check("the quote compares against the direct line",
        /faster than going straight/.test(quote) || /Straight there/.test(quote));

  await page.type("#body", "Carried, not transmitted.");
  await page.click("#send");
  await wait(2200);

  const hud = await page.$eval("#hud", (el) => el.innerText);
  check("HUD opens on the new message", /ARRIVES IN/.test(hud));
  check("leg breakdown is present", /Leg by leg \(\d+\)/.test(hud));
  check("the route is compared against going straight",
        /faster than going straight/.test(hud) || /Straight there/.test(hud),
        hud.split("\n").find((l) => /faster than going straight|Straight there/.test(l)) || "");

  const t1 = await page.$eval("[data-hud-countdown]", (el) => el.textContent);
  await wait(2200);
  const t2 = await page.$eval("[data-hud-countdown]", (el) => el.textContent);
  check("countdown is ticking", t1 !== t2, `${t1} → ${t2}`);

  // The receiving side must not be handed the body. Sign in as them properly,
  // through the same flow a person would use.
  await signOut();
  await signInWith(recipientNumber);
  await page.waitForSelector("#app:not([hidden])", { timeout: 20_000 });
  await wait(1000);
  const inbox = await page.evaluate(async () => (await fetch("/api/inbox")).json());
  const received = inbox.messages.at(-1);
  check("recipient's inbox withholds the body", received.body === null);
  check("recipient still sees the envelope", received.charCount > 0 && !received.arrived);
  check("recipient can watch the courier", !!received.courier, received.courier?.mode);

  // The globe should reframe itself on the route, and turn under the cursor.
  const framed = await page.evaluate(() => window.__globe?.());
  check("the globe zooms in on the new route", framed && framed.zoom > 1.2,
        framed ? `zoom ${framed.zoom}` : "no camera");

  await wait(1500); // let the camera settle before measuring the drag
  const settled = await page.evaluate(() => window.__globe?.());
  const box = await page.$eval("#globe", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x - i * 10, box.y + i * 3); await wait(16); }
  await page.mouse.up();
  await wait(400);

  const dragged = await page.evaluate(() => window.__globe?.());
  check("dragging turns the globe",
        Math.abs(dragged.lon - settled.lon) > 1,
        `${settled.lon}° → ${dragged.lon}°`);
  check("taking hold offers a way back", await page.$eval("#globe-reset", (el) => !el.hidden));

  await page.click('.nav__item[data-view="records"]');
  await wait(900);
  const records = await page.$eval("#records-tables", (el) => el.innerText);
  check("pace book lists both ladders", /Josh Kerr/.test(records) && /Sun Yang/.test(records));

  check("no console errors anywhere", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);

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

const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const BASE = process.env.BASE_URL || "http://localhost:4321";
const stamp = Date.now().toString(36);

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

  // Enlist two couriers on different continents.
  const enlist = async (handle, cityQuery) => {
    await page.waitForSelector('[data-auth-tab="register"]', { visible: true });
    await page.click('[data-auth-tab="register"]');
    await page.type('#register-form input[name="handle"]', handle);
    await page.type('#register-form input[name="password"]', "recordpace");
    await page.type("#register-form .citypick__input", cityQuery);
    // The picker debounces, so wait for a real result rather than a fixed delay.
    await page.waitForSelector("#register-form .citypick__results li", { visible: true });
    await page.click("#register-form .citypick__results li");
    await page.click('#register-form button[type="submit"]');
    await page.waitForSelector("#app:not([hidden])");
    await wait(1200);
  };

  const signOut = async () => {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#logout"),
    ]);
    await page.waitForSelector("#auth:not([hidden])");
    await wait(600);
  };

  await enlist(`sender-${stamp}`, "Eldoret");
  check("app opens after enlisting", await page.$eval("#app", (el) => !el.hidden));

  await signOut();
  await enlist(`getter-${stamp}`, "Reykjavik");
  await signOut();

  // Sign back in as the sender and quote a journey.
  await page.type('#login-form input[name="handle"]', `sender-${stamp}`);
  await page.type('#login-form input[name="password"]', "recordpace");
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not([hidden])");
  await wait(1200);

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

  // The receiving side must not be handed the body.
  const cookies = await page.cookies();
  await page.deleteCookie(...cookies);
  await page.evaluate(async (handle) => {
    await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, password: "recordpace" }),
    });
  }, `getter-${stamp}`);
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

/**
 * Project-site test — drives docs/ in headless Chromium.
 *
 * The site runs the real engine from copies in docs/lib/, made by
 * scripts/build-site.js. That copy is the failure mode this guards: edit the
 * router, forget to rebuild, and the site quietly keeps answering with the old
 * engine while every other test passes. So `bun run test:site` rebuilds first,
 * then checks the page actually reports what the current engine computes.
 *
 *   bun run test:site
 */

import puppeteer from "puppeteer-core";
import { LandMask, buildRoute } from "../src/geo.js";
import { Elevation } from "../src/terrain.js";
import { RoutingGrid } from "../src/router.js";

const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const PORT = Number(process.env.SITE_PORT) || 8899;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Serve docs/ exactly as GitHub Pages would.
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(`docs${path === "/" ? "/index.html" : path}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

// What the current engine says, to compare the page against.
const mask = await LandMask.load();
const elevation = await Elevation.fromGzip(await Bun.file("data/elevation.bin.gz").arrayBuffer());
const world = {
  mask, elevation,
  grid: RoutingGrid.downsample(mask, elevation, 0.2),
  coarse: RoutingGrid.downsample(mask, elevation, 1.0, { optimistic: true }),
};
// The page routes between gazetteer coordinates, so the comparison has to start
// from the same ones — a kilometre's difference at either end changes where the
// route crosses the Bering Strait, and with it the number of legs.
const { cities } = await Bun.file("docs/data/cities.json").json();
const placed = (name) => {
  const row = cities.find((c) => c[0] === name);
  if (!row) throw new Error(`${name} is missing from the site's gazetteer`);
  return { lat: row[3], lon: row[4] };
};

const expected = buildRoute(world, placed("San Francisco"), placed("Shanghai"));

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("requestfailed", (r) => errors.push(`REQFAIL: ${r.url()}`));

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".result__time", { timeout: 60_000 });
  await wait(500);

  const result = await page.$eval("#result", (el) => el.innerText);

  check("the default journey is computed", /\d+ days/.test(result), result.split("\n")[1]);

  // The page must agree with the engine in this repo, not a stale copy of it.
  const legs = Number(result.match(/·\s*(\d+)\s*legs?/)?.[1]);
  check("leg count matches the current engine", legs === expected.legs.length,
        `page ${legs}, engine ${expected.legs.length}`);

  const speedup = Number(result.match(/([\d.]+)× faster/)?.[1]);
  check("speed comparison against the direct line is shown",
        Number.isFinite(speedup) && Math.abs(speedup - expected.speedup) < 0.02,
        `page ${speedup}×, engine ${expected.speedup.toFixed(2)}×`);

  check("the climb is reported", /climb [\d,]+ m/.test(result));
  check("terrain routing is in play", /further than the direct line/.test(result));

  // A route with nothing to go around should say so rather than claim a gain.
  // San Francisco to Las Vegas is flat, inland and exactly the direct line —
  // Los Angeles is not, since the coast range is worth going around.
  await page.click('[data-role="to"] .citypick__input', { clickCount: 3 });
  await page.type('[data-role="to"] .citypick__input', "Las Vegas");
  await page.waitForSelector('[data-role="to"] .citypick__results li', { visible: true });
  await page.click('[data-role="to"] .citypick__results li');
  await wait(1500);
  const flat = await page.$eval("#result", (el) => el.innerText);
  check("a route with no detour says so plainly",
        /Straight there/.test(flat) || /faster than going straight/.test(flat));

  // The globe: topographic, reframed on the route, and turnable.
  const camera = await page.evaluate(() => window.__globe?.());
  check("the globe is textured with terrain", camera?.textured === true);
  check("the globe framed the route", camera && camera.zoom > 1.05, `zoom ${camera?.zoom}`);

  const box = await page.$eval("#globe", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x - i * 12, box.y); await wait(16); }
  await page.mouse.up();
  await wait(400);
  const turned = await page.evaluate(() => window.__globe?.());
  check("dragging turns the globe", Math.abs(turned.lon - camera.lon) > 1,
        `${camera.lon}° → ${turned.lon}°`);

  // The hero shows a journey rather than describing one, and that journey has
  // to be the one this engine actually plans — showcase.json is generated, so
  // it can go stale without anything looking wrong.
  const heroFirst = await page.$eval("[data-hero-covered]", (el) => el.textContent);
  await wait(2500);
  const heroLater = await page.$eval("[data-hero-covered]", (el) => el.textContent);
  check("the courier is moving in the hero", heroFirst !== heroLater,
        `${heroFirst} → ${heroLater}`);
  check("the hero names the journey",
        /San Francisco/.test(await page.$eval("[data-hero-route]", (el) => el.textContent)));
  check("the journal's headline counts the days of the route it describes",
        new RegExp(`^${["Twenty-four", "Twenty-five", "Twenty-six"].join("|")} days, written down$`)
          .test(await page.$eval("[data-journal-title]", (el) => el.textContent)),
        await page.$eval("[data-journal-title]", (el) => el.textContent));

  const journalLegs = await page.$$eval("#journal-legs li", (ns) => ns.length);
  check("the journal writes out every leg, and matches the current engine",
        journalLegs === expected.legs.length,
        `journal ${journalLegs}, engine ${expected.legs.length}`);
  check("the journal closes with what the detour bought",
        /sooner than swimming straight/.test(await page.$eval("#journal-close", (el) => el.textContent)));

  // The way in has to be findable: the page is long, and the hero's buttons
  // scroll out of sight almost immediately.
  const signIn = await page.$$eval("[data-app-link]", (nodes) =>
    nodes.map((n) => ({ text: n.textContent.trim(), href: n.getAttribute("href") }))
  );
  check("the landing page offers a way to sign in", signIn.length >= 3, `${signIn.length} links`);
  check("every sign-in link points at the app",
        signIn.length > 0 && signIn.every((l) => /^https?:\/\/.+/.test(l.href)),
        signIn[0]?.href);
  check("one of them is in the sticky bar",
        await page.$eval("#topbar", (el) => !!el.querySelector("[data-app-link]")));

  const atTop = await page.$eval("#topbar", (el) => el.classList.contains("is-lifted"));
  await page.evaluate(() => window.scrollTo(0, 1600));
  await wait(700);
  const scrolled = await page.$eval("#topbar", (el) => el.classList.contains("is-lifted"));
  check("the bar stays out of the way over the hero, then lifts",
        atTop === false && scrolled === true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(400);

  const records = await page.$eval("#records", (el) => el.innerText);
  check("the pace book renders", /Josh Kerr/.test(records) && /Sun Yang/.test(records));

  check("no console errors anywhere", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  server.stop(true);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);

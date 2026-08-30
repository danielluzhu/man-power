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
const expected = buildRoute(world,
  { lat: 40.7128, lon: -74.0060 },   // New York City, the page's default
  { lat: 51.5074, lon: -0.1278 });   // London

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
  await page.click('[data-role="to"] .citypick__input', { clickCount: 3 });
  await page.type('[data-role="to"] .citypick__input', "Los Angeles");
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

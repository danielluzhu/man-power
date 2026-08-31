/**
 * build-showcase.js — precompute one journey for the landing page to tell.
 *
 * The page opens by *showing* a courier crossing the world rather than
 * describing one, and later walks that same crossing leg by leg. Both need a
 * real route, and the routing engine takes a couple of seconds to load its grids
 * — far too long for something above the fold.
 *
 * So the journey is computed here, at build time, and shipped as a small file.
 * It is not a mock-up: it is the same route the app would plan today, produced
 * by the same engine, and the page can start drawing it immediately.
 *
 * Output: docs/data/showcase.json
 */

import { LandMask, buildRoute } from "../src/geo.js";
import { Elevation } from "../src/terrain.js";
import { RoutingGrid } from "../src/router.js";

const FROM = { name: "New York City", country: "United States", lat: 40.7128, lon: -74.0060 };
const TO = { name: "London", country: "United Kingdom", lat: 51.5074, lon: -0.1278 };

const OUT_PATH = "docs/data/showcase.json";

/** Enough points to draw a smooth arc, few enough to keep the file small. */
function thin(points, max = 20) {
  if (points.length <= max) return points;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  out.push(points.at(-1));
  return out;
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

const mask = await LandMask.load();
const elevation = await Elevation.fromGzip(await Bun.file("data/elevation.bin.gz").arrayBuffer());
const world = {
  mask,
  elevation,
  grid: RoutingGrid.downsample(mask, elevation, 0.2),
  coarse: RoutingGrid.downsample(mask, elevation, 1.0, { optimistic: true }),
};

console.log(`Planning ${FROM.name} → ${TO.name}…`);
const route = buildRoute(world, FROM, TO);

const showcase = {
  from: FROM,
  to: TO,
  totalSeconds: Math.round(route.totalSeconds),
  totalMetres: Math.round(route.totalMetres),
  runMetres: Math.round(route.runMetres),
  swimMetres: Math.round(route.swimMetres),
  ascent: route.ascent,
  peak: route.peak,
  detour: round(route.detour, 4),
  straightSeconds: Math.round(route.straight.totalSeconds),
  straightSwimMetres: Math.round(route.straight.swimMetres),
  speedup: round(route.speedup, 3),
  legs: route.legs.map((leg) => ({
    mode: leg.mode,
    metres: Math.round(leg.metres),
    seconds: Math.round(leg.seconds),
    startSeconds: Math.round(leg.startSeconds),
    endSeconds: Math.round(leg.endSeconds),
    startF: round(leg.startF, 5),
    endF: round(leg.endF, 5),
    ascent: leg.ascent,
    peak: leg.peak,
    record: { label: leg.record.label, athlete: leg.record.athlete },
    points: thin(leg.points).map((p) => [round(p.lat, 3), round(p.lon, 3)]),
  })),
};

await Bun.write(OUT_PATH, JSON.stringify(showcase));

const days = (route.totalSeconds / 86400).toFixed(1);
const kb = (Bun.file(OUT_PATH).size / 1024).toFixed(0);
console.log(`Wrote ${OUT_PATH} — ${days} days, ${showcase.legs.length} legs, ${kb} KB`);

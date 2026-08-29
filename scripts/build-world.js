/**
 * build-world.js — compile a compact world outline for the client globe.
 *
 * The browser draws an orthographic globe from scratch, so it needs coastline
 * geometry. The 1:50m set used for routing is 2.7 MB — far too heavy for a page
 * load — so this compiles the 1:110m set down to public/world.json:
 *
 *   • coordinates quantized to 0.05° (~5 km, well under one screen pixel at
 *     the zoom levels the globe renders at)
 *   • consecutive duplicate points after quantizing dropped
 *   • rings with a tiny bounding box dropped, since specks of island cost
 *     bytes and render as a single pixel
 *   • stored as flat [lon, lat, lon, lat, …] arrays, which avoids one JSON
 *     array wrapper per coordinate pair
 */

const SRC_URL =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json";
const SRC_PATH = "data/ne_110m_land.json";
const OUT_PATH = "public/world.json";

const QUANTIZE = 0.05;      // degrees
const MIN_RING_SPAN = 0.6;  // degrees; drop rings smaller than this

async function loadSource() {
  const file = Bun.file(SRC_PATH);
  if (await file.exists()) return JSON.parse(await file.text());
  console.log("Fetching Natural Earth 110m land polygons…");
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const text = await res.text();
  await Bun.write(SRC_PATH, text);
  return JSON.parse(text);
}

const snap = (v) => Math.round(v / QUANTIZE) * QUANTIZE;
const round2 = (v) => Math.round(v * 100) / 100;

function compileRing(ring) {
  const flat = [];
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let prevLon = null, prevLat = null;

  for (const [lon, lat] of ring) {
    const qLon = round2(snap(lon));
    const qLat = round2(snap(lat));
    if (qLon === prevLon && qLat === prevLat) continue;
    flat.push(qLon, qLat);
    prevLon = qLon;
    prevLat = qLat;
    if (qLon < minLon) minLon = qLon;
    if (qLon > maxLon) maxLon = qLon;
    if (qLat < minLat) minLat = qLat;
    if (qLat > maxLat) maxLat = qLat;
  }

  if (flat.length < 8) return null;
  if (maxLon - minLon < MIN_RING_SPAN && maxLat - minLat < MIN_RING_SPAN) return null;
  return flat;
}

const geojson = await loadSource();
const rings = [];
for (const feature of geojson.features) {
  const g = feature.geometry;
  if (!g) continue;
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polygons) {
    for (const ring of poly) {
      const compiled = compileRing(ring);
      if (compiled) rings.push(compiled);
    }
  }
}

// Biggest rings first, so a progressive draw puts continents down before specks.
rings.sort((a, b) => b.length - a.length);

await Bun.write(OUT_PATH, JSON.stringify({ quantize: QUANTIZE, rings }));

const points = rings.reduce((n, r) => n + r.length / 2, 0);
const kb = ((await Bun.file(OUT_PATH).size) / 1024).toFixed(0);
console.log(`Wrote ${OUT_PATH} — ${rings.length} rings, ${points} points, ${kb} KB`);

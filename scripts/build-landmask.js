/**
 * build-landmask.js — rasterize world coastlines into a land/water bitmap.
 *
 * Routing needs one question answered millions of times: is this lat/lon on
 * land or in water? Point-in-polygon against raw coastline geometry is far too
 * slow for that, so we precompute the answer into a 1-bit-per-cell grid.
 *
 * Source: Natural Earth 1:50m land polygons (public domain).
 * Output: data/landmask.bin — 8-byte header + packed bits, ~810 KB.
 *
 * Method: scanline fill. For each row of the grid we take that row's centre
 * latitude, find every coastline edge crossing it, sort the crossings by
 * longitude and fill between alternating pairs. The even-odd rule handles
 * lakes for free — an inland lake's ring adds two more crossings, flipping
 * its interior back to water.
 */

const SRC_URL =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/physical/ne_50m_land.json";
const SRC_PATH = "data/ne_50m_land.json";
const OUT_PATH = "data/landmask.bin";

export const RES = 0.1; // degrees per cell (~11 km at the equator)
export const WIDTH = Math.round(360 / RES); // 3600
export const HEIGHT = Math.round(180 / RES); // 1800

async function loadSource() {
  const file = Bun.file(SRC_PATH);
  if (await file.exists()) return JSON.parse(await file.text());
  console.log("Fetching Natural Earth 50m land polygons…");
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const text = await res.text();
  await Bun.write(SRC_PATH, text);
  return JSON.parse(text);
}

/** Flatten every Polygon/MultiPolygon feature down to a flat list of rings. */
function collectRings(geojson) {
  const rings = [];
  for (const feature of geojson.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === "Polygon") rings.push(...g.coordinates);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) rings.push(...poly);
  }
  return rings;
}

/**
 * Bucket every edge by the grid rows it spans, so each scanline only tests
 * edges that can actually cross it. Without this the build is O(rows × edges).
 */
function bucketEdges(rings) {
  const buckets = Array.from({ length: HEIGHT }, () => []);
  const rowOf = (lat) => (90 - lat) / RES; // fractional row index

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      if (y1 === y2) continue; // horizontal edges never cross a scanline
      const rowA = rowOf(Math.max(y1, y2));
      const rowB = rowOf(Math.min(y1, y2));
      const start = Math.max(0, Math.floor(rowA - 0.5));
      const end = Math.min(HEIGHT - 1, Math.ceil(rowB));
      const edge = { x1, y1, x2, y2 };
      for (let r = start; r <= end; r++) buckets[r].push(edge);
    }
  }
  return buckets;
}

function rasterize(buckets) {
  const bytesPerRow = WIDTH / 8;
  const bits = new Uint8Array(bytesPerRow * HEIGHT);
  const crossings = [];

  for (let row = 0; row < HEIGHT; row++) {
    const lat = 90 - (row + 0.5) * RES;
    crossings.length = 0;

    for (const e of buckets[row]) {
      // Half-open test on latitude avoids double-counting shared vertices.
      if ((e.y1 <= lat) === (e.y2 <= lat)) continue;
      crossings.push(e.x1 + ((lat - e.y1) * (e.x2 - e.x1)) / (e.y2 - e.y1));
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    const rowStart = row * bytesPerRow;
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const lonA = crossings[k];
      const lonB = crossings[k + 1];
      // Cell centres are at -180 + (col + 0.5) * RES.
      let colStart = Math.ceil((lonA + 180) / RES - 0.5);
      let colEnd = Math.floor((lonB + 180) / RES - 0.5);
      if (colStart < 0) colStart = 0;
      if (colEnd > WIDTH - 1) colEnd = WIDTH - 1;
      for (let col = colStart; col <= colEnd; col++) {
        bits[rowStart + (col >> 3)] |= 0x80 >> (col & 7);
      }
    }
  }
  return bits;
}

const geojson = await loadSource();
const rings = collectRings(geojson);
console.log(`Rasterizing ${rings.length} coastline rings at ${RES}° …`);

const bits = rasterize(bucketEdges(rings));

const header = new Uint8Array(8);
const view = new DataView(header.buffer);
view.setUint32(0, 0x4c414e44, false); // "LAND"
view.setUint16(4, WIDTH, false);
view.setUint16(6, HEIGHT, false);

const out = new Uint8Array(header.length + bits.length);
out.set(header, 0);
out.set(bits, header.length);
await Bun.write(OUT_PATH, out);

let land = 0;
for (const byte of bits) land += (byte * 0x08040201 & 0x11111111) % 0xf; // popcount
const pct = ((land / (WIDTH * HEIGHT)) * 100).toFixed(1);
console.log(`Wrote ${OUT_PATH} — ${WIDTH}×${HEIGHT}, ${(out.length / 1024).toFixed(0)} KB, ${pct}% land cells`);

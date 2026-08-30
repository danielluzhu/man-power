/**
 * build-elevation.js — compile a global land-elevation grid.
 *
 * Routing now cares about terrain, which needs an elevation for every cell of
 * the same 0.1° grid the land mask uses.
 *
 * Source: ETOPO1 (NOAA), served by ERDDAP. ERDDAP supports strided index
 * selection, so rather than downloading the full 1-arc-minute grid (450 MB) we
 * ask for exactly the 3600 × 1800 nodes that sit at our cell centres. That
 * works out neatly: our centres fall on 0.05° + k·0.1°, and 0.05° is exactly
 * 3 arc-minutes, so every centre lands on an ETOPO1 node with no interpolation.
 *
 * Ocean cells are stored as zero rather than as bathymetry — the courier swims
 * on the surface, so depth is irrelevant, and a grid that is 71% zeros
 * compresses to a fraction of its size.
 *
 * Output: data/elevation.bin.gz — 8-byte header + int16 metres, gzipped.
 */

import { LandMask } from "../src/geo.js";
import { gzipSync } from "node:zlib";

const ERDDAP = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.dods";
const OUT_PATH = "data/elevation.bin.gz";

const WIDTH = 3600;
const HEIGHT = 1800;

// ETOPO1 index space: 10801 latitudes and 21601 longitudes at 1 arc-minute.
// Index 3 is the first of our cell centres (-89.95°, -179.95°); stride 6 is 0.1°.
const LAT_START = 3, LON_START = 3, STRIDE = 6;
const BANDS = 12;               // split the request so no single one is huge
const ROWS_PER_BAND = HEIGHT / BANDS;

/**
 * Parse a DAP2 (.dods) response. The body is an ASCII DDS, then "\nData:\n",
 * then for each array a pair of big-endian 32-bit lengths followed by the
 * values. DAP2 widens Int16 to 32 bits on the wire.
 */
function parseDods(buffer, expected) {
  const bytes = new Uint8Array(buffer);
  const marker = "\nData:\n";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(4096, bytes.length)));
  const at = head.indexOf(marker);
  if (at === -1) throw new Error(`No data section in response: ${head.slice(0, 200)}`);

  const view = new DataView(buffer);
  let offset = at + marker.length;

  const count = view.getUint32(offset, false);
  if (view.getUint32(offset + 4, false) !== count) throw new Error("Malformed DAP2 array header");
  if (count !== expected) throw new Error(`Expected ${expected} values, got ${count}`);
  offset += 8;

  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt32(offset + i * 4, false);
  return out;
}

async function fetchBand(band, attempt = 1) {
  const first = band * ROWS_PER_BAND;
  const latFrom = LAT_START + first * STRIDE;
  const latTo = LAT_START + (first + ROWS_PER_BAND - 1) * STRIDE;
  const lonTo = LON_START + (WIDTH - 1) * STRIDE;

  const query = `?altitude[${latFrom}:${STRIDE}:${latTo}][${LON_START}:${STRIDE}:${lonTo}]`;
  const url = ERDDAP + encodeURI(query);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDods(await res.arrayBuffer(), ROWS_PER_BAND * WIDTH);
  } catch (err) {
    if (attempt >= 4) throw new Error(`Band ${band + 1} failed after 4 tries: ${err.message}`);
    console.log(`  band ${band + 1}: ${err.message} — retrying (${attempt + 1}/4)`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return fetchBand(band, attempt + 1);
  }
}

const mask = await LandMask.load();
if (mask.width !== WIDTH || mask.height !== HEIGHT) {
  throw new Error(`Land mask is ${mask.width}×${mask.height}, expected ${WIDTH}×${HEIGHT}`);
}

const grid = new Int16Array(WIDTH * HEIGHT);
console.log(`Fetching ETOPO1 at 0.1° in ${BANDS} bands…`);

for (let band = 0; band < BANDS; band++) {
  const values = await fetchBand(band);

  for (let r = 0; r < ROWS_PER_BAND; r++) {
    // ERDDAP returns latitude ascending (south first); our grid is north-first.
    const sourceRow = band * ROWS_PER_BAND + r;
    const targetRow = HEIGHT - 1 - sourceRow;

    for (let col = 0; col < WIDTH; col++) {
      const lat = 90 - (targetRow + 0.5) * 0.1;
      const lon = -180 + (col + 0.5) * 0.1;
      const raw = values[r * WIDTH + col];
      // Water is flat as far as a swimmer is concerned; storing zero also makes
      // most of the grid compress away.
      grid[targetRow * WIDTH + col] = mask.isLand(lat, lon) ? Math.max(-500, raw) : 0;
    }
  }
  console.log(`  band ${band + 1}/${BANDS} done`);
}

const header = new Uint8Array(8);
const hv = new DataView(header.buffer);
hv.setUint32(0, 0x454c4556, false); // "ELEV"
hv.setUint16(4, WIDTH, false);
hv.setUint16(6, HEIGHT, false);

const raw = new Uint8Array(header.length + grid.byteLength);
raw.set(header, 0);
raw.set(new Uint8Array(grid.buffer), header.length);

const packed = gzipSync(raw, { level: 9 });
await Bun.write(OUT_PATH, packed);

let land = 0, sum = 0, peak = -Infinity, peakAt = null;
for (let i = 0; i < grid.length; i++) {
  if (grid[i] !== 0) { land++; sum += grid[i]; }
  if (grid[i] > peak) { peak = grid[i]; peakAt = i; }
}
const peakLat = (90 - (Math.floor(peakAt / WIDTH) + 0.5) * 0.1).toFixed(2);
const peakLon = (-180 + ((peakAt % WIDTH) + 0.5) * 0.1).toFixed(2);

console.log(`Wrote ${OUT_PATH} — ${(raw.length / 1048576).toFixed(1)} MB raw, ${(packed.length / 1048576).toFixed(2)} MB gzipped`);
console.log(`Mean land elevation ${Math.round(sum / land)} m; highest cell ${peak} m at ${peakLat}, ${peakLon}`);

/**
 * build-globe-texture.js — bake the topographic globe texture.
 *
 * The project site already downloads the elevation grid for routing, so it
 * builds this in the browser. The messaging app has no other use for elevation,
 * and 2.9 MB of it would be a poor trade for a map, so the app gets a PNG baked
 * here instead — smaller than the grid it came from, and decoded natively.
 *
 * Output: public/terrain.png
 */

import { LandMask } from "../src/geo.js";
import { Elevation } from "../src/terrain.js";
import { buildTerrainTexture } from "../src/terrain-texture.js";
import { encodePng } from "../src/png.js";

const WIDTH = 2048;
const HEIGHT = 1024;
const OUT_PATH = "public/terrain.png";

const mask = await LandMask.load();
const elevation = await Elevation.fromGzip(await Bun.file("data/elevation.bin.gz").arrayBuffer());

console.log(`Shading ${WIDTH}×${HEIGHT} of terrain…`);
const started = performance.now();
const texture = buildTerrainTexture(mask, elevation, WIDTH, HEIGHT);
const shaded = performance.now();

const png = encodePng(texture.width, texture.height, texture.pixels);
await Bun.write(OUT_PATH, png);

console.log(`Wrote ${OUT_PATH} — ${(png.length / 1024).toFixed(0)} KB`);
console.log(`  shaded in ${Math.round(shaded - started)} ms, encoded in ${Math.round(performance.now() - shaded)} ms`);

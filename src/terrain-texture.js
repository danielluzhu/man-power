/**
 * terrain-texture.js — paint the world as a topographic map.
 *
 * Produces an equirectangular RGBA image: hypsometric tint for height, relief
 * shading for shape, flat dark water for the sea. The globe then wraps this
 * around a sphere.
 *
 * Shared by both consumers so they cannot diverge. The app fetches a PNG baked
 * from this at build time (about a megabyte, and it needs nothing else); the
 * project site already carries the elevation grid for routing, so it calls this
 * directly in the browser and skips the download entirely.
 *
 * PALETTE
 * -------
 * A natural-earth palette would be wrong here twice over: it would fight the
 * dark interface, and its greens and browns would drown the amber and cyan that
 * mean *run* and *swim* on top of it. So the ramp starts at very nearly the
 * flat green the globe used before — low ground looks unchanged — and only
 * brightens as it climbs, through olive and tan to a pale, snow-bleached grey.
 * Height reads as luminance, and the route still sits clearly on top of it.
 */

/** Elevation in metres to colour, interpolated between these stops. */
const RAMP = [
  [-500, [ 26,  52,  42]],   // land below sea level
  [    0, [ 30,  51,  38]],  // sea-level green, matching the old flat fill
  [  300, [ 38,  61,  40]],
  [  800, [ 53,  72,  44]],
  [ 1500, [ 74,  85,  51]],  // olive
  [ 2500, [100,  96,  60]],
  [ 3500, [122, 107,  76]],  // tan
  [ 4500, [148, 130, 108]],
  [ 5500, [180, 172, 160]],  // bare rock
  [ 7000, [214, 212, 208]],  // snow
];

const OCEAN = [12, 30, 48];

/** Light from the north-west at 45°, the cartographic convention. */
const LIGHT = (() => {
  const azimuth = (315 * Math.PI) / 180;
  const altitude = (45 * Math.PI) / 180;
  return [
    Math.cos(altitude) * Math.sin(azimuth),
    Math.cos(altitude) * Math.cos(azimuth),
    Math.sin(altitude),
  ];
})();

/**
 * Slopes are gentle at this resolution — an 11 km cell turns the Himalaya into
 * a 5% grade — so relief has to be exaggerated to be visible at all.
 */
const RELIEF_EXAGGERATION = 9;

/** How far shading is allowed to darken or lighten the tint. */
const SHADE_MIN = 0.45;
const SHADE_MAX = 1.35;

function tint(metres) {
  if (metres <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    const [high, colour] = RAMP[i];
    if (metres > high) continue;
    const [low, previous] = RAMP[i - 1];
    const f = (metres - low) / (high - low);
    return [
      previous[0] + f * (colour[0] - previous[0]),
      previous[1] + f * (colour[1] - previous[1]),
      previous[2] + f * (colour[2] - previous[2]),
    ];
  }
  return RAMP[RAMP.length - 1][1];
}

/**
 * Build the texture.
 *
 * `width` × `height` is the equirectangular grid; 2048 × 1024 puts a texel
 * comfortably under a screen pixel at the sizes the globe is drawn.
 */
export function buildTerrainTexture(mask, elevation, width = 2048, height = 1024) {
  const pixels = new Uint8ClampedArray(width * height * 4);

  const metresPerDegree = 111_320;
  const cellNS = elevation.resLat * metresPerDegree;

  for (let row = 0; row < height; row++) {
    const lat = 90 - ((row + 0.5) * 180) / height;

    // Cells shrink east-west towards the poles; clamping stops the slope
    // blowing up into noise in the last few rows.
    const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const cellEW = elevation.resLon * metresPerDegree * cosLat;

    // The elevation grid is coarser than the texture, so neighbours are taken
    // in grid space rather than texel space.
    let gridRow = Math.floor((90 - lat) / elevation.resLat);
    if (gridRow < 0) gridRow = 0;
    else if (gridRow >= elevation.height) gridRow = elevation.height - 1;
    const up = Math.max(0, gridRow - 1);
    const down = Math.min(elevation.height - 1, gridRow + 1);

    for (let col = 0; col < width; col++) {
      const lon = -180 + ((col + 0.5) * 360) / width;
      const at = (row * width + col) * 4;

      if (!mask.isLand(lat, lon)) {
        pixels[at] = OCEAN[0];
        pixels[at + 1] = OCEAN[1];
        pixels[at + 2] = OCEAN[2];
        pixels[at + 3] = 255;
        continue;
      }

      let gridCol = Math.floor((lon + 180) / elevation.resLon);
      gridCol = ((gridCol % elevation.width) + elevation.width) % elevation.width;
      const left = (gridCol - 1 + elevation.width) % elevation.width;
      const right = (gridCol + 1) % elevation.width;

      const here = elevation.atCell(gridRow, gridCol);

      // Central differences give the surface gradient; the normal follows.
      const zx = ((elevation.atCell(gridRow, right) - elevation.atCell(gridRow, left)) / (2 * cellEW)) * RELIEF_EXAGGERATION;
      const zy = ((elevation.atCell(up, gridCol) - elevation.atCell(down, gridCol)) / (2 * cellNS)) * RELIEF_EXAGGERATION;

      const length = Math.sqrt(zx * zx + zy * zy + 1);
      let shade = (-zx * LIGHT[0] - zy * LIGHT[1] + LIGHT[2]) / length;
      // Lambert gives 0..1 around the light direction; recentre so flat ground
      // sits at 1 and only real slopes move away from it.
      shade = 1 + (shade - LIGHT[2]) * 1.6;
      if (shade < SHADE_MIN) shade = SHADE_MIN;
      else if (shade > SHADE_MAX) shade = SHADE_MAX;

      const colour = tint(here);
      pixels[at] = colour[0] * shade;
      pixels[at + 1] = colour[1] * shade;
      pixels[at + 2] = colour[2] * shade;
      pixels[at + 3] = 255;
    }
  }

  return { width, height, pixels };
}

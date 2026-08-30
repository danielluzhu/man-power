/**
 * terrain.js — what the ground does to a runner's pace.
 *
 * Two effects, both applied as a multiplier on flat-ground speed.
 *
 * GRADIENT — Minetti et al. (2002), "Energy cost of walking and running at
 * extreme uphill and downhill slopes" (J Appl Physiol 93:1039-1046), which fits
 * the metabolic cost of running Cr, in J/kg/m, as a quintic in the gradient i:
 *
 *     Cr(i) = 155.4i⁵ − 30.4i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6
 *
 * On flat ground Cr = 3.6, so holding metabolic power constant gives a speed
 * multiplier of 3.6 / Cr(i). The fit is valid over ±45% gradient, so the input
 * is clamped there.
 *
 * Taken literally that formula says a 10% descent is run 1.67× faster than the
 * flat, because Cr bottoms out around i = −0.1. Real runners cannot convert all
 * of that saving into speed — braking forces and turnover limits get in the way
 * long before metabolism does — so the downhill bonus is capped. Uphill is
 * uncapped, because there the metabolic limit really is the binding one.
 *
 * ALTITUDE — endurance performance falls off with thin air, by the standard
 * rule of thumb of about 1% of VO2max per 100 m above 1500 m. This is what
 * makes crossing the Tibetan plateau expensive rather than merely long, and it
 * is why a route will happily detour around one.
 *
 * Both are deliberately modest. At a 0.1° grid the elevation of a cell is an
 * 11 km average, which smooths real gradients considerably: the Himalaya rise
 * about 5000 m over 100 km, a gradient of 0.05, not the wall it looks like from
 * the ground.
 */

/** Minetti's fit is valid to ±45%. */
export const MAX_GRADIENT = 0.45;

/** Flat-ground cost of running, J/kg/m — the Cr(0) term. */
const FLAT_COST = 3.6;

/**
 * Downhill speeds are capped at this multiple of flat pace. Minetti alone would
 * predict 1.67× on a 10% descent, which no runner sustains.
 */
export const DOWNHILL_CAP = 1.15;

/** Altitude has no effect below this, and the penalty accrues above it. */
export const ALTITUDE_THRESHOLD = 1500;

/** Fraction of performance lost per metre above the threshold (1% per 100 m). */
const ALTITUDE_DECAY = 0.0001;

/** Never slow a runner below this fraction of flat pace from altitude alone. */
const ALTITUDE_FLOOR = 0.45;

/** Metabolic cost of running at gradient `i`, in J/kg/m. */
export function costOfRunning(i) {
  const g = Math.max(-MAX_GRADIENT, Math.min(MAX_GRADIENT, i));
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + FLAT_COST;
}

/** Speed multiplier from gradient alone. */
export function gradientFactor(i) {
  return Math.min(DOWNHILL_CAP, FLAT_COST / costOfRunning(i));
}

/** Speed multiplier from altitude alone. */
export function altitudeFactor(metres) {
  if (metres <= ALTITUDE_THRESHOLD) return 1;
  return Math.max(ALTITUDE_FLOOR, 1 - ALTITUDE_DECAY * (metres - ALTITUDE_THRESHOLD));
}

/**
 * Combined speed multiplier for a stretch of ground that climbs `rise` metres
 * over `run` metres, averaging `altitude` metres above sea level.
 */
export function terrainFactor(rise, run, altitude) {
  if (!(run > 0)) return 1;
  return gradientFactor(rise / run) * altitudeFactor(altitude);
}

/** Reader for the int16 elevation grid built by scripts/build-elevation.js. */
export class Elevation {
  constructor(buffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, false) !== 0x454c4556) throw new Error("Not an elevation file");
    this.width = view.getUint16(4, false);
    this.height = view.getUint16(6, false);
    this.metres = new Int16Array(buffer, 8, this.width * this.height);
    this.resLat = 180 / this.height;
    this.resLon = 360 / this.width;
  }

  /**
   * The grid ships gzipped — 12.4 MB of mostly-zero ocean packs down to under
   * 3 MB. DecompressionStream exists in both Bun and the browser, so one path
   * serves the server and the site.
   */
  static async fromGzip(gzipped) {
    const stream = new Response(gzipped).body.pipeThrough(new DecompressionStream("gzip"));
    return new Elevation(await new Response(stream).arrayBuffer());
  }

  /** Metres above sea level. Water reads as 0 — a swimmer is on the surface. */
  at(lat, lon) {
    let row = Math.floor((90 - lat) / this.resLat);
    if (row < 0) row = 0;
    else if (row >= this.height) row = this.height - 1;
    let col = Math.floor((lon + 180) / this.resLon);
    col = ((col % this.width) + this.width) % this.width;
    return this.metres[row * this.width + col];
  }

  /** Direct cell access, for the router walking the grid. */
  atCell(row, col) {
    return this.metres[row * this.width + col];
  }
}

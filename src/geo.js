/**
 * geo.js — great-circle routing, split into legs the courier runs and swims.
 *
 * A route is the great circle between two points, sampled at a fixed interval
 * and classified against the land mask. Runs of consecutive same-surface
 * samples become "legs"; each leg is timed independently against its own world
 * record, so a 600 m river crossing is swum at 800 m pace while the 4000 km
 * either side of it is run at marathon pace.
 */

import { runSeconds, swimSeconds, runRecordFor, swimRecordFor } from "./records.js";
import { haversine, interpolate, positionAt } from "./sphere.js";

export { haversine, interpolate, positionAt, EARTH_RADIUS } from "./sphere.js";

/** Reader for the packed bitmap written by scripts/build-landmask.js. */
export class LandMask {
  constructor(buffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, false) !== 0x4c414e44) throw new Error("Not a land mask file");
    this.width = view.getUint16(4, false);
    this.height = view.getUint16(6, false);
    this.bytesPerRow = this.width / 8;
    this.bits = new Uint8Array(buffer, 8);
    this.resLat = 180 / this.height;
    this.resLon = 360 / this.width;
  }

  static async load(path = "data/landmask.bin") {
    return new LandMask(await Bun.file(path).arrayBuffer());
  }

  isLand(lat, lon) {
    let row = Math.floor((90 - lat) / this.resLat);
    if (row < 0) row = 0;
    else if (row >= this.height) row = this.height - 1;
    let col = Math.floor((lon + 180) / this.resLon);
    col = ((col % this.width) + this.width) % this.width; // wrap the antimeridian
    return ((this.bits[row * this.bytesPerRow + (col >> 3)] >> (7 - (col & 7))) & 1) === 1;
  }
}

/**
 * Sampling interval. Fine enough to catch an isthmus or a strait, coarse
 * enough that a transpacific route is still ~1000 samples rather than a
 * million.
 */
function stepFor(totalMetres) {
  return Math.min(10000, Math.max(500, totalMetres / 1000));
}

/**
 * Where exactly does the surface change between two samples? Bisect down to
 * ~50 m so coastline crossings land on the coast rather than on a sample
 * boundary up to 10 km inland.
 */
function refineCrossing(lat1, lon1, lat2, lon2, fLo, fHi, landAtLo, mask) {
  let lo = fLo, hi = fHi;
  const spanMetres = haversine(lat1, lon1, lat2, lon2) * (fHi - fLo);
  const iterations = Math.min(12, Math.max(1, Math.ceil(Math.log2(spanMetres / 50))));
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const p = interpolate(lat1, lon1, lat2, lon2, mid);
    if (mask.isLand(p.lat, p.lon) === landAtLo) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Thin a polyline down to at most `max` points, always keeping both ends. */
function decimate(points, max = 48) {
  if (points.length <= max) return points;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Build the full itinerary between two coordinates.
 *
 * Returns total distance and duration plus the leg breakdown, where each leg
 * carries its own surface, distance, duration, governing world record and a
 * decimated polyline for drawing.
 */
export function buildRoute(mask, from, to) {
  const total = haversine(from.lat, from.lon, to.lat, to.lon);

  if (total < 1) {
    return { totalMetres: 0, totalSeconds: 0, runMetres: 0, swimMetres: 0, legs: [] };
  }

  const step = stepFor(total);
  const sampleCount = Math.max(2, Math.ceil(total / step) + 1);

  // Classify every sample. Endpoints are forced to land: they are cities, and
  // a coastal city can otherwise fall in a water cell at this resolution.
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const f = i / (sampleCount - 1);
    const p = interpolate(from.lat, from.lon, to.lat, to.lon, f);
    const land = i === 0 || i === sampleCount - 1 ? true : mask.isLand(p.lat, p.lon);
    samples.push({ f, ...p, land });
  }

  // Walk the samples, cutting a new leg wherever the surface changes.
  const legs = [];
  let legStartF = 0;
  let legLand = samples[0].land;
  let points = [{ lat: samples[0].lat, lon: samples[0].lon }];

  const closeLeg = (endF, endPoint) => {
    const metres = total * (endF - legStartF);
    points.push(endPoint);
    if (metres > 0) {
      legs.push({ land: legLand, metres, startF: legStartF, endF, points: decimate(points) });
    }
  };

  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (s.land === legLand) {
      points.push({ lat: s.lat, lon: s.lon });
      continue;
    }
    const prev = samples[i - 1];
    const cross = refineCrossing(from.lat, from.lon, to.lat, to.lon, prev.f, s.f, prev.land, mask);
    const crossPoint = interpolate(from.lat, from.lon, to.lat, to.lon, cross);
    closeLeg(cross, crossPoint);
    legStartF = cross;
    legLand = s.land;
    points = [crossPoint, { lat: s.lat, lon: s.lon }];
  }
  closeLeg(1, { lat: samples[samples.length - 1].lat, lon: samples[samples.length - 1].lon });

  // Time each leg against its own record, and accumulate.
  let totalSeconds = 0, runMetres = 0, swimMetres = 0;
  for (const leg of legs) {
    leg.mode = leg.land ? "run" : "swim";
    leg.seconds = leg.land ? runSeconds(leg.metres) : swimSeconds(leg.metres);
    leg.record = leg.land ? runRecordFor(leg.metres) : swimRecordFor(leg.metres);
    leg.startSeconds = totalSeconds;
    totalSeconds += leg.seconds;
    leg.endSeconds = totalSeconds;
    if (leg.land) runMetres += leg.metres;
    else swimMetres += leg.metres;
  }

  return { totalMetres: total, totalSeconds, runMetres, swimMetres, legs };
}

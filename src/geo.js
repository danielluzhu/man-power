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

export const EARTH_RADIUS = 6371008.8; // metres, IUGG mean radius

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point a fraction `f` of the way along the great circle from 1 to 2. */
export function interpolate(lat1, lon1, lat2, lon2, f) {
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const δ = 2 * Math.asin(
    Math.min(1, Math.sqrt(
      Math.sin((φ2 - φ1) / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
    ))
  );
  if (δ === 0) return { lat: lat1, lon: lon1 };

  const a = Math.sin((1 - f) * δ) / Math.sin(δ);
  const b = Math.sin(f * δ) / Math.sin(δ);
  const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
  const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
  const z = a * Math.sin(φ1) + b * Math.sin(φ2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: toDeg(Math.atan2(y, x)),
  };
}

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

/**
 * Where is the courier after `elapsed` seconds? Returns their position, the leg
 * they are on and overall progress, or null once they have arrived.
 */
export function positionAt(route, elapsed, from, to) {
  if (!route.legs.length) return null;
  if (elapsed >= route.totalSeconds) return null;
  const t = Math.max(0, elapsed);

  for (const leg of route.legs) {
    if (t > leg.endSeconds) continue;
    const withinLeg = leg.seconds > 0 ? (t - leg.startSeconds) / leg.seconds : 0;
    const f = leg.startF + withinLeg * (leg.endF - leg.startF);
    const p = interpolate(from.lat, from.lon, to.lat, to.lon, f);
    return {
      ...p,
      mode: leg.mode,
      fraction: f,
      metresCovered: route.totalMetres * f,
      metresRemaining: route.totalMetres * (1 - f),
      secondsRemaining: route.totalSeconds - t,
    };
  }
  return null;
}

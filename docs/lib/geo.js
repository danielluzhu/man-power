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
import { terrainFactor } from "./terrain.js";
import { planPath, polylineLength, PLANNING_RUN_SPEED, PLANNING_SWIM_SPEED } from "./router.js";

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
 * Sampling interval along the planned path. Fine enough to catch an isthmus or
 * a strait, coarse enough that a transpacific route is a few thousand samples
 * rather than a million.
 */
function stepFor(totalMetres) {
  return Math.min(5000, Math.max(400, totalMetres / 2500));
}

/**
 * Walk a polyline, emitting evenly spaced points along it. The router returns
 * a sparse path; timing and surface classification need it dense.
 */
function densify(path, step) {
  const points = [{ ...path[0], travelled: 0 }];
  let travelled = 0;

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const span = haversine(a.lat, a.lon, b.lat, b.lon);
    if (span === 0) continue;

    const divisions = Math.max(1, Math.ceil(span / step));
    for (let d = 1; d <= divisions; d++) {
      const p = interpolate(a.lat, a.lon, b.lat, b.lon, d / divisions);
      travelled += span / divisions;
      points.push({ ...p, travelled });
    }
  }
  return points;
}

/** Thin a polyline down to at most `max` points, always keeping both ends. */
function decimate(points, max = 64) {
  if (points.length <= max) return points;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Time one leg.
 *
 * The world record that governs a leg is chosen from the leg's total distance,
 * as before — a 13 km run is paced on the 15 km record whether it is flat or
 * not. Terrain then modulates that pace segment by segment along the leg, so a
 * climb in the middle slows only the part that climbs.
 *
 * Water legs are flat by definition and take the swimming pace unmodified.
 */
function timeLeg(leg, samples, elevation) {
  if (leg.mode === "swim") {
    leg.seconds = swimSeconds(leg.metres);
    leg.record = swimRecordFor(leg.metres);
    leg.ascent = 0;
    leg.descent = 0;
    leg.peak = 0;
    return;
  }

  leg.record = runRecordFor(leg.metres);
  const flatSpeed = leg.metres / runSeconds(leg.metres);

  let seconds = 0, ascent = 0, descent = 0, peak = -Infinity;
  let previous = samples[0];
  let previousHeight = elevation.at(previous.lat, previous.lon);

  for (let i = 1; i < samples.length; i++) {
    const point = samples[i];
    const height = elevation.at(point.lat, point.lon);
    const run = haversine(previous.lat, previous.lon, point.lat, point.lon);

    if (run > 0) {
      const rise = height - previousHeight;
      const factor = terrainFactor(rise, run, (height + previousHeight) / 2);
      seconds += run / (flatSpeed * factor);
      if (rise > 0) ascent += rise;
      else descent -= rise;
    }
    if (height > peak) peak = height;

    previous = point;
    previousHeight = height;
  }

  leg.seconds = seconds;
  leg.ascent = Math.round(ascent);
  leg.descent = Math.round(descent);
  leg.peak = Math.max(0, Math.round(peak === -Infinity ? 0 : peak));
}

/**
 * Seconds to cross straight from `a` to `b`, using the planner's reference
 * paces. This is the yardstick the string-pulling pass measures shortcuts
 * against, so it deliberately models the ground the same way the router does —
 * surface from the fine mask, terrain from the elevation grid — rather than
 * using the distance-dependent record ladder, which needs whole legs to apply.
 */
function referenceSeconds(world, a, b, sampleMetres = 5000) {
  const { mask, elevation } = world;
  const span = haversine(a.lat, a.lon, b.lat, b.lon);
  if (span === 0) return 0;

  const steps = Math.max(1, Math.ceil(span / sampleMetres));
  const stride = span / steps;

  let seconds = 0;
  let prev = a;
  let prevLand = mask.isLand(a.lat, a.lon);
  let prevHeight = elevation.at(a.lat, a.lon);

  for (let k = 1; k <= steps; k++) {
    const p = k === steps ? b : interpolate(a.lat, a.lon, b.lat, b.lon, k / steps);
    const land = mask.isLand(p.lat, p.lon);
    const height = elevation.at(p.lat, p.lon);

    if (land && prevLand) {
      const factor = terrainFactor(height - prevHeight, stride, (height + prevHeight) / 2);
      seconds += stride / (PLANNING_RUN_SPEED * factor);
    } else {
      seconds += stride / PLANNING_SWIM_SPEED;
    }

    prev = p;
    prevLand = land;
    prevHeight = height;
  }
  return seconds;
}

/**
 * Measure and time a path that has already been chosen.
 *
 * Surfaces are classified against the fine 0.1° mask along the line,
 * consecutive samples of the same surface become legs, and each leg is timed on
 * its own world record with terrain applied along it.
 *
 * This is deliberately separate from choosing the path, because it gets run
 * twice: once on the route the courier will take, and once on the straight line
 * they could have taken instead, so the two can be compared on equal terms.
 */
function measurePath(world, path, directMetres) {
  const { mask, elevation } = world;
  const total = polylineLength(path);
  const samples = densify(path, stepFor(total));

  // Endpoints are forced to land: they are cities, and a coastal one can fall
  // in a water cell even at this resolution.
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    s.land = i === 0 || i === samples.length - 1 ? true : mask.isLand(s.lat, s.lon);
  }

  /**
   * Where between two samples does the surface actually change? Bisecting to
   * about fifty metres puts the crossing on the coast rather than up to a few
   * kilometres inland at whichever sample happened to notice.
   */
  const refineBoundary = (a, b) => {
    let lo = 0, hi = 1;
    const span = b.travelled - a.travelled;
    const rounds = Math.min(12, Math.max(1, Math.ceil(Math.log2(span / 50))));
    for (let n = 0; n < rounds; n++) {
      const mid = (lo + hi) / 2;
      const p = interpolate(a.lat, a.lon, b.lat, b.lon, mid);
      if (mask.isLand(p.lat, p.lon) === a.land) lo = mid;
      else hi = mid;
    }
    const t = (lo + hi) / 2;
    const p = interpolate(a.lat, a.lon, b.lat, b.lon, t);
    return { ...p, travelled: a.travelled + span * t, land: a.land };
  };

  // Cut a new leg wherever the surface changes, splitting at the refined coast.
  const legs = [];
  let current = [samples[0]];
  let mode = samples[0].land;

  const closeLeg = (endPoint) => {
    const slice = endPoint ? [...current, endPoint] : current;
    const metres = slice[slice.length - 1].travelled - slice[0].travelled;
    if (metres <= 0) return;
    legs.push({
      land: mode,
      mode: mode ? "run" : "swim",
      metres,
      startF: slice[0].travelled / total,
      endF: slice[slice.length - 1].travelled / total,
      samples: slice,
      points: decimate(slice.map((p) => ({ lat: p.lat, lon: p.lon }))),
    });
  };

  for (let i = 1; i < samples.length; i++) {
    if (samples[i].land === mode) { current.push(samples[i]); continue; }
    const boundary = refineBoundary(samples[i - 1], samples[i]);
    closeLeg(boundary);
    // The new leg starts at the same boundary point, so the legs stay
    // contiguous, but takes its surface from the sample that changed.
    mode = samples[i].land;
    current = [{ ...boundary, land: mode }, samples[i]];
  }
  closeLeg(null);

  let totalSeconds = 0, runMetres = 0, swimMetres = 0, ascent = 0, descent = 0, peak = 0;
  for (const leg of legs) {
    timeLeg(leg, leg.samples, elevation);
    delete leg.samples;

    leg.startSeconds = totalSeconds;
    totalSeconds += leg.seconds;
    leg.endSeconds = totalSeconds;

    if (leg.land) runMetres += leg.metres;
    else swimMetres += leg.metres;
    ascent += leg.ascent;
    descent += leg.descent;
    if (leg.peak > peak) peak = leg.peak;
  }

  return {
    totalMetres: total,
    totalSeconds,
    runMetres,
    swimMetres,
    ascent,
    descent,
    peak,
    directMetres,
    detour: total / directMetres,
    legs,
    path,
  };
}

const EMPTY_ROUTE = {
  totalMetres: 0, totalSeconds: 0, runMetres: 0, swimMetres: 0,
  ascent: 0, descent: 0, peak: 0, directMetres: 0, detour: 1, legs: [], path: [],
};

/**
 * Build the full itinerary between two coordinates: plan the courier's path,
 * measure it, and measure the straight line alongside it for comparison.
 *
 * Both routes are timed by the same pipeline over the same terrain, so the
 * difference between them is attributable to the choice of path and nothing
 * else. That comparison is what the UI reports — going further, and arriving
 * sooner for it, is the whole claim the router is making.
 */
export function buildRoute(world, from, to) {
  const { grid, coarse } = world;

  const direct = haversine(from.lat, from.lon, to.lat, to.lon);
  if (direct < 1) return { ...EMPTY_ROUTE };

  const planned = grid && coarse
    ? planPath(grid, coarse, from, to, (a, b) => referenceSeconds(world, a, b))
    : null;

  const path = planned ? planned.path : [{ ...from }, { ...to }];
  const route = measurePath(world, path, direct);
  route.expanded = planned?.expanded ?? 0;

  if (planned) {
    const straight = measurePath(world, [{ ...from }, { ...to }], direct);
    route.straight = {
      totalMetres: straight.totalMetres,
      totalSeconds: straight.totalSeconds,
      runMetres: straight.runMetres,
      swimMetres: straight.swimMetres,
      ascent: straight.ascent,
      legs: straight.legs.length,
    };
    route.secondsSaved = straight.totalSeconds - route.totalSeconds;
    // Both paths deliver between the same two points, so straight-line distance
    // over elapsed time is the honest measure of how fast the message travelled.
    route.speedup = straight.totalSeconds / route.totalSeconds;
    route.effectiveSpeed = direct / route.totalSeconds;
    route.straightSpeed = direct / straight.totalSeconds;
  }

  return route;
}

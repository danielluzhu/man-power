/**
 * sphere.js — pure great-circle math, with no runtime dependencies.
 *
 * Shared verbatim by the server (routing, arrival times) and the browser
 * (animating the courier between polls). The server serves this file to the
 * client at /sphere.js so both sides run the same code rather than a copy that
 * can drift.
 */

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

/** Cumulative distance along a polyline, in metres. */
export function cumulative(points) {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    out[i] = out[i - 1] + haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return out;
}

/** The point a fraction `f` of the way along a polyline, by distance. */
export function pointAlong(points, f) {
  if (points.length === 1) return { ...points[0] };
  const marks = cumulative(points);
  const total = marks[marks.length - 1];
  if (total === 0) return { ...points[0] };

  const target = Math.max(0, Math.min(1, f)) * total;
  let i = 1;
  while (i < marks.length - 1 && marks[i] < target) i++;

  const span = marks[i] - marks[i - 1];
  const within = span > 0 ? (target - marks[i - 1]) / span : 0;
  const a = points[i - 1], b = points[i];
  return interpolate(a.lat, a.lon, b.lat, b.lon, within);
}

/**
 * Where is the courier after `elapsed` seconds? Returns their position, the leg
 * they are on and overall progress, or null once they have arrived.
 *
 * The courier follows the planned path, so position is found by walking the
 * leg's own polyline rather than a great circle between the endpoints. Within a
 * single leg the pace is treated as even, which smooths over the fact that the
 * far side of a mountain is run faster than the near side.
 */
export function positionAt(route, elapsed) {
  if (!route?.legs?.length) return null;
  if (elapsed >= route.totalSeconds) return null;
  const t = Math.max(0, elapsed);

  for (const leg of route.legs) {
    if (t > leg.endSeconds) continue;
    const within = leg.seconds > 0 ? (t - leg.startSeconds) / leg.seconds : 0;
    const p = pointAlong(leg.points, within);
    const fraction = leg.startF + within * (leg.endF - leg.startF);

    return {
      ...p,
      mode: leg.mode,
      fraction,
      metresCovered: route.totalMetres * fraction,
      metresRemaining: route.totalMetres * (1 - fraction),
      secondsRemaining: route.totalSeconds - t,
    };
  }
  return null;
}

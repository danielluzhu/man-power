/**
 * Routing tests.
 *
 * These check properties that must hold for any route — legs tile the journey,
 * timings sum, surfaces alternate — rather than pinning exact distances, which
 * would only re-assert the geometry. The one exception is the headline
 * invariant at the bottom: a planned route must never be slower than simply
 * running the straight line, because that is the whole point of planning it.
 */

import { expect, test, describe, beforeAll } from "bun:test";
import { LandMask, buildRoute, haversine, interpolate } from "../src/geo.js";
import { positionAt, pointAlong } from "../src/sphere.js";
import { Elevation } from "../src/terrain.js";
import { RoutingGrid } from "../src/router.js";

const CITY = {
  nyc:        { lat: 40.7128, lon: -74.0060 },
  la:         { lat: 34.0522, lon: -118.2437 },
  london:     { lat: 51.5074, lon: -0.1278 },
  tokyo:      { lat: 35.6762, lon: 139.6503 },
  sydney:     { lat: -33.8688, lon: 151.2093 },
  santiago:   { lat: -33.4489, lon: -70.6693 },
  madrid:     { lat: 40.4168, lon: -3.7038 },
  casablanca: { lat: 33.5731, lon: -7.5898 },
  delhi:      { lat: 28.6139, lon: 77.2090 },
  beijing:    { lat: 39.9042, lon: 116.4074 },
};

let world, straight;

beforeAll(async () => {
  const mask = await LandMask.load();
  const elevation = await Elevation.fromGzip(await Bun.file("data/elevation.bin.gz").arrayBuffer());
  world = {
    mask,
    elevation,
    grid: RoutingGrid.downsample(mask, elevation, 0.2),
    coarse: RoutingGrid.downsample(mask, elevation, 1.0, { optimistic: true }),
  };
  // Without routing grids, buildRoute falls back to the straight line — which
  // makes it the control these tests measure planned routes against.
  straight = { mask, elevation };
});

describe("the land mask", () => {
  test("knows land from water", () => {
    const land = [[40.71, -74.01], [51.51, -0.13], [23, 10], [-1.29, 36.82], [35.68, 139.69]];
    const water = [[40, -40], [0, -140], [-20, 80], [43, 34], [0, -25]];
    for (const [lat, lon] of land) expect(world.mask.isLand(lat, lon)).toBe(true);
    for (const [lat, lon] of water) expect(world.mask.isLand(lat, lon)).toBe(false);
  });

  test("wraps the antimeridian instead of clamping", () => {
    expect(world.mask.isLand(0, 181)).toBe(world.mask.isLand(0, -179));
  });
});

describe("great-circle geometry", () => {
  test("haversine matches a known intercity distance", () => {
    expect(haversine(40.7128, -74.006, 51.5074, -0.1278) / 1000).toBeCloseTo(5570, -2);
  });

  test("interpolation hits both endpoints and the midpoint", () => {
    const a = CITY.nyc, b = CITY.london;
    expect(interpolate(a.lat, a.lon, b.lat, b.lon, 0).lat).toBeCloseTo(a.lat, 6);
    expect(interpolate(a.lat, a.lon, b.lat, b.lon, 1).lat).toBeCloseTo(b.lat, 6);
    const mid = interpolate(a.lat, a.lon, b.lat, b.lon, 0.5);
    expect(haversine(a.lat, a.lon, mid.lat, mid.lon)).toBeCloseTo(haversine(a.lat, a.lon, b.lat, b.lon) / 2, 0);
  });

  test("pointAlong walks a polyline by distance", () => {
    const line = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 0, lon: 20 }];
    expect(pointAlong(line, 0).lon).toBeCloseTo(0, 6);
    expect(pointAlong(line, 0.5).lon).toBeCloseTo(10, 4);
    expect(pointAlong(line, 1).lon).toBeCloseTo(20, 6);
  });
});

describe("route construction", () => {
  const PAIRS = {
    "NYC–LA": [CITY.nyc, CITY.la],
    "NYC–London": [CITY.nyc, CITY.london],
    "Tokyo–Sydney": [CITY.tokyo, CITY.sydney],
    "Santiago–Tokyo": [CITY.santiago, CITY.tokyo],
    "Delhi–Beijing": [CITY.delhi, CITY.beijing],
  };

  for (const [name, pair] of Object.entries(PAIRS)) {
    test(`${name}: legs tile the journey and the timings sum`, () => {
      const route = buildRoute(world, ...pair);

      const legMetres = route.legs.reduce((n, l) => n + l.metres, 0);
      expect(legMetres).toBeCloseTo(route.totalMetres, 3);
      expect(route.runMetres + route.swimMetres).toBeCloseTo(route.totalMetres, 3);

      expect(route.legs[0].startF).toBeCloseTo(0, 9);
      expect(route.legs.at(-1).endF).toBeCloseTo(1, 9);
      for (let i = 1; i < route.legs.length; i++) {
        expect(route.legs[i].startF).toBeCloseTo(route.legs[i - 1].endF, 9);
      }

      const legSeconds = route.legs.reduce((n, l) => n + l.seconds, 0);
      expect(legSeconds).toBeCloseTo(route.totalSeconds, 3);
    });
  }

  test("surfaces alternate — no two adjacent legs share a mode", () => {
    const route = buildRoute(world, CITY.tokyo, CITY.sydney);
    for (let i = 1; i < route.legs.length; i++) {
      expect(route.legs[i].mode).not.toBe(route.legs[i - 1].mode);
    }
  });

  test("both endpoints are treated as land, since cities are", () => {
    const route = buildRoute(world, CITY.tokyo, CITY.sydney);
    expect(route.legs[0].mode).toBe("run");
    expect(route.legs.at(-1).mode).toBe("run");
  });

  test("the path begins and ends at the exact coordinates given", () => {
    const route = buildRoute(world, CITY.madrid, CITY.casablanca);
    expect(route.path[0].lat).toBeCloseTo(CITY.madrid.lat, 6);
    expect(route.path.at(-1).lon).toBeCloseTo(CITY.casablanca.lon, 6);
  });

  test("a coast-to-coast US route is run end to end", () => {
    const route = buildRoute(world, CITY.nyc, CITY.la);
    expect(route.swimMetres).toBe(0);
    expect(route.legs.every((l) => l.mode === "run")).toBe(true);
  });
});

describe("planning beats going straight", () => {
  const PAIRS = {
    "NYC–London": [CITY.nyc, CITY.london],
    "NYC–LA": [CITY.nyc, CITY.la],
    "Madrid–Casablanca": [CITY.madrid, CITY.casablanca],
    "Delhi–Beijing": [CITY.delhi, CITY.beijing],
    "Tokyo–Sydney": [CITY.tokyo, CITY.sydney],
  };

  for (const [name, pair] of Object.entries(PAIRS)) {
    test(`${name}: the planned route is never slower than the direct line`, () => {
      const planned = buildRoute(world, ...pair);
      const direct = buildRoute(straight, ...pair);
      // A hair of tolerance: planning and timing sample the ground differently.
      expect(planned.totalSeconds).toBeLessThanOrEqual(direct.totalSeconds * 1.001);
    });
  }

  test("Madrid to Casablanca crosses at Gibraltar rather than swimming wide", () => {
    const planned = buildRoute(world, CITY.madrid, CITY.casablanca);
    const direct = buildRoute(straight, CITY.madrid, CITY.casablanca);

    expect(planned.swimMetres).toBeLessThan(direct.swimMetres / 3);
    const widest = Math.max(...planned.legs.filter((l) => l.mode === "swim").map((l) => l.metres));
    expect(widest).toBeLessThan(60_000); // the strait is about 14 km across
  });

  test("New York to London island-hops instead of crossing the open Atlantic", () => {
    const planned = buildRoute(world, CITY.nyc, CITY.london);
    const direct = buildRoute(straight, CITY.nyc, CITY.london);

    expect(planned.swimMetres).toBeLessThan(direct.swimMetres);
    expect(planned.totalMetres).toBeGreaterThan(direct.totalMetres); // it goes further
    expect(planned.totalSeconds).toBeLessThan(direct.totalSeconds);  // and arrives sooner
  });

  test("Delhi to Beijing climbs less than going straight over the Himalaya", () => {
    const planned = buildRoute(world, CITY.delhi, CITY.beijing);
    const direct = buildRoute(straight, CITY.delhi, CITY.beijing);
    expect(planned.ascent).toBeLessThan(direct.ascent);
  });
});

describe("comparison with the direct line", () => {
  test("every planned route reports what going straight would have cost", () => {
    const route = buildRoute(world, CITY.nyc, CITY.london);
    expect(route.straight).toBeDefined();
    expect(route.straight.totalSeconds).toBeGreaterThan(0);
    expect(route.secondsSaved).toBeCloseTo(route.straight.totalSeconds - route.totalSeconds, 6);
    expect(route.speedup).toBeCloseTo(route.straight.totalSeconds / route.totalSeconds, 9);
  });

  test("the straight-line figures match measuring it directly", () => {
    const planned = buildRoute(world, CITY.madrid, CITY.casablanca);
    const direct = buildRoute(straight, CITY.madrid, CITY.casablanca);
    expect(planned.straight.totalSeconds).toBeCloseTo(direct.totalSeconds, 6);
    expect(planned.straight.swimMetres).toBeCloseTo(direct.swimMetres, 6);
  });

  test("speeds are measured over the direct distance, so they are comparable", () => {
    const route = buildRoute(world, CITY.nyc, CITY.london);
    expect(route.effectiveSpeed).toBeCloseTo(route.directMetres / route.totalSeconds, 9);
    expect(route.straightSpeed).toBeCloseTo(route.directMetres / route.straight.totalSeconds, 9);
    // Speeding up by the time ratio and by the speed ratio must agree.
    expect(route.effectiveSpeed / route.straightSpeed).toBeCloseTo(route.speedup, 9);
  });

  test("a saving is never negative — the fallback would be available anyway", () => {
    for (const pair of [[CITY.nyc, CITY.la], [CITY.nyc, CITY.london], [CITY.delhi, CITY.beijing]]) {
      const route = buildRoute(world, ...pair);
      expect(route.secondsSaved).toBeGreaterThanOrEqual(-route.totalSeconds * 0.001);
      expect(route.speedup).toBeGreaterThanOrEqual(0.999);
    }
  });

  test("a route with nothing to go around reports no meaningful gain", () => {
    const route = buildRoute(world, CITY.nyc, CITY.la);
    expect(route.speedup).toBeLessThan(1.005);
  });

  test("crossing at Gibraltar is worth well over half again the speed", () => {
    const route = buildRoute(world, CITY.madrid, CITY.casablanca);
    expect(route.speedup).toBeGreaterThan(1.5);
  });
});

describe("terrain reporting", () => {
  test("a land route reports climbing; an ocean leg reports none", () => {
    const route = buildRoute(world, CITY.delhi, CITY.beijing);
    expect(route.ascent).toBeGreaterThan(1000);
    expect(route.peak).toBeGreaterThan(1000);
    for (const leg of route.legs.filter((l) => l.mode === "swim")) {
      expect(leg.ascent).toBe(0);
      expect(leg.peak).toBe(0);
    }
  });

  test("ascent and descent are each the sum of their legs", () => {
    const route = buildRoute(world, CITY.nyc, CITY.la);
    expect(route.ascent).toBe(route.legs.reduce((n, l) => n + l.ascent, 0));
    expect(route.descent).toBe(route.legs.reduce((n, l) => n + l.descent, 0));
  });
});

describe("courier tracking", () => {
  let route;
  beforeAll(() => { route = buildRoute(world, CITY.nyc, CITY.london); });

  test("starts at the origin and advances monotonically", () => {
    const start = positionAt(route, 0);
    expect(start.lat).toBeCloseTo(CITY.nyc.lat, 2);
    expect(start.fraction).toBeCloseTo(0, 6);

    let previous = -1;
    for (let f = 0; f < 1; f += 0.05) {
      const pos = positionAt(route, route.totalSeconds * f);
      expect(pos.fraction).toBeGreaterThan(previous);
      previous = pos.fraction;
    }
  });

  test("reports null once the courier has arrived", () => {
    expect(positionAt(route, route.totalSeconds)).toBeNull();
    expect(positionAt(route, route.totalSeconds * 2)).toBeNull();
  });

  test("stays on the planned path, not the straight line", () => {
    // The route arcs far north of the direct New York–London line; at the
    // halfway mark the courier should be nowhere near it.
    const pos = positionAt(route, route.totalSeconds / 2);
    const onDirect = interpolate(CITY.nyc.lat, CITY.nyc.lon, CITY.london.lat, CITY.london.lon, 0.5);
    expect(haversine(pos.lat, pos.lon, onDirect.lat, onDirect.lon)).toBeGreaterThan(500_000);
  });
});

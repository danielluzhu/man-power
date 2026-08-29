/**
 * Routing tests. These check the properties that must hold for any route —
 * legs tile the whole journey, timings sum, surfaces are classified correctly —
 * rather than pinning exact distances, which would only re-assert the geometry.
 */

import { expect, test, describe, beforeAll } from "bun:test";
import { LandMask, buildRoute, haversine, interpolate, positionAt } from "../src/geo.js";

const CITY = {
  nyc:      { lat: 40.7128, lon: -74.0060 },
  la:       { lat: 34.0522, lon: -118.2437 },
  london:   { lat: 51.5074, lon: -0.1278 },
  tokyo:    { lat: 35.6762, lon: 139.6503 },
  sydney:   { lat: -33.8688, lon: 151.2093 },
  santiago: { lat: -33.4489, lon: -70.6693 },
};

let mask;
beforeAll(async () => { mask = await LandMask.load(); });

describe("the land mask", () => {
  test("knows land from water", () => {
    const land = [[40.71, -74.01], [51.51, -0.13], [23, 10], [-1.29, 36.82], [35.68, 139.69]];
    const water = [[40, -40], [0, -140], [-20, 80], [43, 34], [0, -25]];
    for (const [lat, lon] of land) expect(mask.isLand(lat, lon)).toBe(true);
    for (const [lat, lon] of water) expect(mask.isLand(lat, lon)).toBe(false);
  });

  test("wraps the antimeridian instead of clamping", () => {
    expect(mask.isLand(0, 181)).toBe(mask.isLand(0, -179));
  });
});

describe("great-circle geometry", () => {
  test("haversine matches a known intercity distance", () => {
    // NYC to London is about 5570 km.
    expect(haversine(40.7128, -74.006, 51.5074, -0.1278) / 1000).toBeCloseTo(5570, -2);
  });

  test("interpolation hits both endpoints and the midpoint", () => {
    const a = CITY.nyc, b = CITY.london;
    expect(interpolate(a.lat, a.lon, b.lat, b.lon, 0).lat).toBeCloseTo(a.lat, 6);
    expect(interpolate(a.lat, a.lon, b.lat, b.lon, 1).lat).toBeCloseTo(b.lat, 6);

    const mid = interpolate(a.lat, a.lon, b.lat, b.lon, 0.5);
    const half = haversine(a.lat, a.lon, b.lat, b.lon) / 2;
    expect(haversine(a.lat, a.lon, mid.lat, mid.lon)).toBeCloseTo(half, 0);
  });
});

describe("route construction", () => {
  test("a coast-to-coast US route is run end to end", () => {
    const route = buildRoute(mask, CITY.nyc, CITY.la);
    expect(route.swimMetres).toBe(0);
    expect(route.legs.every((l) => l.mode === "run")).toBe(true);
  });

  test("a transatlantic route is mostly swum", () => {
    const route = buildRoute(mask, CITY.nyc, CITY.london);
    expect(route.swimMetres).toBeGreaterThan(route.runMetres);
    expect(route.legs.length).toBeGreaterThan(1);
  });

  for (const [name, pair] of Object.entries({
    "NYC–LA": [CITY.nyc, CITY.la],
    "NYC–London": [CITY.nyc, CITY.london],
    "Tokyo–Sydney": [CITY.tokyo, CITY.sydney],
    "Santiago–Tokyo": [CITY.santiago, CITY.tokyo],
  })) {
    test(`${name}: legs tile the journey and the timings sum`, () => {
      const route = buildRoute(mask, ...pair);

      // Every metre is accounted for exactly once.
      const legMetres = route.legs.reduce((n, l) => n + l.metres, 0);
      expect(legMetres).toBeCloseTo(route.totalMetres, 3);
      expect(route.runMetres + route.swimMetres).toBeCloseTo(route.totalMetres, 3);

      // Legs are contiguous in fraction-of-journey terms, start to finish.
      expect(route.legs[0].startF).toBe(0);
      expect(route.legs.at(-1).endF).toBe(1);
      for (let i = 1; i < route.legs.length; i++) {
        expect(route.legs[i].startF).toBeCloseTo(route.legs[i - 1].endF, 9);
      }

      // And durations sum to the total the message will be timed against.
      const legSeconds = route.legs.reduce((n, l) => n + l.seconds, 0);
      expect(legSeconds).toBeCloseTo(route.totalSeconds, 3);
    });
  }

  test("surfaces alternate — no two adjacent legs share a mode", () => {
    const route = buildRoute(mask, CITY.tokyo, CITY.sydney);
    for (let i = 1; i < route.legs.length; i++) {
      expect(route.legs[i].mode).not.toBe(route.legs[i - 1].mode);
    }
  });

  test("both endpoints are treated as land, since cities are", () => {
    const route = buildRoute(mask, CITY.tokyo, CITY.sydney);
    expect(route.legs[0].mode).toBe("run");
    expect(route.legs.at(-1).mode).toBe("run");
  });
});

describe("courier tracking", () => {
  const route = () => buildRoute(mask, CITY.nyc, CITY.london);

  test("starts at the origin and advances monotonically", () => {
    const r = route();
    const start = positionAt(r, 0, CITY.nyc, CITY.london);
    expect(start.lat).toBeCloseTo(CITY.nyc.lat, 3);
    expect(start.fraction).toBe(0);

    let previous = -1;
    for (let f = 0; f < 1; f += 0.05) {
      const pos = positionAt(r, r.totalSeconds * f, CITY.nyc, CITY.london);
      expect(pos.fraction).toBeGreaterThan(previous);
      previous = pos.fraction;
    }
  });

  test("reports null once the courier has arrived", () => {
    const r = route();
    expect(positionAt(r, r.totalSeconds, CITY.nyc, CITY.london)).toBeNull();
    expect(positionAt(r, r.totalSeconds * 2, CITY.nyc, CITY.london)).toBeNull();
  });

  test("the halfway point in time is out in the Atlantic", () => {
    const r = route();
    const pos = positionAt(r, r.totalSeconds / 2, CITY.nyc, CITY.london);
    expect(pos.mode).toBe("swim");
    expect(mask.isLand(pos.lat, pos.lon)).toBe(false);
  });
});

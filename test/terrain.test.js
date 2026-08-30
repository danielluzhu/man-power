/**
 * Terrain model tests — the gradient and altitude physics, and the elevation
 * grid they read from.
 */

import { expect, test, describe, beforeAll } from "bun:test";
import {
  Elevation, costOfRunning, gradientFactor, altitudeFactor, terrainFactor,
  DOWNHILL_CAP, ALTITUDE_THRESHOLD, MAX_GRADIENT,
} from "../src/terrain.js";

describe("Minetti's cost of running", () => {
  test("flat ground costs 3.6 J/kg/m, and runs at flat pace", () => {
    expect(costOfRunning(0)).toBeCloseTo(3.6, 10);
    expect(gradientFactor(0)).toBeCloseTo(1, 10);
  });

  test("uphill always costs more than flat, and steeper costs more still", () => {
    let previous = costOfRunning(0);
    for (let i = 0.02; i <= MAX_GRADIENT; i += 0.02) {
      const cost = costOfRunning(i);
      expect(cost).toBeGreaterThan(previous);
      previous = cost;
    }
  });

  test("speed falls monotonically as the climb steepens", () => {
    let previous = gradientFactor(0);
    for (let i = 0.02; i <= MAX_GRADIENT; i += 0.02) {
      const factor = gradientFactor(i);
      expect(factor).toBeLessThan(previous);
      previous = factor;
    }
  });

  test("a 10% climb roughly halves the pace", () => {
    expect(gradientFactor(0.1)).toBeGreaterThan(0.5);
    expect(gradientFactor(0.1)).toBeLessThan(0.7);
  });

  test("downhill helps, but never past the cap", () => {
    expect(gradientFactor(-0.05)).toBeGreaterThan(1);
    for (let i = -MAX_GRADIENT; i < 0; i += 0.01) {
      expect(gradientFactor(i)).toBeLessThanOrEqual(DOWNHILL_CAP);
    }
  });

  test("gradients beyond the fitted range are clamped, not extrapolated", () => {
    expect(gradientFactor(5)).toBe(gradientFactor(MAX_GRADIENT));
    expect(gradientFactor(-5)).toBe(gradientFactor(-MAX_GRADIENT));
  });
});

describe("altitude", () => {
  test("has no effect at or below the threshold", () => {
    expect(altitudeFactor(0)).toBe(1);
    expect(altitudeFactor(ALTITUDE_THRESHOLD)).toBe(1);
    expect(altitudeFactor(-100)).toBe(1);
  });

  test("costs about 1% of pace per 100 m above it", () => {
    expect(altitudeFactor(ALTITUDE_THRESHOLD + 1000)).toBeCloseTo(0.9, 6);
    expect(altitudeFactor(ALTITUDE_THRESHOLD + 2000)).toBeCloseTo(0.8, 6);
  });

  test("falls monotonically and never to zero", () => {
    let previous = 1;
    for (let h = 1500; h <= 9000; h += 250) {
      const factor = altitudeFactor(h);
      expect(factor).toBeLessThanOrEqual(previous);
      expect(factor).toBeGreaterThan(0.3);
      previous = factor;
    }
  });
});

describe("the two combined", () => {
  test("flat ground at sea level leaves pace untouched", () => {
    expect(terrainFactor(0, 1000, 0)).toBeCloseTo(1, 10);
  });

  test("climbing at altitude is worse than either alone", () => {
    const both = terrainFactor(100, 1000, 4000);
    expect(both).toBeLessThan(gradientFactor(0.1));
    expect(both).toBeLessThan(altitudeFactor(4000));
  });

  test("a zero-length step is a no-op rather than a division by zero", () => {
    expect(terrainFactor(10, 0, 0)).toBe(1);
  });
});

describe("the elevation grid", () => {
  let elevation;
  beforeAll(async () => {
    elevation = await Elevation.fromGzip(await Bun.file("data/elevation.bin.gz").arrayBuffer());
  });

  test("matches the land mask's grid", () => {
    expect(elevation.width).toBe(3600);
    expect(elevation.height).toBe(1800);
  });

  test("reports known elevations within tolerance", () => {
    const places = [
      ["Amsterdam", 52.37, 4.90, -20, 60], // much of the city is below sea level
      ["Denver", 39.74, -104.99, 1400, 1900],
      ["Lhasa", 29.65, 91.13, 3300, 4000],
      ["La Paz", -16.50, -68.15, 3500, 4200],
      ["Eldoret", 0.52, 35.27, 1800, 2400],
    ];
    for (const [, lat, lon, low, high] of places) {
      const height = elevation.at(lat, lon);
      expect(height).toBeGreaterThanOrEqual(low);
      expect(height).toBeLessThanOrEqual(high);
    }
  });

  test("Death Valley is below sea level", () => {
    expect(elevation.at(36.5, -116.9)).toBeLessThan(0);
  });

  test("open ocean is stored flat", () => {
    for (const [lat, lon] of [[40, -40], [0, -140], [-20, 80]]) {
      expect(elevation.at(lat, lon)).toBe(0);
    }
  });

  test("wraps the antimeridian", () => {
    expect(elevation.at(0, 181)).toBe(elevation.at(0, -179));
  });
});

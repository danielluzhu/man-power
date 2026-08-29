/**
 * The pace model is the one part of this app that has a right answer, so it is
 * pinned here: every record must come back out of the curve exactly as it went
 * in, and the two rules stated in the UI must actually hold.
 */

import { expect, test, describe } from "bun:test";
import {
  RUN_LADDER, SWIM_LADDER, runSeconds, swimSeconds,
  runRecordFor, parseTime, assertMonotonic, CONSTANTS,
} from "../src/records.js";

const { MILE, MARATHON } = CONSTANTS;

describe("time parsing", () => {
  test("reads every format used in the ladders", () => {
    expect(parseTime("20.91")).toBeCloseTo(20.91, 5);
    expect(parseTime("3:42.66")).toBeCloseTo(222.66, 5);
    expect(parseTime("1:59:30")).toBe(7170);
  });
});

describe("the ladders", () => {
  test("speed falls as distance rises, on both surfaces", () => {
    expect(assertMonotonic(RUN_LADDER, "running")).toBe(true);
    expect(assertMonotonic(SWIM_LADDER, "swimming")).toBe(true);
  });

  test("the curve reproduces each record exactly at its own distance", () => {
    for (const r of RUN_LADDER) expect(runSeconds(r.m)).toBeCloseTo(r.seconds, 6);
    for (const r of SWIM_LADDER) expect(swimSeconds(r.m)).toBeCloseTo(r.seconds, 6);
  });

  test("the two records fixed by specification are the ones in the ladder", () => {
    const mile = RUN_LADDER.find((r) => r.m === MILE);
    expect(mile.athlete).toBe("Josh Kerr");
    expect(mile.seconds).toBeCloseTo(222.66, 5);

    const marathon = RUN_LADDER.find((r) => r.m === MARATHON);
    expect(marathon.athlete).toBe("Sabastian Sawe");
    expect(marathon.seconds).toBe(7170);
  });
});

describe("the two stated rules", () => {
  test("under a mile holds Kerr's mile pace", () => {
    const milePace = MILE / 222.66;
    for (const d of [50, 400, 1000, 1609]) {
      expect(runSeconds(d)).toBeCloseTo(d / milePace, 6);
    }
  });

  test("past the marathon holds Sawe's marathon pace, however far", () => {
    const marathonPace = MARATHON / 7170;
    for (const d of [50_000, 1_000_000, 20_000_000]) {
      expect(runSeconds(d)).toBeCloseTo(d / marathonPace, 6);
    }
  });

  test("a transatlantic swim holds Sun Yang's 1500 m pace", () => {
    const pace = 1500 / parseTime("14:30.67");
    expect(swimSeconds(5_000_000)).toBeCloseTo(5_000_000 / pace, 6);
  });
});

describe("interpolation between records", () => {
  test("a distance between two records lands between their paces", () => {
    // 7 km sits between the 5000 m and 10,000 m records.
    const speed = 7000 / runSeconds(7000);
    const fast = RUN_LADDER.find((r) => r.m === 5000).speed;
    const slow = RUN_LADDER.find((r) => r.m === 10000).speed;
    expect(speed).toBeLessThan(fast);
    expect(speed).toBeGreaterThan(slow);
  });

  test("time is strictly increasing in distance", () => {
    let previous = 0;
    for (let d = 100; d < 100_000; d *= 1.3) {
      const t = runSeconds(d);
      expect(t).toBeGreaterThan(previous);
      previous = t;
    }
  });

  test("the governing record is named for reporting", () => {
    expect(runRecordFor(300).athlete).toBe("Josh Kerr");
    expect(runRecordFor(4_000_000).athlete).toBe("Sabastian Sawe");
    expect(runRecordFor(14_500).label).toBe("15 km");
  });
});

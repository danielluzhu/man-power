/**
 * records.js — the engine that turns a distance into a travel time.
 *
 * Man Power delivers messages at the speed of the fastest human who has ever
 * covered that distance. Two ladders of world records are encoded below: one
 * for running (overland legs) and one for swimming (water legs).
 *
 * PACE, NOT TIME
 * --------------
 * A record is applied as a *pace*, not as a flat duration. A 400 m hop does not
 * take Josh Kerr's full 3:42.66 — it takes 400 m at his mile pace. This is the
 * only reading that stays coherent at the long end, where the marathon record
 * has to cover journeys of thousands of kilometres.
 *
 * BETWEEN THE ANCHORS
 * -------------------
 * Real records exist at fixed distances. For everything in between we
 * interpolate linearly in log(distance) vs log(time) space — the standard
 * endurance-curve relationship (Riegel). The curve therefore passes exactly
 * through every record below and bends smoothly between them.
 *
 * OUTSIDE THE ANCHORS
 * -------------------
 * Below the shortest anchor and above the longest, pace is held flat at that
 * anchor's pace. This is why anything under a mile runs at Kerr's mile pace and
 * anything past 26.2 miles runs at Sawe's marathon pace.
 */

/** Parse "1:59:30", "3:42.66" or "20.91" into seconds. */
export function parseTime(str) {
  const parts = String(str).split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const MILE = 1609.344;
const MARATHON = 42195;

/**
 * Running ladder — men's world records.
 *
 * The two endpoints are pinned by specification: Josh Kerr's mile anchors
 * everything at or below a mile, and Sabastian Sawe's 1:59:30 marathon anchors
 * everything at or beyond 26.2 miles.
 *
 * Note on omissions: the 2 mile, 10 mile and 30 km bests are all *slower* in
 * pace terms than their neighbours on this ladder (the sub-two-hour marathon
 * pace outruns the standing 30 km best, for one). Including them would make the
 * curve non-monotonic — a longer journey could arrive before a shorter one — so
 * they are left off the ladder. `assertMonotonic()` below enforces this.
 */
export const RUN_RECORDS = [
  { m: MILE,     time: "3:42.66",  athlete: "Josh Kerr",       nation: "GBR", year: 2024, label: "1 mile" },
  { m: 2000,     time: "4:43.13",  athlete: "Hicham El Guerrouj", nation: "MAR", year: 1999, label: "2000 m" },
  { m: 3000,     time: "7:17.55",  athlete: "Daniel Komen",    nation: "KEN", year: 1996, label: "3000 m" },
  { m: 5000,     time: "12:35.36", athlete: "Joshua Cheptegei", nation: "UGA", year: 2020, label: "5000 m" },
  { m: 10000,    time: "26:11.00", athlete: "Joshua Cheptegei", nation: "UGA", year: 2020, label: "10,000 m" },
  { m: 15000,    time: "40:16",    athlete: "Jacob Kiplimo",   nation: "UGA", year: 2025, label: "15 km", note: "en route to his half marathon record" },
  { m: 21097.5,  time: "56:42",    athlete: "Jacob Kiplimo",   nation: "UGA", year: 2025, label: "half marathon" },
  { m: 25000,    time: "1:10:30",  athlete: "Dennis Kimetto",  nation: "KEN", year: 2012, label: "25 km" },
  { m: MARATHON, time: "1:59:30",  athlete: "Sabastian Sawe",  nation: "KEN", year: 2025, label: "marathon" },
];

/**
 * Swimming ladder — men's long-course freestyle world records.
 * Water legs are swum. Beyond 1500 m — the longest distance with a standing
 * world record — pace is held at Sun Yang's 1500 m pace, however wide the ocean.
 */
export const SWIM_RECORDS = [
  { m: 50,   time: "20.91",   athlete: "César Cielo",     nation: "BRA", year: 2009, label: "50 m free" },
  { m: 100,  time: "46.40",   athlete: "Pan Zhanle",      nation: "CHN", year: 2024, label: "100 m free" },
  { m: 200,  time: "1:42.00", athlete: "Paul Biedermann", nation: "GER", year: 2009, label: "200 m free" },
  { m: 400,  time: "3:39.96", athlete: "Lukas Märtens",   nation: "GER", year: 2025, label: "400 m free" },
  { m: 800,  time: "7:32.12", athlete: "Zhang Lin",       nation: "CHN", year: 2009, label: "800 m free" },
  { m: 1500, time: "14:30.67",athlete: "Sun Yang",        nation: "CHN", year: 2012, label: "1500 m free" },
];

/** Decorate a raw ladder with parsed seconds and speeds, sorted by distance. */
function prepare(records) {
  return records
    .map((r) => {
      const seconds = parseTime(r.time);
      return { ...r, seconds, speed: r.m / seconds };
    })
    .sort((a, b) => a.m - b.m);
}

export const RUN_LADDER = prepare(RUN_RECORDS);
export const SWIM_LADDER = prepare(SWIM_RECORDS);

/**
 * A ladder is only sane if speed falls as distance rises. Otherwise a longer
 * journey could be delivered sooner than a shorter one along the same route.
 */
export function assertMonotonic(ladder, name) {
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i].speed >= ladder[i - 1].speed) {
      throw new Error(
        `${name} ladder is not monotonic: ${ladder[i].label} (${ladder[i].speed.toFixed(4)} m/s) ` +
        `is not slower than ${ladder[i - 1].label} (${ladder[i - 1].speed.toFixed(4)} m/s)`
      );
    }
  }
  return true;
}

assertMonotonic(RUN_LADDER, "running");
assertMonotonic(SWIM_LADDER, "swimming");

/**
 * Seconds to cover `metres` on a given ladder, via log-log interpolation.
 * Held flat in pace outside the ladder's range.
 */
export function secondsFor(metres, ladder) {
  if (!(metres > 0)) return 0;
  const first = ladder[0];
  const last = ladder[ladder.length - 1];

  if (metres <= first.m) return metres / first.speed;
  if (metres >= last.m) return metres / last.speed;

  for (let i = 1; i < ladder.length; i++) {
    const hi = ladder[i];
    if (metres > hi.m) continue;
    const lo = ladder[i - 1];
    const f =
      (Math.log(metres) - Math.log(lo.m)) / (Math.log(hi.m) - Math.log(lo.m));
    return Math.exp(Math.log(lo.seconds) + f * (Math.log(hi.seconds) - Math.log(lo.seconds)));
  }
  return metres / last.speed;
}

/** Which record governs a given distance, and how it was applied. */
export function governingRecord(metres, ladder) {
  const first = ladder[0];
  const last = ladder[ladder.length - 1];
  if (metres <= first.m) return { ...first, mode: "held at shortest record's pace" };
  if (metres >= last.m) return { ...last, mode: "held at longest record's pace" };
  for (let i = 1; i < ladder.length; i++) {
    if (metres <= ladder[i].m) {
      const lo = ladder[i - 1];
      const hi = ladder[i];
      // Credit the nearer anchor in log space.
      const f = (Math.log(metres) - Math.log(lo.m)) / (Math.log(hi.m) - Math.log(lo.m));
      const near = f < 0.5 ? lo : hi;
      return { ...near, mode: `interpolated between ${lo.label} and ${hi.label}` };
    }
  }
  return { ...last, mode: "held at longest record's pace" };
}

export const runSeconds = (m) => secondsFor(m, RUN_LADDER);
export const swimSeconds = (m) => secondsFor(m, SWIM_LADDER);
export const runRecordFor = (m) => governingRecord(m, RUN_LADDER);
export const swimRecordFor = (m) => governingRecord(m, SWIM_LADDER);

export const CONSTANTS = { MILE, MARATHON };

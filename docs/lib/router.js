/**
 * router.js — least-time pathfinding across the surface of the world.
 *
 * The courier used to run great circles, straight over the Himalaya and
 * straight across the widest part of any ocean in the way. This finds the path
 * they would actually take: the one that gets there soonest.
 *
 * That single objective produces all the behaviour you would hope for, without
 * any of it being special-cased. Swimming is roughly three and a half times
 * slower than running, so a route will detour hundreds of kilometres to cross
 * at a narrow strait rather than swim the wide part. Climbing costs time, so a
 * route rounds a mountain range instead of going over it, and skirts a high
 * plateau where the thin air would slow it down.
 *
 * TWO GRIDS
 * ---------
 * Planning runs on a 0.2° grid (1800 × 900 cells, roughly 22 km). Timing then
 * happens on the original 0.1° mask and elevation data, so the reported numbers
 * keep their resolution even though the search is coarser. The router can
 * therefore be slightly wrong about a strait it could not see — which costs a
 * little optimality, never correctness, since the timer measures what the path
 * actually crosses.
 *
 * THE HEURISTIC
 * -------------
 * Plain A* is hopeless here. A straight-line heuristic divided by the fastest
 * possible speed underestimates ocean crossings by a factor of four, so the
 * search fans out across an entire ocean before it commits.
 *
 * Instead the heuristic comes from a full Dijkstra run backwards from the
 * destination over a 1° grid — 64,800 cells, a few milliseconds. That coarse
 * grid is built *optimistically* (a cell counts as land if any part of it is
 * land, and takes the lowest elevation within it), so its answers can never
 * exceed the true cost and the heuristic stays admissible. It knows where the
 * land bridges and narrow crossings are, which is exactly what a straight-line
 * heuristic cannot.
 */

import { haversine, EARTH_RADIUS } from "./sphere.js";
import { altitudeFactor, gradientFactor, DOWNHILL_CAP } from "./terrain.js";

/** Reference paces used for planning. See the note in buildRoute on why. */
export const PLANNING_RUN_SPEED = 5.8849;  // m/s — marathon world-record pace
export const PLANNING_SWIM_SPEED = 1.7228; // m/s — 1500 m freestyle pace

const DEG = Math.PI / 180;

/** See the note on `heuristic` in findCellPath. */
const HEURISTIC_SAFETY = 0.92;

/* ─────────────────────────────── min-heap ─────────────────────────────── */

/**
 * Binary heap over typed arrays. A* on a million-cell grid pushes hundreds of
 * thousands of entries, and an array-of-objects heap spends most of its time in
 * the allocator.
 */
class MinHeap {
  constructor(capacity = 1 << 16) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }

  #grow() {
    const keys = new Float64Array(this.keys.length * 2);
    const vals = new Int32Array(this.vals.length * 2);
    keys.set(this.keys);
    vals.set(this.vals);
    this.keys = keys;
    this.vals = vals;
  }

  push(key, val) {
    if (this.size === this.keys.length) this.#grow();
    let i = this.size++;
    const { keys, vals } = this;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const last = --this.size;
    const key = keys[last];
    const val = vals[last];

    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= last) break;
      const right = left + 1;
      const child = right < last && keys[right] < keys[left] ? right : left;
      if (keys[child] >= key) break;
      keys[i] = keys[child];
      vals[i] = vals[child];
      i = child;
    }
    if (last > 0) { keys[i] = key; vals[i] = val; }
    return top;
  }
}

/* ──────────────────────────────── the grid ────────────────────────────── */

/**
 * A traversable grid of the world at some resolution, carrying whether each
 * cell is land, how high it is, and how far apart neighbouring cells are.
 */
export class RoutingGrid {
  constructor(width, height, land, elev) {
    this.width = width;
    this.height = height;
    this.land = land;
    this.elev = elev;
    this.resLat = 180 / height;
    this.resLon = 360 / width;

    // Cells narrow towards the poles, so east-west and diagonal spacing are
    // precomputed per row rather than recalculated inside the search loop.
    this.stepNS = EARTH_RADIUS * this.resLat * DEG;
    this.stepEW = new Float64Array(height);
    for (let row = 0; row < height; row++) {
      const lat = 90 - (row + 0.5) * this.resLat;
      this.stepEW[row] = EARTH_RADIUS * Math.cos(lat * DEG) * this.resLon * DEG;
    }
  }

  /**
   * Downsample the 0.1° land mask and elevation grid onto a coarser grid.
   *
   * `optimistic` builds the relaxed grid used for the heuristic: a cell counts
   * as land if any part of it is, and takes the lowest elevation inside it, so
   * its costs can only undershoot the truth. Otherwise a cell is land only if
   * at least half of it is, which keeps narrow straits open as water rather
   * than fusing them into land bridges the courier could run across.
   */
  static downsample(mask, elevation, degrees, { optimistic = false } = {}) {
    const width = Math.round(360 / degrees);
    const height = Math.round(180 / degrees);
    const factor = Math.round(mask.width / width);

    const land = new Uint8Array(width * height);
    const elev = new Int16Array(width * height);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        let landCount = 0;
        let best = optimistic ? Infinity : 0;
        let sum = 0;

        for (let dy = 0; dy < factor; dy++) {
          const fineRow = row * factor + dy;
          const lat = 90 - (fineRow + 0.5) * mask.resLat;
          for (let dx = 0; dx < factor; dx++) {
            const fineCol = col * factor + dx;
            const lon = -180 + (fineCol + 0.5) * mask.resLon;
            if (mask.isLand(lat, lon)) landCount++;
            const h = elevation.atCell(fineRow, fineCol);
            if (optimistic) { if (h < best) best = h; }
            else sum += h;
          }
        }

        const total = factor * factor;
        const i = row * width + col;
        land[i] = (optimistic ? landCount > 0 : landCount * 2 >= total) ? 1 : 0;
        elev[i] = optimistic ? (best === Infinity ? 0 : best) : Math.round(sum / total);
      }
    }

    return new RoutingGrid(width, height, land, elev);
  }

  /** Ground distance of a (dr, dc) step taken from `row`. */
  stepBetween(row, dr, dc) {
    const ns = dr * this.stepNS;
    const ew = dc * this.stepEW[row];
    return Math.sqrt(ns * ns + ew * ew);
  }

  cellAt(lat, lon) {
    let row = Math.floor((90 - lat) / this.resLat);
    if (row < 0) row = 0;
    else if (row >= this.height) row = this.height - 1;
    let col = Math.floor((lon + 180) / this.resLon);
    col = ((col % this.width) + this.width) % this.width;
    return row * this.width + col;
  }

  centreOf(index) {
    const row = Math.floor(index / this.width);
    const col = index % this.width;
    return {
      lat: 90 - (row + 0.5) * this.resLat,
      lon: -180 + (col + 0.5) * this.resLon,
    };
  }

  /**
   * Cities sit on land by definition, but a coastal one can land in a cell this
   * grid calls water. Spiral outwards for the nearest land cell so the journey
   * starts on a beach rather than offshore.
   */
  nearestLand(index, maxRings = 12) {
    if (this.land[index]) return index;
    const row = Math.floor(index / this.width);
    const col = index % this.width;

    for (let ring = 1; ring <= maxRings; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const r = row + dy;
        if (r < 0 || r >= this.height) continue;
        const edge = Math.abs(dy) === ring;
        for (let dx = -ring; dx <= ring; dx += edge ? 1 : 2 * ring) {
          const c = ((col + dx) % this.width + this.width) % this.width;
          const candidate = r * this.width + c;
          if (this.land[candidate]) return candidate;
        }
      }
    }
    return index; // genuinely surrounded by water; swim from here
  }
}

/* ───────────────────────────── traversal cost ─────────────────────────── */

/**
 * Seconds to move between two adjacent cells.
 *
 * A step counts as swimming unless both ends are dry, so wading out from a
 * beach is a swim while running along a coastline is not.
 */
function stepSeconds(grid, from, to, metres, optimistic) {
  const wet = !(grid.land[from] && grid.land[to]);
  if (wet) return metres / PLANNING_SWIM_SPEED;

  const rise = grid.elev[to] - grid.elev[from];
  const altitude = (grid.elev[from] + grid.elev[to]) / 2;

  // The relaxed grid assumes the most favourable terrain possible, so that its
  // costs never exceed the truth and the heuristic stays admissible.
  const factor = optimistic
    ? DOWNHILL_CAP * altitudeFactor(altitude)
    : gradientFactor(rise / metres) * altitudeFactor(altitude);

  return metres / (PLANNING_RUN_SPEED * factor);
}

/**
 * Neighbour offsets, as (row, column) deltas.
 *
 * Eight neighbours would restrict travel to multiples of 45°, so a path heading
 * anywhere in between comes out as a staircase up to 8.2% longer than the line
 * it is approximating. On a coast-to-coast run that artefact alone outweighs
 * every terrain saving the router might find.
 *
 * Adding the eight knight's-move offsets allows sixteen headings and drops the
 * worst-case overshoot to about 2.6%, for twice the work per expansion.
 */
const NEIGHBOURS = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-2, -1], [-2, 1], [2, -1], [2, 1],
  [-1, -2], [-1, 2], [1, -2], [1, 2],
];

/* ─────────────────────────────── heuristic ────────────────────────────── */

/**
 * Least-cost time from every coarse cell to the goal, by Dijkstra run backwards
 * from it. Costs are symmetric here (the gradient term is not, but the relaxed
 * grid ignores gradient), so a backwards run gives cost-to-go directly.
 */
function costToGoal(coarse, goalCell) {
  const size = coarse.width * coarse.height;
  const dist = new Float64Array(size).fill(Infinity);
  const done = new Uint8Array(size);
  const heap = new MinHeap(1 << 15);

  dist[goalCell] = 0;
  heap.push(0, goalCell);

  while (heap.size > 0) {
    const cell = heap.pop();
    if (done[cell]) continue;
    done[cell] = 1;

    const row = Math.floor(cell / coarse.width);
    const col = cell % coarse.width;
    const base = dist[cell];

    for (const [dr, dc] of NEIGHBOURS) {
      const r = row + dr;
      if (r < 0 || r >= coarse.height) continue;
      const c = ((col + dc) % coarse.width + coarse.width) % coarse.width;
      const next = r * coarse.width + c;
      if (done[next]) continue;

      const metres = coarse.stepBetween(row, dr, dc);
      const candidate = base + stepSeconds(coarse, cell, next, metres, true);
      if (candidate < dist[next]) {
        dist[next] = candidate;
        heap.push(candidate, next);
      }
    }
  }
  return dist;
}

/* ──────────────────────────────── the search ──────────────────────────── */

/**
 * A* from `from` to `to` across `grid`, guided by the coarse cost-to-go field.
 * Returns the cell indices of the path, or null if the goal is unreachable.
 */
export function findCellPath(grid, coarse, from, to) {
  const size = grid.width * grid.height;
  const startCell = grid.nearestLand(grid.cellAt(from.lat, from.lon));
  const goalCell = grid.nearestLand(grid.cellAt(to.lat, to.lon));
  if (startCell === goalCell) return [startCell];

  const goalCoarse = coarse.cellAt(to.lat, to.lon);
  const toGoal = costToGoal(coarse, goalCoarse);
  const scale = Math.round(grid.width / coarse.width);

  /**
   * The coarse grid has a staircase overhead of its own, so its cost-to-go can
   * slightly exceed the fine grid's. Scaling it down keeps the heuristic on the
   * admissible side, at the cost of expanding a few more cells.
   */
  const heuristic = (cell) => {
    const row = Math.floor(cell / grid.width);
    const col = cell % grid.width;
    const h = toGoal[Math.floor(row / scale) * coarse.width + Math.floor(col / scale)];
    return Number.isFinite(h) ? h * HEURISTIC_SAFETY : 0;
  };

  const gScore = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const heap = new MinHeap(1 << 18);

  gScore[startCell] = 0;
  heap.push(heuristic(startCell), startCell);

  let expanded = 0;

  while (heap.size > 0) {
    const cell = heap.pop();
    if (closed[cell]) continue;
    if (cell === goalCell) break;
    closed[cell] = 1;
    expanded++;

    const row = Math.floor(cell / grid.width);
    const col = cell % grid.width;
    const base = gScore[cell];

    for (const [dr, dc] of NEIGHBOURS) {
      const r = row + dr;
      if (r < 0 || r >= grid.height) continue;
      const c = ((col + dc) % grid.width + grid.width) % grid.width;
      const next = r * grid.width + c;
      if (closed[next]) continue;

      const metres = grid.stepBetween(row, dr, dc);
      const candidate = base + stepSeconds(grid, cell, next, metres, false);
      if (candidate < gScore[next]) {
        gScore[next] = candidate;
        cameFrom[next] = cell;
        heap.push(candidate + heuristic(next), next);
      }
    }
  }

  if (cameFrom[goalCell] === -1 && startCell !== goalCell) return null;

  const path = [];
  for (let cell = goalCell; cell !== -1; cell = cameFrom[cell]) path.push(cell);
  path.reverse();
  path.expanded = expanded;
  return path;
}

/* ─────────────────────────── polyline tidying ─────────────────────────── */

/**
 * Perpendicular distance from `p` to the segment `a`–`b`, in degrees with
 * longitude scaled by latitude. Only used for comparing points against a
 * tolerance, so a flat approximation is plenty.
 */
function perpendicular(p, a, b) {
  const k = Math.cos(p.lat * DEG);
  const wrap = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);
  const ax = wrap(a.lon - p.lon) * k, ay = a.lat - p.lat;
  const bx = wrap(b.lon - p.lon) * k, by = b.lat - p.lat;
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(ax, ay);
  let t = -(ax * dx + ay * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Douglas-Peucker, iterative so a long path cannot blow the stack. */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = 0, at = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicular(points[i], points[first], points[last]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance && at !== -1) {
      keep[at] = 1;
      stack.push([first, at], [at, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Pull a path straight wherever that is genuinely faster — "string pulling".
 *
 * A* returns the best path *its* grid can express, which is not the best path.
 * Sixteen headings still cannot draw an arbitrary line, and the planner judges
 * terrain on 0.2° averages while the final timing uses 0.1° detail. Both leave
 * the raw path a little longer and a little hillier than it needs to be — on a
 * flat continental crossing, enough to lose to a plain straight line.
 *
 * So each point is tested against the option of skipping ahead: if going direct
 * from i to j costs less than following the path through every point between,
 * the detour is dropped. `directSeconds` measures a segment with the same model
 * that will time the finished route, so this can only improve the answer.
 *
 * Candidate targets are taken from a halving ladder — furthest first, then half
 * as far, and so on — which finds long shortcuts in O(log n) tests per point
 * rather than the O(n) an exhaustive scan would need.
 */
export function smoothPath(points, directSeconds) {
  const n = points.length;
  if (n < 3) return points.slice();

  // Prefix sums of the original path, so the cost of any span is one subtraction.
  const prefix = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    prefix[i] = prefix[i - 1] + directSeconds(points[i - 1], points[i]);
  }

  const out = [points[0]];
  let i = 0;

  while (i < n - 1) {
    let chosen = i + 1;

    for (let reach = n - 1 - i; reach >= 2; reach = Math.floor(reach / 2)) {
      const j = i + reach;
      if (directSeconds(points[i], points[j]) < prefix[j] - prefix[i]) {
        chosen = j;
        break;
      }
    }

    out.push(points[chosen]);
    i = chosen;
  }
  return out;
}

/**
 * Plan the courier's path between two points.
 *
 * Returns a lat/lon polyline beginning and ending at the exact coordinates
 * given, or null if no path could be found and the caller should fall back to
 * a great circle.
 */
export function planPath(grid, coarse, from, to, directSeconds) {
  const cells = findCellPath(grid, coarse, from, to);
  if (!cells || cells.length < 2) return null;

  const raw = cells.map((cell) => grid.centreOf(cell));

  // Anchor the ends to the real coordinates rather than to cell centres, which
  // can sit up to fifteen kilometres from the city itself.
  raw[0] = { lat: from.lat, lon: from.lon };
  raw[raw.length - 1] = { lat: to.lat, lon: to.lon };

  // Drop the fine staircase geometrically first — it is cheap and leaves the
  // string-pulling pass far fewer points to consider.
  const trimmed = simplify(raw, grid.resLat * 0.25);
  const path = directSeconds ? smoothPath(trimmed, directSeconds) : trimmed;

  return { path, expanded: cells.expanded, cells: cells.length };
}

/** Total length of a polyline, in metres. */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
}

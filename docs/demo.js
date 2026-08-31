/**
 * demo.js — the route calculator on the project site.
 *
 * This imports the app's own modules from ./lib/, copied verbatim at build
 * time by scripts/build-site.js. There is no reimplementation here: the ladder,
 * the log-log interpolation, the coastline splitting and the globe are the same
 * code the server runs. The only thing this file adds is the page around them.
 */

import { LandMask, buildRoute } from "./lib/geo.js";
import { haversine, interpolate } from "./lib/sphere.js";
import { RUN_LADDER, SWIM_LADDER } from "./lib/records.js";
import { Elevation } from "./lib/terrain.js";
import { buildTerrainTexture } from "./lib/terrain-texture.js";
import { RoutingGrid } from "./lib/router.js";
import { Globe } from "./lib/globe.js";

const $ = (sel, root = document) => root.querySelector(sel);

const PRESETS = [
  ["San Francisco", "Shanghai"],
  ["New York City", "London"],
  ["Sydney", "Santiago"],
  ["Cairo", "Cape Town"],
  ["Lisbon", "Reykjavík"],
  ["Mumbai", "Nairobi"],
];

const DAY = 86400, HOUR = 3600, MIN = 60;

/** "31 days, 3 hours" — two units is enough to feel the scale. */
function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < MIN) return `${s} seconds`;
  const parts = [];
  let rest = s;
  for (const [name, size] of [["day", DAY], ["hour", HOUR], ["minute", MIN]]) {
    const n = Math.floor(rest / size);
    rest %= size;
    if (n > 0) parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
    if (parts.length === 2) break;
  }
  return parts.join(", ") || "moments";
}

/** Delivery speed as the crow flies, in km/h. */
const kmh = (metresPerSecond) => `${(metresPerSecond * 3.6).toFixed(1)} km/h`;

/**
 * How the planned route compares with simply running the straight line. Both
 * are timed by the same engine over the same terrain, so the difference is down
 * to the choice of path alone.
 */
function comparison(route) {
  if (!route.straight || route.speedup < 1.005) {
    return `<div class="versus versus--none">
      Straight there — nothing on this route worth going around.
    </div>`;
  }
  return `<div class="versus">
    <div class="versus__headline">${route.speedup.toFixed(2)}× faster than going straight</div>
    <div class="versus__detail">
      ${duration(route.totalSeconds)} instead of ${duration(route.straight.totalSeconds)} —
      arrives ${duration(route.secondsSaved)} sooner<br>
      ${kmh(route.effectiveSpeed)} vs ${kmh(route.straightSpeed)} as the crow flies<br>
      swims ${distance(route.swimMetres)} instead of ${distance(route.straight.swimMetres)}
    </div>
  </div>`;
}

function distance(metres) {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return `${km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(1)} km`;
}

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Vertical metres climbed, and what that is worth comparing to. */
function climb(metres) {
  if (!metres) return "flat";
  return metres >= 10000 ? `${Math.round(metres / 1000)},000 m` : `${metres.toLocaleString()} m`;
}

function everests(metres) {
  const n = metres / 8849;
  return n >= 1.5 ? `${n.toFixed(1)}× Everest` : "";
}

/** Strip diacritics so "Reykjavik" finds "Reykjavík". */
const fold = (str) => str.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/* ──────────────────────────────── state ──────────────────────────────── */

let world, globe, cities, countries, folded;
const ends = { from: null, to: null };

let currentRoute = null;
let freeLook = false;   // the viewer has taken the globe over
let globeDirty = true;

const invalidate = () => { globeDirty = true; };



/* ───────────────────────────── city search ───────────────────────────── */

const cityObject = (c) => ({
  name: c[0], country: countries[c[1]] || c[1], lat: c[3], lon: c[4], population: c[5],
});

function search(query, limit = 8) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const exact = [], prefix = [], contains = [];
  for (let i = 0; i < cities.length; i++) {
    const name = folded[i];
    if (name === q) exact.push(cities[i]);
    else if (name.startsWith(q)) prefix.push(cities[i]);
    else if (name.includes(q)) contains.push(cities[i]);
    if (exact.length + prefix.length >= limit) break;
  }
  return [...exact, ...prefix, ...contains].slice(0, limit).map(cityObject);
}

const findCity = (name) => {
  const q = fold(name);
  const i = folded.indexOf(q);
  return i === -1 ? null : cityObject(cities[i]);
};

function initPicker(root, role) {
  const input = $(".citypick__input", root);
  const list = $(".citypick__results", root);
  let results = [], active = -1, timer;

  const close = () => { list.hidden = true; active = -1; };

  const render = () => {
    if (!results.length) return close();
    list.innerHTML = results
      .map((c, i) => `<li data-i="${i}" class="${i === active ? "is-active" : ""}">
        <span>${escapeHtml(c.name)}</span>
        <span class="citypick__meta">${escapeHtml(c.country)}</span></li>`)
      .join("");
    list.hidden = false;
  };

  const choose = (city) => {
    if (!city) return;
    ends[role] = city;
    input.value = city.name;
    close();
    recompute();
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    if (input.value.trim().length < 2) return close();
    timer = setTimeout(() => {
      results = search(input.value);
      active = results.length ? 0 : -1;
      render();
    }, 110);
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
    else if (e.key === "Escape") close();
  });

  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) { e.preventDefault(); choose(results[Number(li.dataset.i)]); }
  });

  input.addEventListener("focus", () => input.select());
  input.addEventListener("blur", () => setTimeout(close, 120));

  return { input };
}

/* ───────────────────────────── computation ───────────────────────────── */

function recompute() {
  const { from, to } = ends;
  const box = $("#result");
  if (!from || !to) return;

  if (from.name === to.name) {
    currentRoute = null;
    box.innerHTML = `<p class="result__loading">Pick two different cities — you are already there.</p>`;
    return;
  }

  const started = performance.now();
  const route = buildRoute(world, from, to);
  const took = Math.round(performance.now() - started);
  currentRoute = { route, from, to };

  // A new route reframes the globe: centred on the whole path and zoomed so it
  // fills the view. Left alone if the viewer has taken hold of the globe.
  freeLook = false;
  $("#globe-reset").hidden = true;
  const shot = globe?.frameRoute(route, from, to);
  if (shot) globe.lookAt(shot.lat, shot.lon, shot.zoom);
  invalidate();

  const runPct = (route.runMetres / route.totalMetres) * 100;
  const swimPct = 100 - runPct;
  const detour = route.detour > 1.02
    ? `${((route.detour - 1) * 100).toFixed(0)}% further than the direct line`
    : `essentially the direct line`;

  box.innerHTML = `
    <div class="result__route">${escapeHtml(from.name.toUpperCase())} → ${escapeHtml(to.name.toUpperCase())}</div>
    <div class="result__time">${duration(route.totalSeconds)}</div>
    <div class="result__total">${distance(route.totalMetres)} · ${route.legs.length} leg${route.legs.length === 1 ? "" : "s"} · planned in ${took} ms</div>
    <div class="result__detour">${detour}</div>

    <div class="bar">
      <div class="bar__run" style="width:${runPct.toFixed(2)}%"></div>
      <div class="bar__swim" style="width:${swimPct.toFixed(2)}%"></div>
    </div>
    <div class="split">
      <span><b class="is-run">run</b> ${distance(route.runMetres)}</span>
      <span><b class="is-swim">swim</b> ${distance(route.swimMetres)}</span>
      <span><b class="is-climb">climb</b> ${climb(route.ascent)}${everests(route.ascent) ? ` · ${everests(route.ascent)}` : ""}</span>
    </div>

    ${comparison(route)}

    <details class="legs">
      <summary>Leg by leg (${route.legs.length})</summary>
      <ol>
        ${route.legs.map((leg) => `
          <li>
            <span class="${leg.mode === "swim" ? "is-swim" : "is-run"}">${leg.mode}</span>
            ${distance(leg.metres)} · ${duration(leg.seconds)}
            <span class="legs__rec">at ${escapeHtml(leg.record.label)} pace — ${escapeHtml(leg.record.athlete)}</span>
            ${leg.ascent > 200 ? `<span class="legs__rec is-climb">climbing ${climb(leg.ascent)}, peak ${leg.peak.toLocaleString()} m</span>` : ""}
          </li>`).join("")}
      </ol>
    </details>`;
}

/* ───────────────────────────── page assembly ─────────────────────────── */

function renderRecords() {
  const table = (title, rows) => `
    <div class="ladder">
      <h3>${title}</h3>
      <table>
        <thead><tr><th>Distance</th><th class="num">Time</th><th>Held by</th><th class="num">m/s</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.label)}</td>
              <td class="num">${escapeHtml(r.time)}</td>
              <td class="who">${escapeHtml(r.athlete)}
                <span class="nation">${escapeHtml(r.nation)} ’${String(r.year).slice(2)}</span></td>
              <td class="num">${r.speed.toFixed(2)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  $("#records").innerHTML =
    table("On land — running", RUN_LADDER) +
    table("On water — swimming", SWIM_LADDER);
}

function renderPresets(pickers) {
  $("#presets").innerHTML = PRESETS
    .map(([a, b], i) => `<button class="chip" data-preset="${i}">${escapeHtml(a)} → ${escapeHtml(b)}</button>`)
    .join("");

  $("#presets").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-preset]");
    if (!chip) return;
    const [a, b] = PRESETS[Number(chip.dataset.preset)];
    setEnds(pickers, findCity(a), findCity(b));
  });
}

function setEnds(pickers, from, to) {
  if (!from || !to) return;
  ends.from = from;
  ends.to = to;
  pickers.from.input.value = from.name;
  pickers.to.input.value = to.name;
  recompute();
}

function startGlobe(outline) {
  const canvas = $("#globe");
  globe = new Globe(canvas, outline);
  globe.jumpTo(25, -20, 1);

  globe.enableInteraction({
    onInteract: () => { freeLook = true; $("#globe-reset").hidden = false; invalidate(); },
  });

  const resize = () => { globe.resize(); invalidate(); };
  window.addEventListener("resize", resize);
  resize();

  $("#globe-reset").addEventListener("click", () => {
    freeLook = false;
    $("#globe-reset").hidden = true;
    if (currentRoute) {
      const shot = globe.frameRoute(currentRoute.route, currentRoute.from, currentRoute.to);
      if (shot) globe.lookAt(shot.lat, shot.lon, shot.zoom);
    }
    invalidate();
  });

  // A read-only window onto the camera, for the site test.
  window.__globe = () => ({
    lat: +globe.center.lat.toFixed(3),
    lon: +globe.center.lon.toFixed(3),
    zoom: +globe.zoom.toFixed(3),
    textured: !!globe.texture,
  });

  // Repaint only when there is something new to see.
  const tick = () => {
    const moving = globe.moving;
    globe.step();
    if (moving || globeDirty) {
      globeDirty = false;
      globe.render({
        route: currentRoute?.route,
        from: currentRoute?.from,
        to: currentRoute?.to,
      });
    }
    requestAnimationFrame(tick);
  };
  tick();
}

const progress = (message) => {
  const box = $("#result");
  if (box) box.innerHTML = `<p class="result__loading">${escapeHtml(message)}</p>`;
};

/**
 * Point every sign-in link at the running app, and let the sticky bar know when
 * it has left the hero. Done before the heavy loading below, so the way in
 * works while the terrain is still downloading.
 */
/* ─────────────────────────────── the hero ─────────────────────────────── */

/**
 * The opening: a courier crossing the North Atlantic, on a loop.
 *
 * The route is real — planned by this same engine at build time and shipped as
 * a small file, because the grids take a couple of seconds to build and nothing
 * above the fold can wait for that. The coastline outline is enough to start
 * drawing; the terrain arrives when it arrives.
 *
 * Twenty-three days compressed into half a minute. The path traces out behind
 * the runner rather than being drawn all at once, so what you see is a journey
 * being made rather than a line on a map.
 */
const LOOP_SECONDS = 34;
const ARRIVAL_PAUSE = 3;

/** The part of a polyline covered so far, cut cleanly at the fraction. */
function truncate(points, f) {
  if (f <= 0) return [];
  if (f >= 1) return points;

  const spans = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    spans.push(d);
    total += d;
  }
  if (total === 0) return [points[0]];

  let target = total * f;
  const out = [points[0]];
  for (let i = 0; i < spans.length; i++) {
    if (spans[i] >= target) {
      const within = spans[i] > 0 ? target / spans[i] : 0;
      out.push(interpolate(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon, within));
      return out;
    }
    target -= spans[i];
    out.push(points[i + 1]);
  }
  return out;
}

/** The journey so far, as a route the globe can draw. */
function trailAt(showcase, elapsed) {
  const legs = [];
  let covered = 0;

  for (const leg of showcase.legs) {
    if (elapsed >= leg.endSeconds) {
      legs.push({ mode: leg.mode, points: leg.points });
      covered = leg.endF;
      continue;
    }
    if (elapsed > leg.startSeconds) {
      const within = (elapsed - leg.startSeconds) / (leg.endSeconds - leg.startSeconds);
      legs.push({ mode: leg.mode, points: truncate(leg.points, within) });
      covered = leg.startF + within * (leg.endF - leg.startF);
      return { legs, covered, mode: leg.mode, here: legs.at(-1).points.at(-1) };
    }
    break;
  }
  return { legs, covered, mode: legs.at(-1)?.mode ?? "run", here: legs.at(-1)?.points.at(-1) };
}

function startHero(showcase, outline) {
  const canvas = $("#hero-globe");
  if (!canvas) return;

  const globe = new Globe(canvas, outline);
  // A wide, slow backdrop behind text — coarse pixels are plenty, and it never
  // stops moving so it never gets to use the cached full-resolution raster.
  globe.motionQuality = 2;
  globe.maxDpr = 1.5;

  const points = showcase.legs.flatMap((leg) => leg.points.map(([lat, lon]) => ({ lat, lon })));
  const full = showcase.legs.map((leg) => ({
    mode: leg.mode,
    points: leg.points.map(([lat, lon]) => ({ lat, lon })),
  }));
  const legsForTrail = showcase.legs.map((leg, i) => ({
    ...leg,
    points: full[i].points,
  }));

  const from = { lat: showcase.from.lat, lon: showcase.from.lon };
  const to = { lat: showcase.to.lat, lon: showcase.to.lon };

  /**
   * The camera follows the courier rather than framing the whole route.
   *
   * San Francisco to Shanghai spans some two hundred and forty degrees of
   * longitude — more than a hemisphere — so there is no single view that holds
   * all of it, and framing the lot leaves half the journey round the back. So
   * the world turns underneath the runner instead, which is both the only way
   * to watch the whole crossing and a better thing to watch.
   */
  const FOLLOW_ZOOM = 1.55;

  const resize = () => {
    globe.resize();
    globe.jumpTo(from.lat, from.lon, FOLLOW_ZOOM);
  };
  window.addEventListener("resize", resize);
  resize();

  $("[data-hero-route]").textContent = `${showcase.from.name} → ${showcase.to.name}`;

  const started = performance.now();
  const totalDays = Math.ceil(showcase.totalSeconds / 86400);

  /**
   * A hero that loops forever is precisely what a reduced-motion preference is
   * asking about. Honour it by drawing the finished journey once and stopping —
   * the whole route is there, it simply is not re-run.
   */
  const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");
  const drawArrived = () => {
    // Still, so the whole route has to fit rather than being followed.
    const shot = globe.frameRoute({ legs: full }, from, to);
    if (shot) globe.jumpTo(shot.lat, shot.lon, shot.zoom * 0.9);
    globe.render({
      route: { legs: full },
      from,
      to,
      scale: 1.6,
    });
    $("[data-hero-day]").textContent = `Arrived in ${totalDays} days`;
    $("[data-hero-covered]").textContent = distance(showcase.totalMetres);
    $("[data-hero-mode]").textContent = "delivered by hand";
    $("[data-hero-progress]").style.width = "100%";
  };

  const frame = () => {
    if (stillness.matches) return drawArrived();

    const cycle = ((performance.now() - started) / 1000) % (LOOP_SECONDS + ARRIVAL_PAUSE);
    const arrived = cycle > LOOP_SECONDS;
    const elapsed = arrived
      ? showcase.totalSeconds
      : (cycle / LOOP_SECONDS) * showcase.totalSeconds;

    const trail = trailAt({ ...showcase, legs: legsForTrail }, elapsed);

    // Keep the courier in view, trailing gently so the globe glides rather than
    // snapping from waypoint to waypoint.
    const looking = arrived ? to : trail.here ?? from;
    globe.lookAt(looking.lat, looking.lon, FOLLOW_ZOOM);
    globe.step(0.05);

    globe.render({
      ghost: { legs: full },
      route: { legs: trail.legs },
      from,
      to: arrived ? to : null,
      courier: arrived ? null : trail.here && { ...trail.here, mode: trail.mode },
      // Drawn heavier than in the app: this is seen at a glance, from across a
      // room, behind text.
      scale: 1.6,
    });

    const day = Math.min(totalDays, Math.floor(elapsed / 86400) + 1);
    $("[data-hero-day]").textContent = arrived ? "Arrived" : `Day ${day} of ${totalDays}`;
    $("[data-hero-covered]").textContent = distance(showcase.totalMetres * trail.covered);
    $("[data-hero-mode]").textContent = arrived
      ? "delivered by hand"
      : trail.mode === "swim" ? "swimming" : "running";
    $("[data-hero-progress]").style.width = `${(trail.covered * 100).toFixed(2)}%`;

    requestAnimationFrame(frame);
  };

  // Redraw once if the preference changes while the page is open.
  stillness.addEventListener?.("change", () => frame());
  frame();

  return globe;
}

/* ────────────────────────────── the journal ───────────────────────────── */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Spelled out, because "Twenty-five days" is a sentence and "25 days" is a value. */
function spell(n) {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const rest = n % 10;
    return TENS[Math.floor(n / 10)] + (rest ? `-${ONES[rest]}` : "");
  }
  return String(n);
}

const capitalise = (word) => word[0].toUpperCase() + word.slice(1);

/**
 * The same crossing, written out. Every line is real: the legs the router
 * chose, timed against the records that govern them.
 */
function renderJournal(showcase) {
  const list = $("#journal-legs");
  if (!list) return;

  // Written from the route rather than typed into the page, so changing the
  // journey cannot leave the words describing the old one.
  const days = Math.round(showcase.totalSeconds / 86400);
  $("[data-journal-title]").textContent = `${capitalise(spell(days))} days, written down`;
  $("[data-journal-blurb]").textContent =
    `The crossing above, leg by leg — ${showcase.from.name} to ${showcase.to.name}.`;

  const dayOf = (seconds) => Math.floor(seconds / 86400) + 1;

  list.innerHTML = showcase.legs
    .map((leg) => {
      const from = dayOf(leg.startSeconds);
      const to = dayOf(leg.endSeconds);
      const days = from === to ? `Day ${from}` : `Days ${from}–${to}`;
      const climb = leg.ascent > 500
        ? `<span class="journal__climb">climbing ${leg.ascent.toLocaleString()} m</span>`
        : "";

      return `
        <li class="journal__leg is-${leg.mode}">
          <span class="journal__day">${days}</span>
          <span class="journal__mark" aria-hidden="true"></span>
          <div class="journal__body">
            <p class="journal__what">
              <b>${leg.mode === "swim" ? "Swims" : "Runs"} ${distance(leg.metres)}</b>
              <span class="journal__how-long">${duration(leg.seconds)}</span>
            </p>
            <p class="journal__pace">
              at ${escapeHtml(leg.record.label)} pace — ${escapeHtml(leg.record.athlete)}
              ${climb}
            </p>
          </div>
        </li>`;
    })
    .join("");

  const saved = showcase.straightSeconds - showcase.totalSeconds;
  $("#journal-close").innerHTML = `
    ${distance(showcase.totalMetres)} on foot, ${climb(showcase.ascent)} of climbing, and
    ${distance(showcase.swimMetres)} in open water — arriving
    <b>${duration(saved)} sooner</b> than swimming straight across would have.`;
}

function wireChrome() {
  const app = document.body.dataset.app;
  for (const link of document.querySelectorAll("[data-app-link]")) link.href = app;

  const bar = $("#topbar");
  const hero = $(".hero");
  if (!bar || !hero) return;

  const watcher = new IntersectionObserver(
    ([entry]) => bar.classList.toggle("is-lifted", !entry.isIntersecting),
    { rootMargin: "-60px 0px 0px 0px" }
  );
  watcher.observe(hero);
}

async function boot() {
  wireChrome();
  progress("Loading coastlines and terrain…");

  // The outline and the showcase journey are small and come first, so the hero
  // is moving long before the routing data has finished arriving.
  const [outline, showcase] = await Promise.all([
    fetch("./data/world.json").then((r) => r.json()),
    fetch("./data/showcase.json").then((r) => r.json()),
  ]);

  const heroGlobe = startHero(showcase, outline);
  renderJournal(showcase);

  const [maskBuffer, elevationGz, gazetteer] = await Promise.all([
    fetch("./data/landmask.bin").then((r) => r.arrayBuffer()),
    fetch("./data/elevation.bin.gz").then((r) => r.arrayBuffer()),
    fetch("./data/cities.json").then((r) => r.json()),
  ]);

  const mask = new LandMask(maskBuffer);
  const elevation = await Elevation.fromGzip(elevationGz);

  cities = gazetteer.cities;
  countries = gazetteer.countries;
  folded = cities.map((c) => fold(c[0]));

  // Coastline outlines first: the globe has something to draw immediately while
  // the heavier work below runs.
  startGlobe(outline);

  const yieldToPaint = () => new Promise((r) => setTimeout(r, 30));

  progress("Shading the terrain…");
  await yieldToPaint();
  // The app downloads a baked PNG of this; here the elevation grid is already
  // in memory for routing, so the texture is built rather than fetched.
  const texture = buildTerrainTexture(mask, elevation);
  globe.setTexture(texture);
  heroGlobe?.setTexture(texture);
  invalidate();

  progress("Building the routing grid…");
  await yieldToPaint();
  world = {
    mask,
    elevation,
    grid: RoutingGrid.downsample(mask, elevation, 0.2),
    coarse: RoutingGrid.downsample(mask, elevation, 1.0, { optimistic: true }),
  };

  renderRecords();

  const pickers = {
    from: initPicker($('[data-role="from"]'), "from"),
    to: initPicker($('[data-role="to"]'), "to"),
  };
  renderPresets(pickers);

  $("#swap").addEventListener("click", () => setEnds(pickers, ends.to, ends.from));

  // Open on the same journey the page above tells, so the calculator confirms
  // what you just watched rather than introducing a new one.
  setEnds(pickers, findCity("San Francisco"), findCity("Shanghai"));
}

boot().catch((err) => {
  console.error(err);
  $("#result").innerHTML =
    `<p class="result__loading">Could not load the map data — ${escapeHtml(err.message)}</p>`;
});

/**
 * demo.js — the route calculator on the project site.
 *
 * This imports the app's own modules from ./lib/, copied verbatim at build
 * time by scripts/build-site.js. There is no reimplementation here: the ladder,
 * the log-log interpolation, the coastline splitting and the globe are the same
 * code the server runs. The only thing this file adds is the page around them.
 */

import { LandMask, buildRoute } from "./lib/geo.js";
import { RUN_LADDER, SWIM_LADDER } from "./lib/records.js";
import { Elevation } from "./lib/terrain.js";
import { RoutingGrid } from "./lib/router.js";
import { Globe } from "./lib/globe.js";

const $ = (sel, root = document) => root.querySelector(sel);

const PRESETS = [
  ["New York City", "London"],
  ["Sydney", "Santiago"],
  ["Cairo", "Cape Town"],
  ["Tokyo", "San Francisco"],
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

const spin = { lat: 25, lon: -20, targetLat: 25, targetLon: -20 };

function aim(lat, lon) {
  spin.targetLat = lat;
  let delta = lon - spin.lon;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  spin.targetLon = spin.lon + delta;
}

function midpoint(a, b) {
  const r = Math.PI / 180;
  const x = (Math.cos(a.lat * r) * Math.cos(a.lon * r) + Math.cos(b.lat * r) * Math.cos(b.lon * r)) / 2;
  const y = (Math.cos(a.lat * r) * Math.sin(a.lon * r) + Math.cos(b.lat * r) * Math.sin(b.lon * r)) / 2;
  const z = (Math.sin(a.lat * r) + Math.sin(b.lat * r)) / 2;
  return { lat: Math.atan2(z, Math.hypot(x, y)) / r, lon: Math.atan2(y, x) / r };
}

let currentRoute = null;

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

  const mid = midpoint(from, to);
  aim(mid.lat, mid.lon);

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

function startGlobe() {
  const canvas = $("#globe");
  globe = new Globe(canvas, globe?.world ?? window.__world);
  const resize = () => globe.resize();
  window.addEventListener("resize", resize);
  resize();

  const tick = () => {
    spin.lat += (spin.targetLat - spin.lat) * 0.07;
    spin.lon += (spin.targetLon - spin.lon) * 0.07;
    globe.setCenter(spin.lat, spin.lon);
    globe.render({
      route: currentRoute?.route,
      from: currentRoute?.from,
      to: currentRoute?.to,
    });
    requestAnimationFrame(tick);
  };
  tick();
}

const progress = (message) => {
  const box = $("#result");
  if (box) box.innerHTML = `<p class="result__loading">${escapeHtml(message)}</p>`;
};

async function boot() {
  progress("Loading coastlines and terrain…");

  const [maskBuffer, elevationGz, outline, gazetteer] = await Promise.all([
    fetch("./data/landmask.bin").then((r) => r.arrayBuffer()),
    fetch("./data/elevation.bin.gz").then((r) => r.arrayBuffer()),
    fetch("./data/world.json").then((r) => r.json()),
    fetch("./data/cities.json").then((r) => r.json()),
  ]);

  const mask = new LandMask(maskBuffer);
  const elevation = await Elevation.fromGzip(elevationGz);

  cities = gazetteer.cities;
  countries = gazetteer.countries;
  folded = cities.map((c) => fold(c[0]));
  window.__world = outline;

  startGlobe();
  progress("Building the routing grid…");

  // Yield first, so the globe paints before this blocks the thread for a moment.
  await new Promise((r) => setTimeout(r, 30));
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

  // Open on the journey the README quotes, so there is something to read at once.
  setEnds(pickers, findCity("New York City"), findCity("London"));
}

boot().catch((err) => {
  console.error(err);
  $("#result").innerHTML =
    `<p class="result__loading">Could not load the map data — ${escapeHtml(err.message)}</p>`;
});

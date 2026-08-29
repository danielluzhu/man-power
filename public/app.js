/**
 * app.js — Man Power client.
 *
 * Three things have to stay true here:
 *   1. Countdowns tick from the server's arrival timestamp, never from a
 *      locally accumulated counter, so a backgrounded tab cannot drift.
 *   2. The courier's position is recomputed from the shared sphere math rather
 *      than animated between poll responses, so the dot on the globe always
 *      agrees with the clock beside it.
 *   3. A sealed message has no body to leak — the server sends null, and the
 *      UI is built to show an envelope rather than to hide text it was given.
 */

import { Globe, loadWorld } from "/globe.js";
import { positionAt } from "/sphere.js";

/* ─────────────────────────────── plumbing ─────────────────────────────── */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : {},
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 4200);
}

/* ─────────────────────────────── formatting ───────────────────────────── */

const DAY = 86400, HOUR = 3600, MIN = 60;

/** "31d 03h 42m 18s" — full precision, for live countdowns. */
function countdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  const m = Math.floor((s % HOUR) / MIN);
  const sec = s % MIN;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** "31 days, 3 hours" — rounded prose, for quotes and summaries. */
function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < MIN) return `${s} seconds`;
  const units = [
    ["day", DAY], ["hour", HOUR], ["minute", MIN],
  ];
  const parts = [];
  let rest = s;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    rest %= size;
    if (n > 0) parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
    if (parts.length === 2) break;
  }
  return parts.join(", ") || "moments";
}

/** "3 days ago", "just now" — for messages that have already landed. */
function relative(timestamp) {
  const s = Math.round((Date.now() - timestamp) / 1000);
  if (s < 60) return "just now";
  for (const [name, size] of [["day", DAY], ["hour", HOUR], ["minute", MIN]]) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

function distance(metres) {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return `${km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(1)} km`;
}

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ──────────────────────────── city autocomplete ───────────────────────── */

/**
 * Wires one [data-citypick] block. Selection is kept on the element itself so
 * several pickers can coexist without a shared registry.
 */
function initCityPicker(root, onPick) {
  const input = $(".citypick__input", root);
  const list = $(".citypick__results", root);
  const chosen = $("[data-chosen]", root.parentElement);
  let results = [];
  let active = -1;
  let timer;

  const close = () => { list.hidden = true; active = -1; };

  const render = () => {
    if (!results.length) return close();
    list.innerHTML = results
      .map((c, i) => `
        <li data-i="${i}" class="${i === active ? "is-active" : ""}">
          <span>${escapeHtml(c.name)}</span>
          <span class="citypick__meta">${escapeHtml(c.country)}</span>
        </li>`)
      .join("");
    list.hidden = false;
  };

  const choose = (city) => {
    if (!city) return;
    input.value = "";
    close();
    if (chosen) {
      chosen.textContent = `Standing in ${city.name}, ${city.country}`;
      chosen.hidden = false;
    }
    onPick(city);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      try {
        const { results: found } = await api(`/api/cities?q=${encodeURIComponent(q)}`);
        results = found;
        active = found.length ? 0 : -1;
        render();
      } catch { close(); }
    }, 160);
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") close();
  });

  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) { e.preventDefault(); choose(results[Number(li.dataset.i)]); }
  });

  input.addEventListener("blur", () => setTimeout(close, 120));
}

/* ───────────────────────────────── state ──────────────────────────────── */

const state = {
  me: null,
  couriers: [],
  inbox: [],
  outbox: [],
  selected: null,   // full message with route
  quote: null,      // dispatch preview
  registerCity: null,
  moveCity: null,
};

let globe, authGlobe, world;

/* ───────────────────────────────── globe ──────────────────────────────── */

/** Ease the globe's centre toward a target instead of snapping to it. */
const spin = { lat: 20, lon: 0, targetLat: 20, targetLon: 0 };

function aimGlobe(lat, lon) {
  spin.targetLat = lat;
  // Take the short way round rather than unwinding the long way.
  let delta = lon - spin.lon;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  spin.targetLon = spin.lon + delta;
}

function midpoint(a, b) {
  const toRad = Math.PI / 180;
  const x = (Math.cos(a.lat * toRad) * Math.cos(a.lon * toRad) + Math.cos(b.lat * toRad) * Math.cos(b.lon * toRad)) / 2;
  const y = (Math.cos(a.lat * toRad) * Math.sin(a.lon * toRad) + Math.cos(b.lat * toRad) * Math.sin(b.lon * toRad)) / 2;
  const z = (Math.sin(a.lat * toRad) + Math.sin(b.lat * toRad)) / 2;
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) / toRad,
    lon: Math.atan2(y, x) / toRad,
  };
}

/** Live courier position for a message, from its route and the wall clock. */
function courierNow(msg) {
  if (!msg?.route || msg.arrived) return null;
  const elapsed = (Date.now() - msg.sentAt) / 1000;
  return positionAt(msg.route, elapsed, msg.from, msg.to);
}

function paintGlobe() {
  if (!globe) return;
  spin.lat += (spin.targetLat - spin.lat) * 0.08;
  spin.lon += (spin.targetLon - spin.lon) * 0.08;
  globe.setCenter(spin.lat, spin.lon);

  const msg = state.selected || state.quote;
  globe.render({
    route: msg?.route,
    from: msg?.from,
    to: msg?.to,
    courier: state.selected ? courierNow(state.selected) : null,
  });
}

function startGlobeLoop() {
  const tick = () => { paintGlobe(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

/* ─────────────────────────────── rendering ────────────────────────────── */

function renderMe() {
  $("[data-me-handle]").textContent = state.me.handle;
  $("[data-me-city]").textContent = state.me.city;
}

function renderRecipients() {
  const select = $("#recipient");
  const previous = select.value;
  if (!state.couriers.length) {
    select.innerHTML = `<option value="">Nobody else has enlisted yet</option>`;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML =
    `<option value="">Choose a courier…</option>` +
    state.couriers
      .map((c) => `<option value="${escapeHtml(c.handle)}">${escapeHtml(c.handle)} — ${escapeHtml(c.city)}</option>`)
      .join("");
  if (previous) select.value = previous;
}

function renderQuote() {
  const box = $("#quote");
  const q = state.quote;
  if (!q) {
    box.className = "quote quote--empty";
    box.innerHTML = `<p class="quote__hint">Choose a recipient to see the journey.</p>`;
    return;
  }
  const r = q.route;
  box.className = "quote";
  box.innerHTML = `
    <span class="quote__eta-label">${escapeHtml(q.from.city)} → ${escapeHtml(q.to.city)}</span>
    <div class="quote__eta">${duration(r.totalSeconds)}</div>
    <div class="quote__split">
      <span><b class="is-run">run</b> ${distance(r.runMetres)}</span>
      <span><b class="is-swim">swim</b> ${distance(r.swimMetres)}</span>
      <span>${r.legs.length} leg${r.legs.length === 1 ? "" : "s"}</span>
    </div>`;
}

function messageCard(msg) {
  const inFlight = !msg.arrived;
  const unread = msg.arrived && msg.direction === "received" && !msg.readAt;
  const classes = ["card", inFlight ? "card--flight" : "", unread ? "card--unread" : "",
                   state.selected?.id === msg.id ? "is-selected" : ""].filter(Boolean).join(" ");

  const preposition = msg.direction === "sent" ? "to" : "from";
  const bodyBlock = msg.body
    ? `<p class="card__preview">${escapeHtml(msg.body)}</p>`
    : `<p class="card__sealed">Sealed — ${msg.charCount} characters, still on the road.</p>`;

  const clock = inFlight
    ? `<div class="card__count" data-until="${msg.arrivesAt}">${countdown((msg.arrivesAt - Date.now()) / 1000)}</div>
       <div class="progress"><div class="progress__bar" data-progress-for="${msg.id}"></div></div>`
    : `<div class="card__landed">
         ${msg.direction === "sent" ? "Delivered" : "Arrived"} ${relative(msg.arrivesAt)}
         · ${duration(msg.totalSeconds)} on the road
       </div>`;

  return `
    <button class="${classes}" data-message="${msg.id}">
      <div class="card__top">
        <span class="card__who">${preposition} ${escapeHtml(msg.correspondent)}</span>
        <span class="card__when">${distance(msg.totalMetres)}</span>
      </div>
      <div class="card__route">${escapeHtml(msg.from.city)} → ${escapeHtml(msg.to.city)}</div>
      ${clock}
      ${bodyBlock}
    </button>`;
}

function renderLists() {
  const all = [...state.inbox, ...state.outbox];
  const flight = all.filter((m) => !m.arrived)
    .sort((a, b) => a.arrivesAt - b.arrivesAt);
  const arrived = all.filter((m) => m.arrived)
    .sort((a, b) => b.arrivesAt - a.arrivesAt);

  $("#flight-list").innerHTML = flight.length
    ? flight.map(messageCard).join("")
    : `<p class="empty">Nobody is out running for you.<br>Dispatch a courier to start the clock.</p>`;

  $("#arrived-list").innerHTML = arrived.length
    ? arrived.map(messageCard).join("")
    : `<p class="empty">Nothing has landed yet.<br>These things take a while on foot.</p>`;

  $('[data-count="flight"]').textContent = flight.length;

  const unread = state.inbox.filter((m) => m.arrived && !m.readAt).length;
  const badge = $('[data-count="unread"]');
  badge.textContent = unread;
  badge.hidden = unread === 0;
}

function renderHud() {
  const hud = $("#hud");
  const msg = state.selected;
  if (!msg) { hud.hidden = true; return; }
  hud.hidden = false;

  $("[data-hud-route]").textContent =
    `${msg.from.city} → ${msg.to.city} · ${msg.direction === "sent" ? "to" : "from"} ${msg.correspondent}`;
  $("[data-hud-distance]").textContent = distance(msg.totalMetres);
  $("[data-hud-run]").textContent = distance(msg.runMetres);
  $("[data-hud-swim]").textContent = distance(msg.swimMetres);

  const body = $("[data-hud-body]");
  if (msg.body) {
    body.hidden = false;
    body.textContent = msg.body;
  } else {
    body.hidden = false;
    body.innerHTML = `<em style="color:var(--ink-faint)">The courier still has this in hand. It opens on arrival.</em>`;
  }

  const legs = msg.route?.legs || [];
  $("[data-hud-legcount]").textContent = `(${legs.length})`;
  $("[data-hud-legs]").innerHTML = legs
    .map((leg) => `
      <li>
        <span class="${leg.mode === "swim" ? "is-swim" : "is-run"}">${leg.mode}</span>
        ${distance(leg.metres)} · ${duration(leg.seconds)}
        <span class="legs__rec">at ${escapeHtml(leg.record.label)} pace — ${escapeHtml(leg.record.athlete)}</span>
      </li>`)
    .join("");

  tickHud();
}

/** Second-by-second HUD refresh: clock, progress bar, distance covered. */
function tickHud() {
  const msg = state.selected;
  if (!msg || $("#hud").hidden) return;

  const label = $("[data-hud-label]");
  const value = $("[data-hud-countdown]");
  const bar = $("[data-hud-progress]");
  const covered = $("[data-hud-covered]");

  if (msg.arrived || Date.now() >= msg.arrivesAt) {
    label.textContent = "Delivered";
    value.textContent = new Date(msg.arrivesAt).toLocaleString();
    value.style.fontSize = "15px";
    bar.style.width = "100%";
    covered.textContent = distance(msg.totalMetres);
    return;
  }

  value.style.fontSize = "";
  label.textContent = "Arrives in";
  value.textContent = countdown((msg.arrivesAt - Date.now()) / 1000);

  const pos = courierNow(msg);
  const fraction = pos ? pos.fraction : 0;
  bar.style.width = `${(fraction * 100).toFixed(3)}%`;
  covered.textContent = pos
    ? `${distance(pos.metresCovered)} · ${pos.mode === "swim" ? "swimming" : "running"}`
    : distance(msg.totalMetres);
}

/** Every card's countdown and progress bar, once a second. */
function tickCards() {
  const now = Date.now();
  let landed = false;

  for (const el of $$("[data-until]")) {
    const remaining = (Number(el.dataset.until) - now) / 1000;
    if (remaining <= 0) landed = true;
    el.textContent = countdown(remaining);
  }

  for (const el of $$("[data-progress-for]")) {
    const msg = [...state.inbox, ...state.outbox].find((m) => m.id === Number(el.dataset.progressFor));
    if (!msg) continue;
    const elapsed = now - msg.sentAt;
    const total = msg.arrivesAt - msg.sentAt;
    el.style.width = `${Math.min(100, (elapsed / total) * 100).toFixed(3)}%`;
  }

  if (landed) refresh();
}

function renderRecords(data) {
  const table = (title, note, rows) => `
    <div class="ladder">
      <h3>${title}</h3>
      <p class="view__sub" style="margin-bottom:.6rem">${note}</p>
      <table>
        <colgroup>
          <col class="c-dist"><col class="c-time"><col class="c-who"><col class="c-pace">
        </colgroup>
        <thead>
          <tr>
            <th>Distance</th>
            <th class="num">Time</th>
            <th>Held by</th>
            <th class="num">m/s</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.label)}</td>
              <td class="num">${escapeHtml(r.time)}</td>
              <td class="who">
                ${escapeHtml(r.athlete)}
                <span class="nation">${escapeHtml(r.nation)} ’${String(r.year).slice(2)}</span>
              </td>
              <td class="num">${r.speed.toFixed(2)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  $("#records-tables").innerHTML =
    table("On land — running", "Anything shorter than a mile runs at Kerr's mile pace; anything past 26.2 miles holds Sawe's marathon pace, however far it goes.", data.running) +
    table("On water — swimming", "Long-course freestyle. Beyond 1500 m — the longest distance with a standing record — pace holds, whatever the width of the ocean.", data.swimming);
}

/* ──────────────────────────────── actions ─────────────────────────────── */

async function refresh() {
  const [me, inbox, outbox] = await Promise.all([
    api("/api/me"), api("/api/inbox"), api("/api/outbox"),
  ]);
  state.me = me.user;
  state.couriers = me.couriers;
  state.inbox = inbox.messages;
  state.outbox = outbox.messages;

  renderMe();
  renderRecipients();
  renderLists();

  // Keep an open message in sync — most importantly, let a body appear the
  // moment its courier lands.
  if (state.selected) {
    const fresh = [...state.inbox, ...state.outbox].find((m) => m.id === state.selected.id);
    if (fresh && fresh.arrived !== state.selected.arrived) await selectMessage(state.selected.id);
  }
}

async function selectMessage(id) {
  const { message } = await api(`/api/messages/${id}`);
  state.selected = message;
  state.quote = null;
  const mid = midpoint(message.from, message.to);
  aimGlobe(mid.lat, mid.lon);
  renderQuote();
  renderLists();
  renderHud();
  // Reading clears the unread badge without waiting for the next poll.
  const local = state.inbox.find((m) => m.id === id);
  if (local && message.arrived && !local.readAt) {
    local.readAt = Date.now();
    renderLists();
  }
}

async function updateQuote() {
  const handle = $("#recipient").value;
  if (!handle) {
    state.quote = null;
    renderQuote();
    $("#send").disabled = true;
    return;
  }
  try {
    const preview = await post("/api/preview", { toHandle: handle });
    state.quote = preview;
    state.selected = null;
    $("#hud").hidden = true;
    const mid = midpoint(preview.from, preview.to);
    aimGlobe(mid.lat, mid.lon);
    renderQuote();
    renderLists();
    $("#send").disabled = !$("#body").value.trim();
  } catch (err) {
    $('[data-error="dispatch"]').textContent = err.message;
  }
}

function showView(name) {
  $$(".nav__item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === name));
  if (name === "records" && !$("#records-tables").children.length) {
    api("/api/records").then(renderRecords).catch(() => {});
  }
}

/* ──────────────────────────────── wiring ──────────────────────────────── */

function wireAuth() {
  $$("[data-auth-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const which = tab.dataset.authTab;
      $$("[data-auth-tab]").forEach((t) => t.classList.toggle("is-active", t === tab));
      $("#login-form").hidden = which !== "login";
      $("#register-form").hidden = which !== "register";
    });
  });

  initCityPicker($('[data-citypick="register"]'), (city) => { state.registerCity = city; });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const err = $("[data-error]", e.target);
    err.textContent = "";
    try {
      await post("/api/login", { handle: form.get("handle"), password: form.get("password") });
      await enterApp();
    } catch (ex) { err.textContent = ex.message; }
  });

  $("#register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const err = $("[data-error]", e.target);
    err.textContent = "";
    if (!state.registerCity) { err.textContent = "Pick the city you are standing in."; return; }
    try {
      await post("/api/register", {
        handle: form.get("handle"),
        password: form.get("password"),
        city: state.registerCity,
      });
      await enterApp();
    } catch (ex) { err.textContent = ex.message; }
  });
}

function wireApp() {
  $$(".nav__item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

  $("#recipient").addEventListener("change", updateQuote);

  $("#body").addEventListener("input", (e) => {
    $("[data-charcount]").textContent = e.target.value.length;
    $("#send").disabled = !e.target.value.trim() || !$("#recipient").value;
  });

  $("#send").addEventListener("click", async () => {
    const button = $("#send");
    const err = $('[data-error="dispatch"]');
    err.textContent = "";
    button.disabled = true;
    try {
      const { message } = await post("/api/messages", {
        toHandle: $("#recipient").value,
        body: $("#body").value,
      });
      $("#body").value = "";
      $("[data-charcount]").textContent = "0";
      await refresh();
      await selectMessage(message.id);
      showView("flight");
      toast(`Courier away. ${message.to.city} in ${duration(message.totalSeconds)}.`);
    } catch (ex) {
      err.textContent = ex.message;
      button.disabled = false;
    }
  });

  $(".rail").addEventListener("click", (e) => {
    const card = e.target.closest("[data-message]");
    if (card) selectMessage(Number(card.dataset.message)).catch((ex) => toast(ex.message));
  });

  $("[data-hud-close]").addEventListener("click", () => {
    state.selected = null;
    $("#hud").hidden = true;
    renderLists();
    if (state.me) aimGlobe(state.me.lat, state.me.lon);
  });

  $("#logout").addEventListener("click", async () => {
    await post("/api/logout", {});
    location.reload();
  });

  // Relocating changes every future journey, so re-quote afterwards.
  const dialog = $("#move-dialog");
  initCityPicker($('[data-citypick="move"]'), (city) => {
    state.moveCity = city;
    $("#move-confirm").disabled = false;
  });
  $("#whoami").addEventListener("click", () => {
    state.moveCity = null;
    $("#move-confirm").disabled = true;
    dialog.showModal();
  });
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "ok" || !state.moveCity) return;
    await post("/api/me/location", { city: state.moveCity });
    await refresh();
    aimGlobe(state.me.lat, state.me.lon);
    toast(`You are now standing in ${state.me.city}.`);
    if ($("#recipient").value) updateQuote();
  });
}

/* ──────────────────────────────── startup ─────────────────────────────── */

async function enterApp() {
  $("#auth").hidden = true;
  $("#app").hidden = false;

  globe = new Globe($("#globe"), world);
  const resize = () => { globe.resize(); paintGlobe(); };
  window.addEventListener("resize", resize);
  resize();

  await refresh();
  aimGlobe(state.me.lat, state.me.lon);
  spin.lat = state.me.lat;
  spin.lon = state.me.lon;

  startGlobeLoop();
  setInterval(() => { tickCards(); tickHud(); }, 1000);
  setInterval(() => refresh().catch(() => {}), 20000);
}

function startAuthGlobe() {
  const canvas = $("#auth-globe");
  authGlobe = new Globe(canvas, world);
  authGlobe.zoom = 1.35;
  const resize = () => authGlobe.resize();
  window.addEventListener("resize", resize);
  resize();

  let lon = 0;
  const tick = () => {
    if ($("#auth").hidden) return;
    lon = (lon + 0.045) % 360;
    authGlobe.setCenter(14, lon);
    authGlobe.render({});
    requestAnimationFrame(tick);
  };
  tick();
}

async function boot() {
  world = await loadWorld();
  wireAuth();
  wireApp();

  try {
    await api("/api/me");
    await enterApp();
  } catch {
    $("#auth").hidden = false;
    startAuthGlobe();
  }
}

boot();

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

import { Globe, loadWorld, loadTerrain } from "/globe.js";
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

/** Vertical metres climbed. */
function climb(metres) {
  if (!metres) return "flat";
  return metres >= 10000 ? `${Math.round(metres / 1000)},000 m` : `${metres.toLocaleString()} m`;
}

/** Enough climbing to be worth comparing to something. */
function everests(metres) {
  const n = metres / 8849;
  return n >= 1.5 ? `${n.toFixed(1)}× Everest` : "";
}

/** Delivery speed as the crow flies, in km/h. */
const kmh = (metresPerSecond) => `${(metresPerSecond * 3.6).toFixed(1)} km/h`;

/**
 * How the planned route compares with simply running the straight line.
 *
 * Both are timed by the same engine over the same terrain, so the difference is
 * down to the choice of path alone. Where there is nothing worth going around
 * the two are the same route, and saying so is more honest than reporting a
 * 1.00x gain.
 */
function comparison(route) {
  if (!route.straight || route.speedup < 1.005) {
    return `<div class="versus versus--none">
      Straight there — nothing worth going around.
    </div>`;
  }
  return `<div class="versus">
    <div class="versus__headline">${route.speedup.toFixed(2)}× faster than going straight</div>
    <div class="versus__detail">
      arrives ${duration(route.secondsSaved)} sooner ·
      ${kmh(route.effectiveSpeed)} vs ${kmh(route.straightSpeed)} as the crow flies
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

/* ─────────────────────────────── arrivals ─────────────────────────────── */

/**
 * Ask to be told when a courier lands.
 *
 * This is the one feature the product genuinely needs: a journey takes weeks,
 * so by the time it ends the tab is long closed. Web Push covers that without
 * an email provider or a domain — the caveat being that iOS only delivers to a
 * site that has been added to the home screen.
 */

const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** VAPID keys arrive base64url-encoded; the subscribe call wants bytes. */
function decodeKey(base64url) {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

async function enableArrivalAlerts() {
  if (!pushSupported()) throw new Error("This browser cannot deliver arrival alerts.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site — you will have to allow them in your browser settings."
        : "Notifications were not allowed."
    );
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const { publicKey } = await api("/api/push/key");
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    }));

  await post("/api/push/subscribe", subscription.toJSON());
  return subscription;
}

async function disableArrivalAlerts() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await post("/api/push/unsubscribe", { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/** Reflect the current state in the button. */
async function renderAlerts() {
  const button = $("#alerts");
  const note = $("#alerts-note");
  if (!button) return;

  if (!pushSupported()) {
    button.hidden = true;
    note.textContent = "This browser cannot deliver arrival alerts.";
    note.hidden = false;
    return;
  }

  const subscription = await currentSubscription().catch(() => null);
  const on = !!subscription && Notification.permission === "granted";

  button.hidden = false;
  button.textContent = on ? "Arrival alerts on" : "Tell me when a courier arrives";
  button.classList.toggle("is-on", on);

  note.hidden = !on;
  note.textContent = on
    ? "You will be told when something lands, even with this closed."
    : "";
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
  freeLook: false,   // the viewer has taken the globe over; stop re-aiming it
};

let globe, authGlobe, world;

/* ───────────────────────────────── globe ──────────────────────────────── */

/**
 * Point the globe at a route and zoom so the whole thing fits. The globe works
 * out the framing; this only decides when to re-aim it.
 *
 * Skipped once the viewer has taken hold of the globe themselves — being yanked
 * somewhere else mid-drag is worse than a stale view.
 */
function frame(msg) {
  if (!globe || state.freeLook) return;
  const shot = globe.frameRoute(msg?.route, msg?.from, msg?.to);
  if (shot) globe.lookAt(shot.lat, shot.lon, shot.zoom);
}

function aimGlobe(lat, lon, zoom) {
  if (!globe || state.freeLook) return;
  globe.lookAt(lat, lon, zoom);
}

/** Live courier position for a message, from its route and the wall clock. */
function courierNow(msg) {
  if (!msg?.route || msg.arrived) return null;
  return positionAt(msg.route, (Date.now() - msg.sentAt) / 1000);
}

function paintGlobe() {
  if (!globe) return;

  const msg = state.selected || state.quote;
  globe.render({
    route: msg?.route,
    from: msg?.from,
    to: msg?.to,
    courier: state.selected ? courierNow(state.selected) : null,
  });
}

/**
 * Ask for a repaint. Cheap to call — the loop coalesces requests into the next
 * frame.
 */
function invalidateGlobe() { globeDirty = true; }

let globeDirty = true;

/**
 * The globe repaints when there is a reason to: while the camera is moving,
 * while the viewer is dragging, or when something asks it to.
 *
 * It used to repaint every frame regardless, which meant continuously
 * compositing a full-size canvas to animate a courier that advances a few
 * microns a second on a three-week journey.
 */
function startGlobeLoop() {
  const tick = () => {
    if (globe) {
      const moving = globe.moving;
      globe.step();
      if (moving || globeDirty) {
        globeDirty = false;
        paintGlobe();
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ─────────────────────────────── rendering ────────────────────────────── */

function renderMe() {
  $("[data-me-handle]").textContent = state.me.handle;
  $("[data-me-city]").textContent = state.me.city;
  // The masked number, so it is clear which account this is without exposing it.
  $("#whoami").title = `${state.me.phone} · click to change where you stand`;
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
  const detour = r.detour > 1.02
    ? `${distance(r.totalMetres)} — ${((r.detour - 1) * 100).toFixed(0)}% further than the direct line`
    : `${distance(r.totalMetres)}, near enough the direct line`;

  box.className = "quote";
  box.innerHTML = `
    <span class="quote__eta-label">${escapeHtml(q.from.city)} → ${escapeHtml(q.to.city)}</span>
    <div class="quote__eta">${duration(r.totalSeconds)}</div>
    <div class="quote__detour">${detour}</div>
    <div class="quote__split">
      <span><b class="is-run">run</b> ${distance(r.runMetres)}</span>
      <span><b class="is-swim">swim</b> ${distance(r.swimMetres)}</span>
      <span><b class="is-climb">climb</b> ${climb(r.ascent)}${everests(r.ascent) ? ` · ${everests(r.ascent)}` : ""}</span>
    </div>
    ${comparison(r)}`;
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
  $("[data-hud-climb]").innerHTML =
    `${climb(msg.ascent)}${everests(msg.ascent) ? `<span class="stat__note">${everests(msg.ascent)}</span>` : ""}`;
  $("[data-hud-peak]").textContent = msg.peak ? `${msg.peak.toLocaleString()} m` : "sea level";

  $("[data-hud-versus]").innerHTML = comparison(msg);

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
        ${leg.ascent > 200 ? `<span class="legs__rec is-climb">climbing ${climb(leg.ascent)}, peak ${leg.peak.toLocaleString()} m</span>` : ""}
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
  state.freeLook = false;
  frame(message);
  invalidateGlobe();
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
    state.freeLook = false;
    frame(preview);
    invalidateGlobe();
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

/* ─────────────────────────────── signing in ───────────────────────────── */

/**
 * A number, then a code, then — only for a number nobody has used before — a
 * handle and a home.
 *
 * Signing in and enlisting are the same three steps, which is both kinder and
 * means the page never reveals whether a number is already registered.
 */
const STEPS = ["phone", "code", "profile"];

const auth = {
  phone: null,
  masked: null,
  expiresAt: null,
  resendAt: 0,
  step: "phone",
};

/* ── step machinery ───────────────────────────────────────────────────── */

function showAuthStep(step) {
  auth.step = step;

  for (const form of $$(".step")) {
    const showing = form.dataset.step === step;
    form.hidden = !showing;
    if (showing) {
      // Restart the entrance animation each time rather than only on first paint.
      form.classList.remove("is-entering");
      void form.offsetWidth;
      form.classList.add("is-entering");
    }
  }

  const reached = STEPS.indexOf(step);
  $("#waypoints").dataset.reached = step;
  $$(".waypoints__leg").forEach((leg, i) => {
    leg.classList.toggle("is-done", i < reached);
    leg.classList.toggle("is-here", i === reached);
  });

  const focus = {
    phone: "#phone",
    code: "#code input",
    profile: '#profile-form input[name="handle"]',
  }[step];
  // Wait for the entrance animation to start before stealing focus, or mobile
  // browsers scroll the card around mid-transition.
  setTimeout(() => $(focus)?.focus(), 120);
}

/** Buttons that are doing something say so, and cannot be pressed twice. */
async function whileBusy(button, work) {
  button.classList.add("is-busy");
  button.disabled = true;
  try {
    return await work();
  } finally {
    button.classList.remove("is-busy");
    button.disabled = false;
  }
}

const errorFor = (step) => $(`#${step}-form [data-error]`);

/* ── the code boxes ───────────────────────────────────────────────────── */

/**
 * Six boxes behaving like one field.
 *
 * The fiddly parts are the ones people actually do: pasting a code from a
 * message, letting the browser autofill it, backspacing through a typo, and
 * expecting it to submit itself once the last digit lands rather than hunting
 * for a button.
 */
function initCodeBoxes(onComplete) {
  const boxes = $$("#code input");

  const value = () => boxes.map((b) => b.value).join("");
  const clear = () => { for (const b of boxes) b.value = ""; };

  /** Spread a run of digits across the boxes from `from` onwards. */
  const fill = (digits, from = 0) => {
    const cleaned = digits.replace(/\D/g, "");
    for (let i = 0; i < cleaned.length && from + i < boxes.length; i++) {
      boxes[from + i].value = cleaned[i];
    }
    const next = Math.min(from + cleaned.length, boxes.length - 1);
    boxes[next].focus();
    boxes[next].select();
    if (value().length === boxes.length) onComplete();
  };

  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      // Autofill and paste both arrive as more than one character at once.
      if (box.value.length > 1) {
        const digits = box.value;
        box.value = "";
        fill(digits, i);
        return;
      }
      if (!/^\d$/.test(box.value)) { box.value = ""; return; }
      if (i < boxes.length - 1) boxes[i + 1].focus();
      if (value().length === boxes.length) onComplete();
    });

    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !box.value && i > 0) {
        e.preventDefault();
        boxes[i - 1].value = "";
        boxes[i - 1].focus();
      } else if (e.key === "ArrowLeft" && i > 0) {
        e.preventDefault(); boxes[i - 1].focus();
      } else if (e.key === "ArrowRight" && i < boxes.length - 1) {
        e.preventDefault(); boxes[i + 1].focus();
      }
    });

    box.addEventListener("paste", (e) => {
      e.preventDefault();
      fill(e.clipboardData.getData("text"), i);
    });

    box.addEventListener("focus", () => box.select());
  });

  return {
    value,
    clear,
    reset() {
      clear();
      boxes[0].focus();
    },
    /** A wrong code deserves a flinch, not just red text. */
    reject() {
      const group = $("#code");
      group.classList.remove("is-wrong");
      void group.offsetWidth;
      group.classList.add("is-wrong");
      clear();
      boxes[0].focus();
    },
  };
}

let codeBoxes;

/* ── the code's short life ────────────────────────────────────────────── */

const mmss = (seconds) => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Keep the code step honest about time: how long the code has left, and when
 * another one can be asked for. Both are real limits on the server, so saying
 * nothing would just produce a confusing refusal later.
 */
function startCodeClock() {
  clearInterval(startCodeClock.timer);

  const tick = () => {
    if (auth.step !== "code") return;

    const hint = $("[data-expiry]");
    const left = (auth.expiresAt - Date.now()) / 1000;
    hint.textContent = left > 0
      ? `Expires in ${mmss(left)}.`
      : "That code has expired — ask for another.";

    const resend = $("[data-resend]");
    const wait = (auth.resendAt - Date.now()) / 1000;
    if (wait > 0) {
      resend.disabled = true;
      resend.textContent = `Send another in ${mmss(wait)}`;
    } else {
      resend.disabled = false;
      resend.textContent = "Send another";
    }
  };

  tick();
  startCodeClock.timer = setInterval(tick, 1000);
}

/* ── the steps themselves ─────────────────────────────────────────────── */

/**
 * Guess the caller's country from their browser, so most people never touch
 * the dropdown. Only a default — the field is theirs to change.
 */
function guessRegion() {
  for (const tag of navigator.languages ?? [navigator.language]) {
    try {
      const region = new Intl.Locale(tag).region;
      if (region) return region;
    } catch {}
  }
  return "GB";
}

async function fillCallingCodes() {
  const select = $("#calling-code");
  try {
    const { countries } = await api("/api/auth/countries");
    select.innerHTML = countries
      .map((c) => `<option value="${c.code}">${c.code} ${c.callingCode}</option>`)
      .join("");
    const guess = guessRegion();
    if (countries.some((c) => c.code === guess)) select.value = guess;
  } catch {
    select.innerHTML = `<option value="GB">GB +44</option>`;
  }
}

async function requestCode() {
  const result = await post("/api/auth/request", {
    phone: $("#phone").value,
    country: $("#calling-code").value,
  });

  auth.phone = result.phone;
  auth.masked = result.masked;
  auth.expiresAt = Date.now() + result.expiresInSeconds * 1000;
  // Long enough that tapping twice cannot walk into the per-number ceiling.
  auth.resendAt = Date.now() + 30_000;

  $("[data-masked]").textContent = result.masked;
  codeBoxes.clear();
  showAuthStep("code");
  startCodeClock();
}

async function submitCode() {
  const error = errorFor("code");
  error.textContent = "";

  const code = codeBoxes.value();
  if (code.length !== 6) {
    error.textContent = "All six digits, please.";
    return;
  }

  await whileBusy($('#code-form button[type="submit"]'), async () => {
    try {
      const result = await post("/api/auth/verify", { phone: auth.phone, code });
      if (result.needsProfile) showAuthStep("profile");
      else await enterApp();
    } catch (ex) {
      error.textContent = ex.message;
      codeBoxes.reject();
    }
  });
}

function wireAuth() {
  fillCallingCodes();
  codeBoxes = initCodeBoxes(submitCode);
  initCityPicker($('[data-citypick="register"]'), (city) => {
    state.registerCity = city;
    // A small reward for answering: the globe goes and looks.
    aimAuthGlobe(city);
  });
  showAuthStep("phone");

  $("#phone-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = errorFor("phone");
    error.textContent = "";
    await whileBusy(e.target.querySelector("button"), async () => {
      try {
        await requestCode();
      } catch (ex) {
        error.textContent = ex.message;
      }
    });
  });

  $("#code-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitCode();
  });

  $("[data-resend]").addEventListener("click", async () => {
    const error = errorFor("code");
    error.textContent = "";
    try {
      await requestCode();
      toast("Another code is on its way.");
    } catch (ex) {
      error.textContent = ex.message;
      // The server refused, so do not promise a retry sooner than it will allow.
      auth.resendAt = Date.now() + 60_000;
    }
  });

  $("[data-restart]").addEventListener("click", () => {
    auth.phone = null;
    clearInterval(startCodeClock.timer);
    errorFor("code").textContent = "";
    codeBoxes.clear();
    showAuthStep("phone");
    $("#phone").select();
  });

  $("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const error = errorFor("profile");
    error.textContent = "";

    if (!state.registerCity) {
      error.textContent = "Pick the city you are standing in.";
      return;
    }

    await whileBusy(e.target.querySelector('button[type="submit"]'), async () => {
      try {
        await post("/api/auth/enrol", { handle: form.get("handle"), city: state.registerCity });
        await enterApp();
      } catch (ex) {
        error.textContent = ex.message;
      }
    });
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

  $("#globe-reset").addEventListener("click", () => {
    state.freeLook = false;
    $("#globe-reset").hidden = true;
    const msg = state.selected || state.quote;
    if (msg) frame(msg);
    else if (state.me) aimGlobe(state.me.lat, state.me.lon, 1.6);
    invalidateGlobe();
  });

  $("[data-hud-close]").addEventListener("click", () => {
    state.selected = null;
    $("#hud").hidden = true;
    renderLists();
    invalidateGlobe();
    state.freeLook = false;
    if (state.me) aimGlobe(state.me.lat, state.me.lon, 1.6);
  });

  $("#alerts").addEventListener("click", async () => {
    const button = $("#alerts");
    const note = $("#alerts-note");
    button.disabled = true;
    try {
      const subscription = await currentSubscription();
      if (subscription && Notification.permission === "granted") {
        await disableArrivalAlerts();
        toast("Arrival alerts off. Messages still arrive; you just will not be told.");
      } else {
        await enableArrivalAlerts();
        toast("Arrival alerts on. You can close this and go about your week.");
      }
    } catch (err) {
      note.hidden = false;
      note.textContent = err.message;
    } finally {
      button.disabled = false;
      renderAlerts();
    }
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
    state.freeLook = false;
    aimGlobe(state.me.lat, state.me.lon, 1.6);
    toast(`You are now standing in ${state.me.city}.`);
    if ($("#recipient").value) updateQuote();
  });
}

/* ──────────────────────────────── startup ─────────────────────────────── */

async function enterApp() {
  $("#auth").hidden = true;
  $("#app").hidden = false;

  globe = new Globe($("#globe"), world);
  globe.enableInteraction({
    // Any deliberate move hands control over; the app stops re-aiming until
    // the next route is chosen.
    onInteract: () => { state.freeLook = true; $("#globe-reset").hidden = false; invalidateGlobe(); },
  });

  const resize = () => { globe.resize(); invalidateGlobe(); };
  window.addEventListener("resize", resize);
  resize();

  await refresh();
  renderAlerts();
  globe.jumpTo(state.me.lat, state.me.lon, 1.6);

  // A read-only window onto the camera, so the browser tests can assert that
  // selecting a route really reframes the globe and that dragging really turns
  // it. Nothing in the app reads these.
  window.__globe = () => ({
    lat: +globe.center.lat.toFixed(3),
    lon: +globe.center.lon.toFixed(3),
    zoom: +globe.zoom.toFixed(3),
    textured: !!globe.texture,
  });

  startGlobeLoop();

  // The terrain is a megabyte, so the globe paints flat first and sharpens
  // into topography when it arrives.
  loadTerrain().then((image) => { if (image && globe) { globe.setTexture(image); invalidateGlobe(); } });
  // Once a second is ample for a courier crossing an ocean on foot.
  setInterval(() => { tickCards(); tickHud(); invalidateGlobe(); }, 1000);
  setInterval(() => refresh().catch(() => {}), 20000);
}

/**
 * The globe behind the sign-in card.
 *
 * It turns slowly on its own until someone says where they are standing, at
 * which point it stops and goes to look — a small reward for answering, and a
 * first glimpse of the thing the whole app is about.
 */
function startAuthGlobe() {
  const canvas = $("#auth-globe");
  authGlobe = new Globe(canvas, world);
  authGlobe.zoom = 1.35;
  // Turning constantly, it never gets to use the cached full-resolution raster,
  // and it sits behind a heavy scrim. Coarse pixels are plenty.
  authGlobe.motionQuality = 3;
  authGlobe.maxDpr = 1;

  const resize = () => authGlobe.resize();
  window.addEventListener("resize", resize);
  resize();

  loadTerrain().then((image) => { if (image && authGlobe) authGlobe.setTexture(image); });

  // A read-only window onto the camera, for the browser test.
  window.__authGlobe = () => ({
    lat: +authGlobe.center.lat.toFixed(3),
    lon: +authGlobe.center.lon.toFixed(3),
    zoom: +authGlobe.zoom.toFixed(3),
  });

  let lon = 0;
  const tick = () => {
    if ($("#auth").hidden) return;

    if (authHome) {
      // Handed over: ease to where they said they were and stay there.
      authGlobe.step(0.06);
    } else {
      lon = (lon + 0.045) % 360;
      authGlobe.setCenter(14, lon);
    }

    authGlobe.render({ to: authHome });
    requestAnimationFrame(tick);
  };
  tick();
}

/** Where the sign-in globe has been asked to look, once it has been asked. */
let authHome = null;

function aimAuthGlobe(city) {
  if (!authGlobe) return;
  authHome = { lat: city.lat, lon: city.lon };
  authGlobe.lookAt(city.lat, city.lon, 2.4);
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

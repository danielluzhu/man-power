/**
 * globe.js — an orthographic globe, drawn from scratch on a canvas.
 *
 * Why a globe rather than a flat map: every route here is a great circle, and
 * on a sphere a great circle is simply the shortest visible arc. A flat
 * projection would bend the Atlantic crossing into a curve that looks like a
 * detour, and would tear any route crossing the antimeridian in half.
 *
 * The interesting part is clipping. Half the sphere faces away from the viewer,
 * so coastline rings that straddle the limb must be cut against it. This uses
 * Sutherland-Hodgman clipping in 3D against the plane through the sphere's
 * centre perpendicular to the view axis, then walks the horizon circle between
 * successive exit and entry points — without that arc the clipped continents
 * get closed off with a straight chord and Africa grows a flat edge.
 */

const RAD = Math.PI / 180;

/** lon/lat degrees to a unit vector. */
function toVec(lon, lat) {
  const φ = lat * RAD, λ = lon * RAD;
  const cosφ = Math.cos(φ);
  return [cosφ * Math.cos(λ), cosφ * Math.sin(λ), Math.sin(φ)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export class Globe {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.world = world;
    this.center = { lat: 20, lon: 0 };
    this.zoom = 1;
    this.theme = {
      ocean: "#0b1a2a",
      oceanEdge: "#132a42",
      land: "#1e2f24",
      landStroke: "#33513c",
      graticule: "rgba(120,160,190,0.10)",
      limb: "rgba(140,190,220,0.35)",
    };
  }

  setCenter(lat, lon) {
    this.center = { lat, lon };
  }

  /** Orthographic basis for the current centre: view axis, east, north. */
  basis() {
    const c = toVec(this.center.lon, this.center.lat);
    const east = norm(cross([0, 0, 1], c));
    const north = cross(c, east);
    return { c, east, north };
  }

  metrics() {
    const { width, height } = this.canvas;
    const dpr = this.dpr || 1;
    return {
      cx: width / (2 * dpr),
      cy: height / (2 * dpr),
      r: (Math.min(width, height) / (2 * dpr)) * 0.92 * this.zoom,
    };
  }

  /** Unit vector to canvas point. Returns null when the point faces away. */
  project(v, b = this.basis(), m = this.metrics()) {
    if (dot(v, b.c) <= 0) return null;
    return { x: m.cx + m.r * dot(v, b.east), y: m.cy - m.r * dot(v, b.north) };
  }

  /** Same, but keeps points behind the sphere (used for horizon math). */
  projectRaw(v, b, m) {
    return { x: m.cx + m.r * dot(v, b.east), y: m.cy - m.r * dot(v, b.north) };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Clip a ring of unit vectors to the visible hemisphere.
   * Returns canvas-space polygons, with horizon arcs inserted where the ring
   * left and re-entered view.
   */
  clipRing(vectors, b, m) {
    const out = [];
    const n = vectors.length;
    if (!n) return out;

    // Sutherland-Hodgman against dot(p, c) = 0, tracking which vertices landed
    // on the horizon so arcs can be stitched in afterwards.
    const clipped = [];
    for (let i = 0; i < n; i++) {
      const p1 = vectors[i];
      const p2 = vectors[(i + 1) % n];
      const d1 = dot(p1, b.c);
      const d2 = dot(p2, b.c);

      if (d1 > 0) clipped.push({ v: p1, horizon: false });
      if (d1 > 0 !== d2 > 0) {
        const t = d1 / (d1 - d2);
        const mix = norm([
          p1[0] + t * (p2[0] - p1[0]),
          p1[1] + t * (p2[1] - p1[1]),
          p1[2] + t * (p2[2] - p1[2]),
        ]);
        clipped.push({ v: mix, horizon: true });
      }
    }
    if (clipped.length < 3) return out;

    // Walk the clipped ring, replacing horizon-to-horizon hops with real arcs.
    const poly = [];
    for (let i = 0; i < clipped.length; i++) {
      const cur = clipped[i];
      const next = clipped[(i + 1) % clipped.length];
      poly.push(this.projectRaw(cur.v, b, m));

      if (cur.horizon && next.horizon) {
        // Both sit on the limb: interpolate around it rather than cutting across.
        const a0 = Math.atan2(dot(cur.v, b.north), dot(cur.v, b.east));
        const a1 = Math.atan2(dot(next.v, b.north), dot(next.v, b.east));
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const steps = Math.max(1, Math.round(Math.abs(delta) / 0.05));
        for (let s = 1; s < steps; s++) {
          const a = a0 + (delta * s) / steps;
          poly.push({ x: m.cx + m.r * Math.cos(a), y: m.cy - m.r * Math.sin(a) });
        }
      }
    }
    out.push(poly);
    return out;
  }

  drawSphere(b, m) {
    const { ctx } = this;
    const grad = ctx.createRadialGradient(
      m.cx - m.r * 0.35, m.cy - m.r * 0.4, m.r * 0.1,
      m.cx, m.cy, m.r
    );
    grad.addColorStop(0, this.theme.oceanEdge);
    grad.addColorStop(1, this.theme.ocean);

    ctx.beginPath();
    ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = this.theme.limb;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawGraticule(b, m) {
    const { ctx } = this;
    ctx.strokeStyle = this.theme.graticule;
    ctx.lineWidth = 1;

    const stroke = (points) => {
      let drawing = false;
      ctx.beginPath();
      for (const p of points) {
        if (!p) { drawing = false; continue; }
        if (!drawing) { ctx.moveTo(p.x, p.y); drawing = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    };

    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 3) pts.push(this.project(toVec(lon, lat), b, m));
      stroke(pts);
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = [];
      for (let lat = -85; lat <= 85; lat += 3) pts.push(this.project(toVec(lon, lat), b, m));
      stroke(pts);
    }
  }

  drawLand(b, m) {
    const { ctx } = this;
    ctx.fillStyle = this.theme.land;
    ctx.strokeStyle = this.theme.landStroke;
    ctx.lineWidth = 0.7;

    for (const ring of this.world.rings) {
      // Cheap rejection: if no vertex faces the viewer, skip the ring entirely.
      const vectors = [];
      let anyVisible = false;
      for (let i = 0; i < ring.length; i += 2) {
        const v = toVec(ring[i], ring[i + 1]);
        if (!anyVisible && dot(v, b.c) > 0) anyVisible = true;
        vectors.push(v);
      }
      if (!anyVisible) continue;

      for (const poly of this.clipRing(vectors, b, m)) {
        if (poly.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /** Draw a route leg's polyline, breaking it wherever it passes behind. */
  drawLeg(points, color, width, b, m, dashed = false) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(dashed ? [4, 5] : []);

    let drawing = false;
    ctx.beginPath();
    for (const pt of points) {
      const p = this.project(toVec(pt.lon, pt.lat), b, m);
      if (!p) { drawing = false; continue; }
      if (!drawing) { ctx.moveTo(p.x, p.y); drawing = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawMarker(lat, lon, { fill, ring, radius = 4, label } = {}, b, m) {
    const p = this.project(toVec(lon, lat), b, m);
    if (!p) return;
    const { ctx } = this;

    if (ring) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = ring;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    if (label) {
      ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = "rgba(226,240,250,0.92)";
      ctx.textAlign = "center";
      ctx.fillText(label, p.x, p.y - radius - 9);
    }
  }

  /** Full repaint. `route` and `courier` are optional. */
  render({ route, from, to, courier, colors } = {}) {
    const { ctx, canvas } = this;
    const b = this.basis();
    const m = this.metrics();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawSphere(b, m);
    this.drawGraticule(b, m);
    this.drawLand(b, m);

    if (route?.legs?.length) {
      const run = colors?.run || "#f0b429";
      const swim = colors?.swim || "#38bdf8";
      // Dark casing first so the route reads over land and ocean alike.
      for (const leg of route.legs) this.drawLeg(leg.points, "rgba(2,8,15,0.65)", 5, b, m);
      for (const leg of route.legs) {
        this.drawLeg(leg.points, leg.mode === "swim" ? swim : run, 2.4, b, m, leg.mode === "swim");
      }
    }

    if (from) this.drawMarker(from.lat, from.lon, { fill: "#94a3b8", radius: 3.5 }, b, m);
    if (to) this.drawMarker(to.lat, to.lon, { fill: "#e2e8f0", ring: "rgba(226,232,240,0.4)", radius: 4 }, b, m);
    if (courier) {
      this.drawMarker(courier.lat, courier.lon, {
        fill: courier.mode === "swim" ? "#38bdf8" : "#f0b429",
        ring: courier.mode === "swim" ? "rgba(56,189,248,0.5)" : "rgba(240,180,41,0.5)",
        radius: 5,
      }, b, m);
    }
  }
}

export async function loadWorld() {
  const res = await fetch("/world.json");
  return res.json();
}

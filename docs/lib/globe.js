/**
 * globe.js — an interactive topographic globe, drawn from scratch on a canvas.
 *
 * Why a globe rather than a flat map: every route here is a path across the
 * surface of the world, and a flat projection would bend an Atlantic crossing
 * into what looks like a detour and tear any antimeridian route in half.
 *
 * TWO WAYS TO DRAW THE SURFACE
 * ----------------------------
 * With a terrain texture, the sphere is drawn per pixel: each pixel inside the
 * disc is projected back to a latitude and longitude and sampled from an
 * equirectangular shaded-relief image. That gives real topography — you can see
 * the route thread between mountains rather than over them.
 *
 * Without one, it falls back to filled coastline polygons. That path still
 * matters: it paints immediately while the texture is still downloading, and it
 * is what the sign-in screen uses before anything else has loaded.
 *
 * The polygon path has to clip rings against the limb, since half the sphere
 * faces away. It uses Sutherland-Hodgman in 3D against the view plane, then
 * walks the horizon circle between successive exit and entry points — without
 * that arc the clip closes continents off with a straight chord and Africa
 * grows a flat edge.
 *
 * MOTION
 * ------
 * The globe owns its own camera. `lookAt` sets a target and the view eases
 * toward it; dragging moves it directly and cancels the target. Rasterising a
 * million pixels every frame would be wasteful, so the terrain is cached and
 * only redrawn when the view actually changes — at reduced resolution while
 * moving, at full resolution once it settles.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

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

/** Shortest signed difference between two longitudes, in degrees. */
function wrapLon(delta) {
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

export const MIN_ZOOM = 0.85;
/**
 * The terrain texture is 2048 wide, so a texel is about 20 km. Past this the
 * view is magnifying data that was never there; the limit keeps the globe
 * honest about its own resolution.
 */
export const MAX_ZOOM = 9;

export class Globe {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.world = world;

    this.center = { lat: 20, lon: 0 };
    this.target = { lat: 20, lon: 0, zoom: 1 };
    this.zoom = 1;
    this.dpr = 1;

    /** Pixel step used while the view is moving. Higher is coarser and cheaper. */
    this.motionQuality = 2;

    /**
     * Cap on the backing resolution. A globe that animates continuously has to
     * be composited every frame, and at device pixel ratio 2 a full-window
     * canvas is four times the pixels for a backdrop nobody reads detail from.
     */
    this.maxDpr = Infinity;

    this.texture = null;
    this.dragging = false;
    this.onInteract = null;

    this.theme = {
      ocean: "#0b1a2a",
      oceanEdge: "#132a42",
      land: "#1e2f24",
      landStroke: "#33513c",
      graticule: "rgba(120,160,190,0.10)",
      limb: "rgba(140,190,220,0.35)",
    };

    this._cacheKey = null;
    this._cache = document.createElement("canvas");
    this._image = null;
    this._vignetteKey = null;
  }

  /* ────────────────────────────── camera ────────────────────────────── */

  setCenter(lat, lon) {
    this.center = { lat, lon };
  }

  /** Point the camera somewhere, easing there over the next few frames. */
  lookAt(lat, lon, zoom = this.target.zoom) {
    this.target = {
      lat,
      // Take the short way round rather than unwinding the long way.
      lon: this.center.lon + wrapLon(lon - this.center.lon),
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)),
    };
  }

  /** Jump straight there, with no easing. */
  jumpTo(lat, lon, zoom = this.zoom) {
    this.lookAt(lat, lon, zoom);
    this.center = { lat: this.target.lat, lon: this.target.lon };
    this.zoom = this.target.zoom;
  }

  /** True while the view is still travelling toward its target. */
  get moving() {
    return (
      this.dragging ||
      Math.abs(this.target.lat - this.center.lat) > 0.02 ||
      Math.abs(this.target.lon - this.center.lon) > 0.02 ||
      Math.abs(this.target.zoom - this.zoom) > 0.002
    );
  }

  /** Advance the easing by one frame. */
  step(ease = 0.09) {
    if (this.dragging) return;
    this.center.lat += (this.target.lat - this.center.lat) * ease;
    this.center.lon += (this.target.lon - this.center.lon) * ease;
    this.zoom += (this.target.zoom - this.zoom) * ease;
  }

  /**
   * Camera that frames a whole route: centred on the mean of its points, zoomed
   * so the furthest one still sits inside the disc.
   *
   * Averaging the points rather than the two endpoints matters — a route
   * arcing up through Greenland is nowhere near the midpoint of its ends.
   */
  frameRoute(route, from, to) {
    const points = [];
    if (from) points.push(from);
    for (const leg of route?.legs ?? []) points.push(...leg.points);
    if (to) points.push(to);
    if (!points.length) return null;

    let sum = [0, 0, 0];
    for (const p of points) {
      const v = toVec(p.lon, p.lat);
      sum = [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]];
    }
    const centre = norm(sum);
    const lat = Math.asin(Math.max(-1, Math.min(1, centre[2]))) * DEG;
    const lon = Math.atan2(centre[1], centre[0]) * DEG;

    // Angular radius of the route about that centre.
    let widest = 0;
    for (const p of points) {
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(centre, toVec(p.lon, p.lat)))));
      if (angle > widest) widest = angle;
    }

    // A point `widest` radians from the centre lands at r·sin(widest) on screen.
    // Leave a margin so the route is not flush against the limb.
    const spread = Math.max(Math.sin(widest), 0.02);
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, 0.82 / (0.92 * spread)));
    return { lat, lon, zoom };
  }

  /* ──────────────────────────── projection ──────────────────────────── */

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

  /** Canvas point back to a position on the sphere, or null if off the disc. */
  unproject(x, y, b = this.basis(), m = this.metrics()) {
    const u = (x - m.cx) / m.r;
    const v = (m.cy - y) / m.r;
    const d2 = u * u + v * v;
    if (d2 > 1) return null;
    const w = Math.sqrt(1 - d2);
    const p = [
      u * b.east[0] + v * b.north[0] + w * b.c[0],
      u * b.east[1] + v * b.north[1] + w * b.c[1],
      u * b.east[2] + v * b.north[2] + w * b.c[2],
    ];
    return {
      lat: Math.asin(Math.max(-1, Math.min(1, p[2]))) * DEG,
      lon: Math.atan2(p[1], p[0]) * DEG,
    };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cacheKey = null;
  }

  /* ───────────────────────────── terrain ────────────────────────────── */

  /**
   * Supply the shaded-relief image. Accepts either raw pixels from
   * buildTerrainTexture, or anything drawable (an <img>, an ImageBitmap) which
   * is read back once into a pixel buffer.
   */
  setTexture(source) {
    if (!source) { this.texture = null; return; }

    if (source.pixels) {
      this.texture = { width: source.width, height: source.height, pixels: source.pixels };
    } else {
      const scratch = document.createElement("canvas");
      scratch.width = source.width || source.naturalWidth;
      scratch.height = source.height || source.naturalHeight;
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(source, 0, 0);
      const data = ctx.getImageData(0, 0, scratch.width, scratch.height);
      this.texture = { width: scratch.width, height: scratch.height, pixels: data.data };
    }
    this._cacheKey = null;
  }

  /**
   * Rasterise the lit hemisphere, sampling the texture per pixel.
   *
   * Cached against the view, because at full resolution this is a million
   * inverse projections and there is no reason to repeat them while the globe
   * sits still.
   */
  #rasteriseTerrain(b, m) {
    // Size the buffer to the *viewport*, never to the sphere. Zoomed in, the
    // globe is far larger than the screen and all but a sliver of it is off it;
    // sizing to the sphere asks for tens of millions of pixels and hangs.
    const cssWidth = this.canvas.width / this.dpr;
    const cssHeight = this.canvas.height / this.dpr;

    // Full resolution once the view settles, unless that is a lot of pixels.
    const settledStep = cssWidth * cssHeight > 900_000 ? 2 : 1;
    const step = this.moving ? this.motionQuality : settledStep;

    const width = Math.max(2, Math.ceil(cssWidth / step));
    const height = Math.max(2, Math.ceil(cssHeight / step));
    const key = `${this.center.lat.toFixed(3)},${this.center.lon.toFixed(3)},${this.zoom.toFixed(4)},${width}x${height}`;
    if (key === this._cacheKey) return this._cache;

    const cache = this._cache;
    const ctx = cache.getContext("2d");
    if (cache.width !== width || cache.height !== height) {
      cache.width = width;
      cache.height = height;
      this._image = null;
    }

    // Reuse the pixel buffer between frames. Allocating half a megabyte per
    // frame is most of the cost of an animated globe, and all of it garbage.
    if (!this._image) this._image = ctx.createImageData(width, height);
    const image = this._image;
    const out = image.data;
    out.fill(0);

    const { pixels, width: tw, height: th } = this.texture;
    const [ex, ey, ez] = b.east;
    const [nx, ny, nz] = b.north;
    const [cx3, cy3, cz3] = b.c;

    for (let py = 0; py < height; py++) {
      const v = (m.cy - (py + 0.5) * step) / m.r;
      const v2 = v * v;
      if (v2 > 1) continue; // whole row misses the sphere
      const rowBase = py * width * 4;

      // Only the span of this row that actually crosses the disc needs testing.
      const halfSpan = Math.sqrt(1 - v2) * m.r;
      const from = Math.max(0, Math.floor((m.cx - halfSpan) / step));
      const to = Math.min(width - 1, Math.ceil((m.cx + halfSpan) / step));

      for (let px = from; px <= to; px++) {
        const u = ((px + 0.5) * step - m.cx) / m.r;
        const d2 = u * u + v2;
        if (d2 > 1) continue;

        const w = Math.sqrt(1 - d2);
        const x = u * ex + v * nx + w * cx3;
        const y = u * ey + v * ny + w * cy3;
        const z = u * ez + v * nz + w * cz3;

        const lat = Math.asin(z > 1 ? 1 : z < -1 ? -1 : z) * DEG;
        const lon = Math.atan2(y, x) * DEG;

        // Bilinear sampling. Nearest-neighbour turns the coastline into
        // visible 20 km blocks as soon as the globe zooms in on a strait; this
        // costs four fetches instead of one and looks like terrain instead of
        // like a spreadsheet.
        const fx = ((lon + 180) / 360) * tw - 0.5;
        const fy = ((90 - lat) / 180) * th - 0.5;

        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const wx = fx - ix;
        const wy = fy - iy;

        // Longitude wraps at the antimeridian; latitude clamps at the poles.
        const x0 = ((ix % tw) + tw) % tw;
        const x1 = (x0 + 1) % tw;
        const y0 = iy < 0 ? 0 : iy >= th ? th - 1 : iy;
        const y1 = y0 + 1 >= th ? th - 1 : y0 + 1;

        const a = (y0 * tw + x0) * 4;
        const bIdx = (y0 * tw + x1) * 4;
        const cIdx = (y1 * tw + x0) * 4;
        const d = (y1 * tw + x1) * 4;

        const w00 = (1 - wx) * (1 - wy);
        const w10 = wx * (1 - wy);
        const w01 = (1 - wx) * wy;
        const w11 = wx * wy;

        const target = rowBase + px * 4;
        out[target] = pixels[a] * w00 + pixels[bIdx] * w10 + pixels[cIdx] * w01 + pixels[d] * w11;
        out[target + 1] = pixels[a + 1] * w00 + pixels[bIdx + 1] * w10 + pixels[cIdx + 1] * w01 + pixels[d + 1] * w11;
        out[target + 2] = pixels[a + 2] * w00 + pixels[bIdx + 2] * w10 + pixels[cIdx + 2] * w01 + pixels[d + 2] * w11;
        out[target + 3] = 255;
      }
    }

    ctx.putImageData(image, 0, 0);
    this._cacheKey = key;
    this._cacheStep = step;
    return cache;
  }

  #drawTerrain(b, m) {
    const cache = this.#rasteriseTerrain(b, m);
    const { ctx } = this;
    const cssWidth = this.canvas.width / this.dpr;
    const cssHeight = this.canvas.height / this.dpr;

    ctx.save();
    // Bilinear is plenty for upscaling shaded relief, and "high" costs several
    // milliseconds a frame on a full-window canvas for no visible gain.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(cache, 0, 0, cssWidth, cssHeight);
    ctx.restore();

    // A little shading towards the limb, so the disc reads as a sphere. The
    // gradient only depends on the geometry, so it is rebuilt on resize and
    // zoom rather than on every frame.
    const shape = `${m.cx.toFixed(1)},${m.cy.toFixed(1)},${m.r.toFixed(1)}`;
    if (shape !== this._vignetteKey) {
      const vignette = ctx.createRadialGradient(
        m.cx - m.r * 0.3, m.cy - m.r * 0.35, m.r * 0.05,
        m.cx, m.cy, m.r
      );
      vignette.addColorStop(0, "rgba(255,255,255,0.07)");
      vignette.addColorStop(0.55, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.45)");
      this._vignette = vignette;
      this._vignetteKey = shape;
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = this._vignette;
    // Clipped to the disc, so only the visible part is ever painted.
    ctx.fillRect(
      Math.max(0, m.cx - m.r), Math.max(0, m.cy - m.r),
      Math.min(cssWidth, m.r * 2), Math.min(cssHeight, m.r * 2)
    );
    ctx.restore();
  }

  /* ───────────────────────── vector fallback ────────────────────────── */

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
  }

  /**
   * Clip a ring of unit vectors to the visible hemisphere, inserting horizon
   * arcs where the ring left and re-entered view.
   */
  clipRing(vectors, b, m) {
    const out = [];
    const n = vectors.length;
    if (!n) return out;

    const clipped = [];
    for (let i = 0; i < n; i++) {
      const p1 = vectors[i];
      const p2 = vectors[(i + 1) % n];
      const d1 = dot(p1, b.c);
      const d2 = dot(p2, b.c);

      if (d1 > 0) clipped.push({ v: p1, horizon: false });
      if (d1 > 0 !== d2 > 0) {
        const t = d1 / (d1 - d2);
        clipped.push({
          v: norm([
            p1[0] + t * (p2[0] - p1[0]),
            p1[1] + t * (p2[1] - p1[1]),
            p1[2] + t * (p2[2] - p1[2]),
          ]),
          horizon: true,
        });
      }
    }
    if (clipped.length < 3) return out;

    const poly = [];
    for (let i = 0; i < clipped.length; i++) {
      const cur = clipped[i];
      const next = clipped[(i + 1) % clipped.length];
      poly.push(this.projectRaw(cur.v, b, m));

      if (cur.horizon && next.horizon) {
        // Both sit on the limb: follow it round rather than cutting across.
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

  drawLand(b, m) {
    const { ctx } = this;
    ctx.fillStyle = this.theme.land;
    ctx.strokeStyle = this.theme.landStroke;
    ctx.lineWidth = 0.7;

    for (const ring of this.world?.rings ?? []) {
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

  /* ─────────────────────────── overlays ─────────────────────────────── */

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

    // Denser lines as you zoom in, so the grid stays a useful scale reference.
    const spacing = this.zoom > 4 ? 10 : this.zoom > 2 ? 15 : 30;
    for (let lat = -80; lat <= 80; lat += spacing) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 3) pts.push(this.project(toVec(lon, lat), b, m));
      stroke(pts);
    }
    for (let lon = -180; lon < 180; lon += spacing) {
      const pts = [];
      for (let lat = -85; lat <= 85; lat += 3) pts.push(this.project(toVec(lon, lat), b, m));
      stroke(pts);
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

    if (this.texture) {
      this.#drawTerrain(b, m);
    } else {
      this.drawSphere(b, m);
      this.drawLand(b, m);
    }

    this.drawGraticule(b, m);

    ctx.beginPath();
    ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2);
    ctx.strokeStyle = this.theme.limb;
    ctx.lineWidth = 1;
    ctx.stroke();

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

  /* ───────────────────────── interaction ────────────────────────────── */

  /**
   * Let the viewer spin the globe with the cursor and zoom with the wheel.
   *
   * Dragging rotates rather than pans: the horizontal movement is converted to
   * an arc along the surface, so the point under the cursor keeps up with it
   * near the centre of the disc. Latitude is clamped short of the poles, where
   * an orthographic view has nothing left to turn.
   */
  enableInteraction({ onInteract } = {}) {
    const canvas = this.canvas;
    this.onInteract = onInteract;
    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";

    const pointers = new Map();
    let last = null;
    let pinchStart = null;

    const notify = () => this.onInteract?.();

    const distanceBetween = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        this.dragging = true;
        last = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = "grabbing";
      } else if (pointers.size === 2) {
        pinchStart = { spread: distanceBetween(), zoom: this.zoom };
      }
      notify();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size >= 2 && pinchStart) {
        const scale = distanceBetween() / (pinchStart.spread || 1);
        this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStart.zoom * scale));
        this.target.zoom = this.zoom;
        this._cacheKey = null;
        return;
      }
      if (!this.dragging || !last) return;

      const m = this.metrics();
      // One radius of travel is one radian of rotation, which keeps the surface
      // roughly under the cursor and slows down sensibly as you zoom in.
      const perPixel = DEG / m.r;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };

      // Longitude turns faster near the poles, where circles of latitude are
      // short; without this the globe feels stuck at high latitudes.
      const cosLat = Math.max(0.25, Math.cos(this.center.lat * RAD));
      this.center.lon -= (dx * perPixel) / cosLat;
      this.center.lat = Math.max(-89, Math.min(89, this.center.lat + dy * perPixel));

      // Keep the target with us, so letting go does not spring back.
      this.target.lat = this.center.lat;
      this.target.lon = this.center.lon;
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) {
        this.dragging = false;
        last = null;
        canvas.style.cursor = "grab";
      }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.target.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.target.zoom * factor));
      notify();
    }, { passive: false });

    canvas.addEventListener("dblclick", (e) => {
      // Double-click to centre on whatever is under the cursor and close in.
      const rect = canvas.getBoundingClientRect();
      const hit = this.unproject(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) this.lookAt(hit.lat, hit.lon, Math.min(MAX_ZOOM, this.target.zoom * 1.8));
      notify();
    });
  }
}

export async function loadWorld() {
  const res = await fetch("/world.json");
  return res.json();
}

/** Fetch the baked shaded-relief texture. Resolves to null if it is missing. */
export function loadTerrain(src = "/terrain.png") {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

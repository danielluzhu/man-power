/**
 * png.js — a minimal PNG encoder, enough to bake the globe texture at build
 * time. Truecolour, 8 bits per channel, no alpha, no interlacing.
 *
 * Written rather than depended on because it is a small, closed format and the
 * project otherwise has no image toolchain: chunk, CRC, deflate, done. The one
 * part that earns its keep is per-row filter selection — a shaded relief map is
 * mostly smooth gradients, and choosing between None, Sub, Up and Average per
 * scanline roughly halves the file against no filtering at all.
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)), false);
  return out;
}

/** Sum of absolute differences, the standard heuristic for picking a filter. */
function score(row) {
  let total = 0;
  for (let i = 0; i < row.length; i++) total += row[i] < 128 ? row[i] : 256 - row[i];
  return total;
}

/**
 * Encode RGBA pixels as an RGB PNG. Alpha is dropped: the texture is fully
 * opaque, and carrying a constant channel would only cost bytes.
 */
export function encodePng(width, height, rgba) {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);

  const current = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = x * 3;
      current[to] = rgba[from];
      current[to + 1] = rgba[from + 1];
      current[to + 2] = rgba[from + 2];
    }

    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? current[i - 3] : 0;
      const above = previous[i];
      candidates[0][i] = current[i];                                   // None
      candidates[1][i] = (current[i] - left) & 0xff;                   // Sub
      candidates[2][i] = (current[i] - above) & 0xff;                  // Up
      candidates[3][i] = (current[i] - ((left + above) >> 1)) & 0xff;  // Average
    }

    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 4; f++) {
      const s = score(candidates[f]);
      if (s < bestScore) { bestScore = s; best = f; }
    }

    const at = y * (stride + 1);
    raw[at] = best;
    raw.set(candidates[best], at + 1);
    previous.set(current);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width, false);
  header.setUint32(4, height, false);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = deflateSync(raw, { level: 9 });

  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

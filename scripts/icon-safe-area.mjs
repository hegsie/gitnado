/**
 * Icon contract: what the shipped icon files must look like.
 *
 * `build-icons.mjs` produces every icon from the art master; this module
 * reads the produced files back — PNGs, the ICO and the ICNS containers —
 * and measures what each actually occupies on its canvas, so the test can
 * hold two things in place without trusting anyone's memory:
 *   - the macOS entries sit on Apple's 824/1024 grid (the Dock fix — see
 *     `src-tauri/icons/README.md` for why), shadow included but inside the
 *     canvas;
 *   - everything else is full-bleed, because Windows, Linux and the website
 *     composite their own shape and would render a padded tile undersized.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { alphaOf, decodePng, isPng } from './png.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Alpha at or below this counts as empty canvas when measuring a body.
 * Two things live below it: resampling bleed (a pixel or two of near-zero
 * alpha past an edge — at 32x32 the outermost column reads alpha 1), and
 * the macOS shadow, which peaks at 30% (alpha 77). Anything above is tile.
 */
export const BODY_ALPHA_THRESHOLD = 100;

/**
 * Split an ICNS container into its entries. The header is `icns` plus a
 * big-endian total length; each entry is a four-character type, a big-endian
 * length that COUNTS those eight header bytes, then the payload.
 */
export function readIcnsEntries(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('latin1') !== 'icns') {
    throw new Error('not an ICNS container');
  }
  const declared = buffer.readUInt32BE(4);
  if (declared !== buffer.length) {
    throw new Error(`ICNS length header says ${declared}, file is ${buffer.length}`);
  }
  const entries = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('latin1');
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) {
      throw new Error(`ICNS entry '${type}' has an out-of-range length ${length}`);
    }
    entries.push({ type, payload: buffer.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return entries;
}

/**
 * Split an ICO into `[{ size, payload }]`. Only PNG-compressed entries are
 * accepted — that is what the build writes; a BMP entry throws.
 */
export function readIcoEntries(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error('not an ICO file');
  }
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 16 * i;
    if (at + 16 > buffer.length) throw new Error(`ICO directory entry ${i} is past the end of the file`);
    const size = buffer[at] === 0 ? 256 : buffer[at];
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (offset + length > buffer.length) throw new Error(`ICO entry ${i} has an out-of-range payload`);
    const payload = buffer.subarray(offset, offset + length);
    if (!isPng(payload)) throw new Error(`ICO entry ${i} (${size}px) is not PNG-compressed`);
    entries.push({ size, payload });
  }
  return entries;
}

/** An `{ width, height, alpha }` view of a PNG buffer. */
export function pngAlpha(buffer) {
  const image = decodePng(buffer);
  return { width: image.width, height: image.height, alpha: alphaOf(image) };
}

/** An `{ width, height, alpha }` view of a raw 8-bit ICNS mask (s8mk, l8mk). */
export function maskAlpha(payload, size) {
  if (payload.length !== size * size) {
    throw new Error(`mask is ${payload.length} bytes, expected ${size * size} for ${size}x${size}`);
  }
  return { width: size, height: size, alpha: Uint8Array.from(payload) };
}

/**
 * The empty canvas around the visible artwork, in pixels per edge. A fully
 * transparent image reports the full width and height on every edge.
 */
export function measureMargins({ width, height, alpha }, threshold = BODY_ALPHA_THRESHOLD) {
  let left = width;
  let top = height;
  let right = width;
  let bottom = height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x] <= threshold) continue;
      if (x < left) left = x;
      if (width - 1 - x < right) right = width - 1 - x;
      if (y < top) top = y;
      if (height - 1 - y < bottom) bottom = height - 1 - y;
    }
  }
  return { left, top, right, bottom };
}

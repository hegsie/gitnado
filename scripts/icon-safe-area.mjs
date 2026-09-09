/**
 * macOS app-icon safe-area contract.
 *
 * macOS does not draw the app icon inside a frame of its own — the icon IS
 * the frame. Apple's icon grid therefore reserves a transparent margin: on a
 * 1024x1024 canvas the rounded-square body is 824x824, centred, leaving
 * 100px (9.77%) of empty canvas on every side. The Dock, Launchpad, the
 * Finder and the app switcher all lay icons out on that grid.
 *
 * Ship a full-bleed tile instead — artwork edge to edge, no margin — and the
 * icon renders roughly a fifth larger than every neighbour, overflows the
 * Dock's tile, and has its corners shaved by the system's own rounding. That
 * is what "the icon is cut off" looks like, and it is what `icon.icns` did
 * before this contract existed: `icon-source.png` is a full-bleed 1024 tile,
 * and `tauri icon` resizes without ever adding a margin.
 *
 * So there are two masters, on purpose:
 *   - `icon-source.png`        full-bleed, drives Windows, Linux and the
 *                              website assets, which are composited by the
 *                              host and want every pixel;
 *   - `icon-source-macos.png`  the same art scaled to Apple's 824/1024 body
 *                              on a transparent canvas, drives `icon.icns`
 *                              alone.
 *
 * This module measures what a PNG actually occupies on its canvas, straight
 * from the file, so both halves of that split are checked rather than
 * remembered. Regenerating the icons from the wrong master — the easy
 * mistake, since `tauri icon <source>` rewrites the whole directory — moves
 * a margin in one direction or the other and is caught here.
 *
 * Scope, stated rather than hidden: only 8-bit, non-interlaced, truecolour+
 * alpha PNGs (colour type 6) are decoded, which is what `tauri icon` emits;
 * anything else throws instead of being silently measured wrong. `icon.ico`
 * and the mobile icon sets are not measured — Windows and Android composite
 * their own shape, so the margin carries no meaning there.
 */

import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ICONS_DIR = join(REPO_ROOT, 'src-tauri/icons');

/** Apple's icon grid: an 824x824 body centred on a 1024x1024 canvas. */
export const APPLE_CANVAS = 1024;
export const APPLE_BODY = 824;
export const APPLE_MARGIN = (APPLE_CANVAS - APPLE_BODY) / 2;

/**
 * Alpha at or below this counts as empty canvas. Downscaling bleeds a pixel
 * or two of near-zero alpha past the body's edge — at 32x32 the outermost
 * column reads alpha 1 — and treating that as content would report a margin
 * of 0 for an icon that plainly has one.
 */
export const ALPHA_THRESHOLD = 8;

/**
 * The margin the .icns entries must leave, as a fraction of their own width.
 * Apple's grid is 9.77%; the smallest entries land at 9.38% because their
 * margin has to be a whole number of pixels (3px of 32). The upper bound is
 * as much the point as the lower one: over-padding makes the icon read as
 * undersized next to its neighbours.
 */
export const MIN_SAFE_AREA = 0.08;
export const MAX_SAFE_AREA = 0.12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ICNS entry types whose payload is a PNG, in the set `tauri icon` writes. */
export const ICNS_PNG_TYPES = ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14'];

/** True when `buffer` starts with the PNG signature. */
export function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Split an ICNS container into its entries. The header is `icns` plus a
 * big-endian total length; each entry is a four-character type, a big-endian
 * length that COUNTS those eight header bytes, then the payload.
 */
export function readIcnsEntries(buffer) {
  if (buffer.subarray(0, 4).toString('latin1') !== 'icns') {
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

/** The PNG-carrying entries of an ICNS container, in file order. */
export function readIcnsPngEntries(buffer) {
  return readIcnsEntries(buffer).filter((entry) => isPng(entry.payload));
}

/** Undo a single PNG scanline filter in place. `bpp` is bytes per pixel. */
function unfilterScanline(filter, line, previous, bpp) {
  switch (filter) {
    case 0:
      break;
    case 1: // Sub
      for (let i = bpp; i < line.length; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2: // Up
      for (let i = 0; i < line.length; i += 1) line[i] = (line[i] + previous[i]) & 0xff;
      break;
    case 3: // Average
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < line.length; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = previous[i];
        const c = i >= bpp ? previous[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + predictor) & 0xff;
      }
      break;
    default:
      throw new Error(`unknown PNG scanline filter ${filter}`);
  }
}

/**
 * Decode the alpha channel of an 8-bit truecolour+alpha PNG.
 * Returns `{ width, height, alpha }`, alpha in row-major order.
 */
export function decodePngAlpha(buffer) {
  if (!isPng(buffer)) throw new Error('not a PNG');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colourType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
    throw new Error(
      `unsupported PNG (bit depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}); ` +
        'this reader handles 8-bit RGBA, non-interlaced only',
    );
  }

  const idat = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length; // length + type + data + CRC
  }
  if (idat.length === 0) throw new Error('PNG has no IDAT chunk');

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PNG pixel data is truncated');

  const alpha = new Uint8Array(width * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilterScanline(raw[start], line, previous, bpp);
    for (let x = 0; x < width; x += 1) alpha[y * width + x] = line[x * bpp + 3];
    previous = line;
  }
  return { width, height, alpha };
}

/**
 * The empty canvas around the visible artwork, in pixels per edge. A fully
 * transparent image reports the full width and height on every edge.
 */
export function measureMargins({ width, height, alpha }, threshold = ALPHA_THRESHOLD) {
  let left = width;
  let right = width;
  let top = height;
  let bottom = height;
  let seen = false;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x] <= threshold) continue;
      seen = true;
      if (x < left) left = x;
      if (width - 1 - x < right) right = width - 1 - x;
      if (y < top) top = y;
      if (height - 1 - y < bottom) bottom = height - 1 - y;
    }
  }
  return seen ? { left, top, right, bottom } : { left: width, top: height, right: width, bottom: height };
}

/** `measureMargins` as a fraction of the canvas — the form the grid states. */
export function safeAreaRatios(image, threshold = ALPHA_THRESHOLD) {
  const { left, top, right, bottom } = measureMargins(image, threshold);
  return {
    left: left / image.width,
    right: right / image.width,
    top: top / image.height,
    bottom: bottom / image.height,
  };
}

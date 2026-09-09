/**
 * Minimal PNG codec for the icon tooling: 8-bit RGBA in and out, nothing
 * else. Both `build-icons.mjs` and the icon contract test read the shipped
 * files through this, so what the test measures is what the build wrote.
 *
 * Decoding accepts only 8-bit, non-interlaced, truecolour+alpha files
 * (colour type 6) — what the build emits and what the art master is — and
 * throws on anything else rather than measuring it wrong. Encoding picks
 * a scanline filter per row (the usual minimum-sum-of-residuals heuristic)
 * under maximum deflate; the output is a pure function of the pixels, so
 * a fresh build compares against the committed files.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

/** The repository root; shared by the build and the contract so both read the same tree. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4;

/** CRC-32 (IEEE), table-driven — `node:zlib` only grew one in 20.15/22.2. */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The Paeth predictor (PNG spec 9.4): whichever of a, b, c is nearest a + b - c, ties to a, then b. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** True when `buffer` starts with the PNG signature. */
export function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
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
        const c = i >= bpp ? previous[i - bpp] : 0;
        line[i] = (line[i] + paeth(a, previous[i], c)) & 0xff;
      }
      break;
    default:
      throw new Error(`unknown PNG scanline filter ${filter}`);
  }
}

/**
 * Decode an 8-bit RGBA PNG. Returns `{ width, height, data }`, `data` a
 * `Uint8Array` of straight (non-premultiplied) RGBA in row-major order.
 */
export function decodePng(buffer) {
  if (!isPng(buffer)) throw new Error('not a PNG');
  if (buffer.length < 33 || buffer.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('PNG has no IHDR chunk');
  }
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
  const stride = width * BYTES_PER_PIXEL;
  if (raw.length < height * (stride + 1)) throw new Error('PNG pixel data is truncated');

  const data = new Uint8Array(width * height * BYTES_PER_PIXEL);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilterScanline(raw[start], line, previous, BYTES_PER_PIXEL);
    data.set(line, y * stride);
    previous = line;
  }
  return { width, height, data };
}

/** One channel (0 R, 1 G, 2 B, 3 A) of an image as its own plane, one byte per pixel. */
export function channelOf({ width, height, data }, channel) {
  const plane = new Uint8Array(width * height);
  for (let i = 0; i < plane.length; i += 1) plane[i] = data[i * BYTES_PER_PIXEL + channel];
  return plane;
}

/** The alpha plane of a decoded image, one byte per pixel. */
export const alphaOf = (image) => channelOf(image, 3);

function chunk(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload, crc32(Buffer.from(type, 'latin1'))), 0);
  return Buffer.concat([header, payload, crc]);
}

/** Apply PNG scanline filter `type` to `line` (given the previous unfiltered row). */
function filterScanline(type, line, previous, bpp) {
  const out = Buffer.alloc(line.length);
  for (let i = 0; i < line.length; i += 1) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = previous[i];
    const c = i >= bpp ? previous[i - bpp] : 0;
    let predictor;
    switch (type) {
      case 0:
        predictor = 0;
        break;
      case 1:
        predictor = a;
        break;
      case 2:
        predictor = b;
        break;
      case 3:
        predictor = (a + b) >> 1;
        break;
      default:
        predictor = paeth(a, b, c);
    }
    out[i] = (line[i] - predictor) & 0xff;
  }
  return out;
}

/** The heuristic libpng uses: the filter whose residuals, read as signed bytes, sum smallest. */
function bestFilter(line, previous, bpp) {
  let best = null;
  let bestScore = Infinity;
  for (let type = 0; type <= 4; type += 1) {
    const filtered = filterScanline(type, line, previous, bpp);
    let score = 0;
    for (let i = 0; i < filtered.length; i += 1) score += filtered[i] < 128 ? filtered[i] : 256 - filtered[i];
    if (score < bestScore) {
      bestScore = score;
      best = { type, filtered };
    }
  }
  return best;
}

/** Encode `{ width, height, data }` (straight 8-bit RGBA) as a PNG buffer. */
export function encodePng({ width, height, data }) {
  if (data.length !== width * height * BYTES_PER_PIXEL) {
    throw new Error(`pixel buffer is ${data.length} bytes, expected ${width * height * BYTES_PER_PIXEL}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const stride = width * BYTES_PER_PIXEL;
  const raw = Buffer.alloc(height * (stride + 1));
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.from(data.buffer, data.byteOffset + y * stride, stride);
    const { type, filtered } = bestFilter(line, previous, BYTES_PER_PIXEL);
    raw[y * (stride + 1)] = type;
    raw.set(filtered, y * (stride + 1) + 1);
    previous = line;
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

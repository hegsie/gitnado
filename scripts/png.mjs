/**
 * Minimal PNG codec for the icon tooling: 8-bit RGBA in and out, nothing
 * else. Both `build-icons.mjs` and the icon contract test read the shipped
 * files through this, so what the test measures is what the build wrote.
 *
 * Decoding accepts only 8-bit, non-interlaced, truecolour+alpha files
 * (colour type 6) — what the build emits and what the art master is — and
 * throws on anything else rather than measuring it wrong. Encoding writes
 * filter 0 scanlines under maximum deflate; the output is byte-for-byte
 * deterministic, which is what lets the test compare a fresh build against
 * the committed files.
 */

import { crc32, deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4;

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
 * Decode an 8-bit RGBA PNG. Returns `{ width, height, data }`, `data` a
 * `Uint8Array` of straight (non-premultiplied) RGBA in row-major order.
 */
export function decodePng(buffer) {
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

/** The alpha plane of a decoded image, one byte per pixel. */
export function alphaOf({ width, height, data }) {
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * BYTES_PER_PIXEL + 3];
  return alpha;
}

function chunk(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload, crc32(Buffer.from(type, 'latin1'))), 0);
  return Buffer.concat([header, payload, crc]);
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
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 for every scanline
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

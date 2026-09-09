/**
 * Icon build: every shipped icon, from the one art master.
 *
 * `src-tauri/icons/icon-source.png` is a full-bleed 1024x1024 rounded tile.
 * `tauri icon` would resize it and nothing more, and that shows at every
 * size users actually meet:
 *   - the colour under the transparent corners is dark navy, so a straight
 *     (non-premultiplied) resample drags it into the corner anti-aliasing —
 *     a dark fringe on light desktops;
 *   - 16–32px (Windows taskbar, Linux tray, Finder list view) turns the
 *     tornado's thin strokes into blue mush without a sharpening pass;
 *   - macOS lays icons out on Apple's grid — an 824x824 body on a 1024
 *     canvas, with a soft shadow — so a full-bleed tile renders oversized
 *     and looks cut off in the Dock.
 * On top of that the art itself is a dark tile that sinks into dark docks
 * and taskbars; a touch more saturation and contrast and a faint light rim
 * give it an edge to stand on. All of it is done here, in one place,
 * deterministically: the same source always produces the same bytes, which
 * is what lets the contract test regenerate and compare.
 *
 * Outputs (relative to the repo root):
 *   src-tauri/icons/{32x32,64x64,128x128,128x128@2x,icon}.png   Linux, Tauri
 *   src-tauri/icons/Square*Logo.png, StoreLogo.png               Windows tiles
 *   src-tauri/icons/icon.ico                                     Windows
 *   src-tauri/icons/icon.icns                                    macOS
 *   site/assets/{favicon-64,icon-256,icon-512}.png               website
 * The Android and iOS sets are left to `tauri icon`; Gitnado ships no mobile
 * build and those hosts composite their own shape.
 *
 * Run `node scripts/build-icons.mjs` after changing the master or any
 * parameter below; `npm run test:contract` then checks the committed files
 * are exactly what this script produces.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, decodePng, encodePng } from './png.mjs';
export const ICONS_DIR = 'src-tauri/icons';
export const SITE_ASSETS_DIR = 'site/assets';
export const SOURCE = `${ICONS_DIR}/icon-source.png`;

/** Apple's icon grid: an 824x824 body centred on a 1024x1024 canvas. */
export const APPLE_CANVAS = 1024;
export const APPLE_BODY = 824;
export const APPLE_MARGIN = (APPLE_CANVAS - APPLE_BODY) / 2;

/**
 * Apple's margin at `size`, as the build lays it out: a whole number of
 * pixels, identical on all four sides, rounding down so the body never
 * exceeds Apple's proportion. The contract test asserts against this.
 */
export const macMargin = (size) => Math.floor((size * APPLE_MARGIN) / APPLE_CANVAS);

/**
 * Apple's icon template shadow, at 1024: black at 30%, offset 12px down,
 * Gaussian blur of sigma 12 (about 24px of spread). It stays well inside
 * the 100px margin and is scaled with the canvas for the smaller entries.
 */
export const SHADOW = { opacity: 0.3, offsetY: 12, sigma: 12 };

/**
 * The "pop" pass, applied once to the master before any resizing.
 *   saturation  — chroma multiplier about each pixel's luma;
 *   contrast    — slope about mid-grey, so the navy ground darkens a touch
 *                 and the cyan strokes lift;
 *   rim         — a light line inside the tile's edge, in the tornado's
 *                 own cyan, so the tile has an outline against dark docks
 *                 and taskbars. `width` is the sigma in px at 1024,
 *                 `strength` the peak blend.
 */
export const ENHANCE = {
  saturation: 1.12,
  contrast: 1.06,
  rim: { colour: [150, 225, 255], width: 5, strength: 0.28 },
};

/** Sizes at or below this get an unsharp mask after the resample. */
export const SHARPEN_UP_TO = 64;
export const SHARPEN = { sigma: 0.7, amount: 0.55 };

/** Full-bleed PNGs: `path` → edge length. */
export const FULL_BLEED_PNGS = {
  [`${ICONS_DIR}/32x32.png`]: 32,
  [`${ICONS_DIR}/64x64.png`]: 64,
  [`${ICONS_DIR}/128x128.png`]: 128,
  [`${ICONS_DIR}/128x128@2x.png`]: 256,
  [`${ICONS_DIR}/icon.png`]: 512,
  [`${ICONS_DIR}/Square30x30Logo.png`]: 30,
  [`${ICONS_DIR}/Square44x44Logo.png`]: 44,
  [`${ICONS_DIR}/Square71x71Logo.png`]: 71,
  [`${ICONS_DIR}/Square89x89Logo.png`]: 89,
  [`${ICONS_DIR}/Square107x107Logo.png`]: 107,
  [`${ICONS_DIR}/Square142x142Logo.png`]: 142,
  [`${ICONS_DIR}/Square150x150Logo.png`]: 150,
  [`${ICONS_DIR}/Square284x284Logo.png`]: 284,
  [`${ICONS_DIR}/Square310x310Logo.png`]: 310,
  [`${ICONS_DIR}/StoreLogo.png`]: 50,
  [`${SITE_ASSETS_DIR}/favicon-64.png`]: 64,
  [`${SITE_ASSETS_DIR}/icon-256.png`]: 256,
  [`${SITE_ASSETS_DIR}/icon-512.png`]: 512,
};

/**
 * Windows picks the ICO entry nearest the size it needs and scales the rest;
 * these are the sizes the shell, Explorer and the taskbar ask for at 100%,
 * 125%, 150% and 200%, plus the 256 that everything else is scaled from.
 * ORDER MATTERS: Tauri's codegen embeds entry 0 as the Windows window and
 * tray icon (`default_window_icon`), so 32 goes first, as `tauri icon`
 * also puts it.
 */
export const ICO_SIZES = [32, 16, 20, 24, 40, 48, 64, 256];

/**
 * ICNS entries. PNG-payload types by edge length, then the legacy 24-bit
 * RLE + 8-bit mask pairs macOS still reads for 16pt and 32pt at 1x in
 * bundled apps (the same set `tauri icon` writes).
 */
export const ICNS_PNG_TYPES = {
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512,
};
export const ICNS_LEGACY_TYPES = {
  is32: { mask: 's8mk', size: 16 },
  il32: { mask: 'l8mk', size: 32 },
};

export const ICO_PATH = `${ICONS_DIR}/icon.ico`;
export const ICNS_PATH = `${ICONS_DIR}/icon.icns`;

// ---------------------------------------------------------------------------
// Pixel helpers. Images are `{ width, height, data: Float32Array }` of
// PREMULTIPLIED RGBA in 0..1 while in flight — every filter below assumes
// that — and are converted back to straight 8-bit only at the edges.
// ---------------------------------------------------------------------------

function toPremultiplied({ width, height, data }) {
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = (data[i] / 255) * a;
    out[i + 1] = (data[i + 1] / 255) * a;
    out[i + 2] = (data[i + 2] / 255) * a;
    out[i + 3] = a;
  }
  return { width, height, data: out };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toStraight8({ width, height, data }) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = clamp01(data[i + 3]);
    const a8 = Math.round(a * 255);
    // A pixel that rounds to transparent carries no colour: resampling
    // ringing divided by a near-zero alpha would otherwise leave noise there.
    if (a8 === 0) continue;
    const inv = 1 / a;
    out[i] = Math.round(clamp01(data[i] * inv) * 255);
    out[i + 1] = Math.round(clamp01(data[i + 1] * inv) * 255);
    out[i + 2] = Math.round(clamp01(data[i + 2] * inv) * 255);
    out[i + 3] = a8;
  }
  return { width, height, data: out };
}

/** Lanczos-3 kernel. */
function lanczos(x) {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** Resample one axis of a premultiplied float image with Lanczos-3. */
function resampleAxis(src, dstLength, horizontal) {
  const { width, height, data } = src;
  const srcLength = horizontal ? width : height;
  const scale = dstLength / srcLength;
  const support = scale < 1 ? 3 / scale : 3;
  const dstWidth = horizontal ? dstLength : width;
  const dstHeight = horizontal ? height : dstLength;
  const out = new Float32Array(dstWidth * dstHeight * 4);

  // Weights per destination index, computed once.
  const taps = [];
  for (let d = 0; d < dstLength; d += 1) {
    const centre = (d + 0.5) / scale - 0.5;
    const lo = Math.max(0, Math.floor(centre - support));
    const hi = Math.min(srcLength - 1, Math.ceil(centre + support));
    const weights = [];
    let sum = 0;
    for (let s = lo; s <= hi; s += 1) {
      const w = lanczos((s - centre) * (scale < 1 ? scale : 1));
      weights.push(w);
      sum += w;
    }
    taps.push({ lo, weights: weights.map((w) => w / sum) });
  }

  const lines = horizontal ? height : width;
  for (let line = 0; line < lines; line += 1) {
    for (let d = 0; d < dstLength; d += 1) {
      const { lo, weights } = taps[d];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const s = lo + k;
        const idx = horizontal ? (line * width + s) * 4 : (s * width + line) * 4;
        const w = weights[k];
        r += data[idx] * w;
        g += data[idx + 1] * w;
        b += data[idx + 2] * w;
        a += data[idx + 3] * w;
      }
      const o = horizontal ? (line * dstWidth + d) * 4 : (d * dstWidth + line) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { width: dstWidth, height: dstHeight, data: out };
}

/** Lanczos-3 resize of a premultiplied float image to `size` x `size`. */
export function resize(image, size) {
  if (image.width === size && image.height === size) return image;
  return resampleAxis(resampleAxis(image, size, true), size, false);
}

function gaussianKernel(sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  return { radius, kernel };
}

/**
 * Separable Gaussian blur of one plane (`width * height` floats), edges
 * clamped. The plane is what the rim mask and the shadow need; blurring
 * four channels to read one back would be most of the build's cost.
 */
function blurPlane(plane, width, height, sigma) {
  if (sigma <= 0) return plane;
  const { radius, kernel } = gaussianKernel(sigma);
  // One pass along an axis of `length` samples spaced `step` apart in the
  // plane, starting at `base`. Only the `radius` samples at either end need
  // their taps clamped; the interior runs unchecked.
  const pass = (src, out, base, step, length) => {
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      if (i >= radius && i + radius < length) {
        for (let k = -radius; k <= radius; k += 1) sum += src[base + (i + k) * step] * kernel[k + radius];
      } else {
        for (let k = -radius; k <= radius; k += 1) {
          const j = Math.min(length - 1, Math.max(0, i + k));
          sum += src[base + j * step] * kernel[k + radius];
        }
      }
      out[base + i * step] = sum;
    }
  };
  const horizontal = new Float32Array(plane.length);
  for (let y = 0; y < height; y += 1) pass(plane, horizontal, y * width, 1, width);
  const vertical = new Float32Array(plane.length);
  for (let x = 0; x < width; x += 1) pass(horizontal, vertical, x, width, height);
  return vertical;
}

/** One channel of a premultiplied image as its own plane. */
function plane(image, channel) {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i += 1) out[i] = image.data[i * 4 + channel];
  return out;
}

/** Separable Gaussian blur, all four premultiplied channels. */
function gaussianBlur(image, sigma) {
  if (sigma <= 0) return image;
  const { width, height } = image;
  const planes = [0, 1, 2, 3].map((c) => blurPlane(plane(image, c), width, height, sigma));
  const data = new Float32Array(image.data.length);
  for (let i = 0; i < width * height; i += 1) {
    for (let c = 0; c < 4; c += 1) data[i * 4 + c] = planes[c][i];
  }
  return { width, height, data };
}

/** Unsharp mask: image + amount * (image - blur(image)), alpha included. */
export function sharpen(image, { sigma, amount }) {
  const blurred = gaussianBlur(image, sigma);
  const out = new Float32Array(image.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = image.data[i + 3] + amount * (image.data[i + 3] - blurred.data[i + 3]);
    const alpha = clamp01(a);
    for (let c = 0; c < 3; c += 1) {
      const v = image.data[i + c] + amount * (image.data[i + c] - blurred.data[i + c]);
      out[i + c] = Math.min(alpha, Math.max(0, v)); // keep premultiplied invariant
    }
    out[i + 3] = alpha;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * The pop pass on the premultiplied master: saturation and contrast on the
 * straight colour, then the rim light blended in along the inside of the
 * tile edge. The rim mask is `alpha * (1 - blur(alpha))`: zero deep inside
 * the tile and outside it, peaking just inside the edge.
 */
export function enhance(image, { saturation, contrast, rim }) {
  const { width, height, data } = image;
  const out = new Float32Array(data.length);
  const blurredAlpha = blurPlane(plane(image, 3), width, height, rim.width);
  const [rr, rg, rb] = rim.colour.map((v) => v / 255);

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a <= 0) {
      out[i + 3] = 0;
      continue;
    }
    // Work in straight colour for the tone adjustments.
    let r = data[i] / a;
    let g = data[i + 1] / a;
    let b = data[i + 2] / a;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * saturation;
    g = luma + (g - luma) * saturation;
    b = luma + (b - luma) * saturation;
    r = 0.5 + (r - 0.5) * contrast;
    g = 0.5 + (g - 0.5) * contrast;
    b = 0.5 + (b - 0.5) * contrast;

    const edge = a * (1 - blurredAlpha[i >> 2]);
    const t = clamp01(edge / 0.5) * rim.strength; // edge peaks near 0.5 for a 1px-soft edge
    r = r + (rr - r) * t;
    g = g + (rg - g) * t;
    b = b + (rb - b) * t;

    out[i] = clamp01(r) * a;
    out[i + 1] = clamp01(g) * a;
    out[i + 2] = clamp01(b) * a;
    out[i + 3] = a;
  }
  return { width, height, data: out };
}

/** A transparent premultiplied canvas. */
function blank(size) {
  return { width: size, height: size, data: new Float32Array(size * size * 4) };
}

/** Source-over composite of `layer` onto `base` at (x, y), premultiplied. */
function composite(base, layer, x0, y0) {
  const out = { width: base.width, height: base.height, data: Float32Array.from(base.data) };
  for (let y = 0; y < layer.height; y += 1) {
    const by = y + y0;
    if (by < 0 || by >= base.height) continue;
    for (let x = 0; x < layer.width; x += 1) {
      const bx = x + x0;
      if (bx < 0 || bx >= base.width) continue;
      const li = (y * layer.width + x) * 4;
      const bi = (by * base.width + bx) * 4;
      const la = layer.data[li + 3];
      for (let c = 0; c < 4; c += 1) {
        out.data[bi + c] = layer.data[li + c] + out.data[bi + c] * (1 - la);
      }
    }
  }
  return out;
}

/**
 * The macOS entry at `size`: body scaled to Apple's proportion, its shadow
 * beneath, centred on a transparent canvas with `macMargin(size)` on every
 * side.
 */
export function macCanvas(body1024, size) {
  const margin = macMargin(size);
  const bodySize = size - 2 * margin;
  let body = resize(body1024, bodySize);
  if (size <= SHARPEN_UP_TO) body = sharpen(body, SHARPEN);

  // The shadow is the body's alpha, black at SHADOW.opacity, laid on a
  // canvas-sized plane BEFORE blurring so the blur can spread past the
  // body's edges into the margin — a body-sized layer would clamp it to a
  // hard band.
  const scale = size / APPLE_CANVAS;
  const shadowPlane = new Float32Array(size * size);
  const shadowTop = margin + Math.round(SHADOW.offsetY * scale);
  for (let y = 0; y < bodySize; y += 1) {
    for (let x = 0; x < bodySize; x += 1) {
      shadowPlane[(y + shadowTop) * size + x + margin] = body.data[(y * bodySize + x) * 4 + 3] * SHADOW.opacity;
    }
  }
  const blurred = blurPlane(shadowPlane, size, size, SHADOW.sigma * scale);
  const canvas = blank(size);
  for (let i = 0; i < blurred.length; i += 1) canvas.data[i * 4 + 3] = blurred[i]; // black, premultiplied
  return composite(canvas, body, margin, margin);
}

/** A full-bleed entry at `size`, sharpened when small. */
export function fullBleed(master, size) {
  const image = resize(master, size);
  return size <= SHARPEN_UP_TO ? sharpen(image, SHARPEN) : image;
}

// ---------------------------------------------------------------------------
// Containers.
// ---------------------------------------------------------------------------

/** ICO with PNG-compressed entries (Vista+). `entries` is `[{ size, png }]`. */
export function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = [];
  const payloads = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // colour palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    payloads.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...directory, ...payloads]);
}

/**
 * ICNS PackBits-style RLE for the legacy 24-bit entries: runs of 3–130 equal
 * bytes as `0x80 + (n - 3), byte`; literals of 1–128 as `n - 1, bytes…`.
 */
export function icnsRle(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === bytes[i] && run < 130) run += 1;
    if (run >= 3) {
      out.push(0x80 + (run - 3), bytes[i]);
      i += run;
      continue;
    }
    let literal = 0;
    while (i + literal < bytes.length && literal < 128) {
      const j = i + literal;
      // Stop before a run of 3 begins.
      if (j + 2 < bytes.length && bytes[j] === bytes[j + 1] && bytes[j] === bytes[j + 2]) break;
      literal += 1;
    }
    out.push(literal - 1, ...bytes.subarray(i, i + literal));
    i += literal;
  }
  return Buffer.from(out);
}

function icnsEntry(type, payload) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'latin1');
  header.writeUInt32BE(8 + payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * ICNS container. `pngEntries` is `[{ type, png }]`; `legacy` is
 * `[{ type, mask, image }]` with `image` a straight 8-bit `{ width, height, data }`.
 */
export function encodeIcns(pngEntries, legacy) {
  const parts = [];
  for (const { type, png } of pngEntries) parts.push(icnsEntry(type, png));
  for (const { type, mask, image } of legacy) {
    const n = image.width * image.height;
    const channel = (c) => {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) bytes[i] = image.data[i * 4 + c];
      return icnsRle(bytes);
    };
    parts.push(icnsEntry(type, Buffer.concat([channel(0), channel(1), channel(2)])));
    const alpha = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) alpha[i] = image.data[i * 4 + 3];
    parts.push(icnsEntry(mask, alpha));
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// The build.
// ---------------------------------------------------------------------------

/** Memoise a one-argument function by its argument. */
function memo(f) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, f(key));
    return cache.get(key);
  };
}

/**
 * Build every output from the master PNG bytes. Returns a Map of repo-
 * relative path → file bytes; nothing is written.
 */
export function buildIcons(sourcePng) {
  const source = decodePng(sourcePng);
  if (source.width !== APPLE_CANVAS || source.height !== APPLE_CANVAS) {
    throw new Error(`master must be ${APPLE_CANVAS}x${APPLE_CANVAS}, got ${source.width}x${source.height}`);
  }
  const master = enhance(toPremultiplied(source), ENHANCE);
  const files = new Map();
  const fullBleedPng = memo((size) => encodePng(toStraight8(fullBleed(master, size))));

  for (const [path, size] of Object.entries(FULL_BLEED_PNGS)) files.set(path, fullBleedPng(size));

  files.set(
    ICO_PATH,
    encodeIco(ICO_SIZES.map((size) => ({ size, png: fullBleedPng(size) }))),
  );

  const macFor = memo((size) => toStraight8(macCanvas(master, size)));
  const macPngFor = memo((size) => encodePng(macFor(size)));
  const pngEntries = Object.entries(ICNS_PNG_TYPES).map(([type, size]) => ({ type, png: macPngFor(size) }));
  const legacy = Object.entries(ICNS_LEGACY_TYPES).map(([type, { mask, size }]) => ({
    type,
    mask,
    image: macFor(size),
  }));
  files.set(ICNS_PATH, encodeIcns(pngEntries, legacy));

  return files;
}

/** Write a build to disk under `root`. */
export function writeIcons(files, root = REPO_ROOT) {
  for (const [path, bytes] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = buildIcons(readFileSync(join(REPO_ROOT, SOURCE)));
  writeIcons(files);
  for (const [path, bytes] of files) console.log(`${path}  ${bytes.length} bytes`);
}

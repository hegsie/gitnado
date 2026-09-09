/**
 * Icon contract test.
 *
 * Two failures this exists to catch:
 *   - the committed icons drifting from what `build-icons.mjs` produces —
 *     someone edits the master or a parameter and forgets to rebuild, or
 *     runs `tauri icon` and overwrites the built files with plain resizes
 *     (no safe area, no sharpening, no shadow);
 *   - the macOS entries losing Apple's 824/1024 safe area, which is the
 *     "icon is cut off in the Dock" bug — or the reverse, a padded tile
 *     leaking into the Windows/Linux/web files that must stay full-bleed.
 * The build is rerun here and compared to the files on disk pixel by pixel
 * (a tolerance of one level per channel absorbs libm differences between
 * platforms), then each file is measured on its own terms.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

import {
  APPLE_CANVAS,
  BORDER_DEPTH,
  ENHANCE,
  FULL_BLEED_PNGS,
  ICNS_LEGACY_TYPES,
  ICNS_PATH,
  ICNS_PNG_TYPES,
  ICO_PATH,
  ICO_SIZES,
  SHARPEN,
  SOURCE,
  buildIcons,
  enhance,
  renderIcons,
  encodeIco,
  encodeIcns,
  icnsRle,
  macMargin,
  sharpen,
  stripBorder,
} from './build-icons.mjs';
import {
  BODY_ALPHA_THRESHOLD,
  maskAlpha,
  measureMargins,
  pngAlpha,
  readIcnsEntries,
  readIcoEntries,
} from './icon-safe-area.mjs';
import { REPO_ROOT, alphaOf, channelOf, crc32, decodePng, encodePng } from './png.mjs';

/** Read a repo file, failing with the build hint rather than a bare ENOENT when it is missing. */
function readRepoFile(path) {
  const file = join(REPO_ROOT, path);
  assert.ok(existsSync(file), `${path} is missing — run node scripts/build-icons.mjs`);
  return readFileSync(file);
}
let sourcePng;
const SOURCE_PNG = () => (sourcePng ??= readRepoFile(SOURCE));

/**
 * The fresh render and the committed files, made once, on first use — so a
 * single selected test does not pay for it. Rendering stops at pixels: the
 * container encoding is exercised by its own tests below, and comparing
 * pixels is what the contract is about.
 */
let cache;
function built() {
  if (!cache) {
    const RENDERED = renderIcons(SOURCE_PNG());
    const paths = [...RENDERED.pngs.keys(), ICO_PATH, ICNS_PATH];
    const COMMITTED = new Map(paths.map((path) => [path, readRepoFile(path)]));
    cache = { RENDERED, COMMITTED };
  }
  return cache;
}

const legacySize = (type) => Object.values(ICNS_LEGACY_TYPES).find((t) => t.mask === type)?.size;

/** Decode the ICNS PackBits variant `icnsRle` writes. */
function icnsRleDecode(buffer) {
  const out = [];
  let i = 0;
  while (i < buffer.length) {
    const head = buffer[i++];
    if (head >= 0x80) {
      for (let k = 0; k < head - 0x80 + 3; k += 1) out.push(buffer[i]);
      i += 1;
    } else {
      for (let k = 0; k <= head; k += 1) out.push(buffer[i++]);
    }
  }
  return Uint8Array.from(out);
}

/** Largest per-channel difference between two equally sized byte arrays. */
function maxDifference(a, b) {
  assert.equal(a.length, b.length, 'pixel buffers differ in length');
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

const REBUILD = 'differs from a fresh build — run node scripts/build-icons.mjs';

/** A committed PNG against a freshly rendered straight-8 image. */
function assertSamePixels(committedPng, image, label) {
  const c = decodePng(committedPng);
  assert.equal(c.width, image.width, `${label}: width`);
  assert.equal(c.height, image.height, `${label}: height`);
  assert.ok(maxDifference(c.data, image.data) <= 1, `${label}: pixels ${REBUILD}`);
}

test('every committed icon is what build-icons.mjs produces from the master', () => {
  const { RENDERED, COMMITTED } = built();
  for (const [path, image] of RENDERED.pngs) assertSamePixels(COMMITTED.get(path), image, path);

  const ico = readIcoEntries(COMMITTED.get(ICO_PATH));
  assert.deepEqual(
    ico.map((e) => e.size),
    RENDERED.ico.map((e) => e.size),
    `${ICO_PATH}: entry sizes ${REBUILD}`,
  );
  ico.forEach((entry, i) => assertSamePixels(entry.payload, RENDERED.ico[i].image, `${ICO_PATH} ${entry.size}px`));

  const icns = readIcnsEntries(COMMITTED.get(ICNS_PATH));
  const fresh = new Map([
    ...RENDERED.icns.png.map(({ type, image }) => [type, { image }]),
    ...RENDERED.icns.legacy.flatMap(({ type, mask, image }) => [
      [type, { rgb: Buffer.concat([0, 1, 2].map((c) => channelOf(image, c))) }],
      [mask, { alpha: channelOf(image, 3) }],
    ]),
  ]);
  assert.deepEqual(
    icns.map((e) => e.type),
    [...fresh.keys()],
    `${ICNS_PATH}: entry types ${REBUILD}`,
  );
  for (const { type, payload } of icns) {
    const expected = fresh.get(type);
    const label = `${ICNS_PATH} ${type}`;
    if (expected.image) assertSamePixels(payload, expected.image, label);
    else if (expected.rgb) assert.ok(maxDifference(icnsRleDecode(payload), expected.rgb) <= 1, `${label}: RGB ${REBUILD}`);
    else assert.ok(maxDifference(payload, expected.alpha) <= 1, `${label}: mask ${REBUILD}`);
  }
});

test('icon.icns carries the entry set the build writes, PNG and legacy', () => {
  const types = readIcnsEntries(built().COMMITTED.get(ICNS_PATH)).map((e) => e.type);
  const expected = [
    ...Object.keys(ICNS_PNG_TYPES),
    ...Object.entries(ICNS_LEGACY_TYPES).flatMap(([type, { mask }]) => [type, mask]),
  ];
  assert.deepEqual([...types].sort(), [...expected].sort());
});

test('every icon.icns entry sits on Apple’s grid, shadow inside the canvas', () => {
  for (const { type, payload } of readIcnsEntries(built().COMMITTED.get(ICNS_PATH))) {
    let image;
    if (type in ICNS_PNG_TYPES) image = pngAlpha(payload);
    else if (legacySize(type)) image = maskAlpha(payload, legacySize(type));
    else continue; // is32/il32 carry colour only; their masks are measured

    const { width, height, alpha } = image;
    assert.equal(width, height, `${type} is not square`);
    if (type in ICNS_PNG_TYPES) assert.equal(width, ICNS_PNG_TYPES[type], `${type} is the wrong size`);

    const m = macMargin(width);
    assert.deepEqual(
      measureMargins(image),
      { left: m, top: m, right: m, bottom: m },
      `${type} (${width}px) is off Apple's grid; the body must leave ${m}px on every side`,
    );

    // The shadow: visible just below the body from 64px up, SOFT — still
    // there but fainter a few percent of the canvas further down, which a
    // hard band would fail — and never reaching the canvas edge at any size.
    if (type in ICNS_PNG_TYPES && width >= 64) {
      const cx = width >> 1;
      const below = alpha[(height - m) * width + cx];
      assert.ok(below > 0 && below <= BODY_ALPHA_THRESHOLD, `${type}: no shadow under the body (alpha ${below})`);
      if (width >= 128) {
        const further = alpha[(height - m + Math.round(width * 0.03)) * width + cx];
        assert.ok(further > 0 && further < below, `${type}: shadow is not soft (alpha ${below} then ${further})`);
      }
    }
    for (let i = 0; i < width; i += 1) {
      assert.equal(alpha[i], 0, `${type}: top edge is not clear`);
      assert.equal(alpha[(height - 1) * width + i], 0, `${type}: bottom edge is not clear`);
      assert.equal(alpha[i * width], 0, `${type}: left edge is not clear`);
      assert.equal(alpha[i * width + width - 1], 0, `${type}: right edge is not clear`);
    }
  }
});

test('the Windows, Linux and website PNGs stay full-bleed at their declared size', () => {
  const { COMMITTED } = built();
  for (const [path, size] of Object.entries(FULL_BLEED_PNGS)) {
    const image = pngAlpha(COMMITTED.get(path));
    assert.equal(image.width, size, `${path}: width`);
    assert.equal(image.height, size, `${path}: height`);
    assert.deepEqual(measureMargins(image, 0), { left: 0, top: 0, right: 0, bottom: 0 }, `${path} gained a margin`);
  }
});

test('transparent pixels carry no colour, in every built PNG', () => {
  const check = ({ data }, label) => {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) {
        assert.ok(data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0, `${label}: transparent pixel ${i / 4} has colour`);
      }
    }
  };
  const { RENDERED } = built();
  for (const [path, image] of RENDERED.pngs) check(image, path);
  for (const { size, image } of RENDERED.ico) check(image, `${ICO_PATH} ${size}px`);
  for (const { type, image } of RENDERED.icns.png) check(image, `${ICNS_PATH} ${type}`);
});

test('icon.ico carries every size Windows asks for, 32 first, each full-bleed', () => {
  const entries = readIcoEntries(built().COMMITTED.get(ICO_PATH));
  assert.deepEqual(
    entries.map((e) => e.size),
    ICO_SIZES,
  );
  assert.equal(entries[0].size, 32, 'entry 0 is what Tauri embeds as the Windows window and tray icon');
  for (const { size, payload } of entries) {
    const image = pngAlpha(payload);
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    assert.deepEqual(measureMargins(image, 0), { left: 0, top: 0, right: 0, bottom: 0 }, `${size}px entry gained a margin`);
  }
});

test('the master is 1024x1024 and the build refuses any other size', () => {
  const master = decodePng(SOURCE_PNG());
  assert.equal(master.width, APPLE_CANVAS);
  assert.equal(master.height, APPLE_CANVAS);
  const small = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });
  assert.throws(() => buildIcons(small), /master must be 1024x1024/);
});

// --- the pop pass -----------------------------------------------------------

/** A 4x4 premultiplied float image: opaque mid-blue with one transparent corner. */
function sample() {
  const data = new Float32Array(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) data.set([0.2, 0.4, 0.8, 1], i * 4);
  data.set([0, 0, 0, 0], 0); // transparent top-left pixel
  return { width: 4, height: 4, data };
}

test('enhance raises chroma and keeps alpha', () => {
  const before = sample();
  const after = enhance(before, ENHANCE);
  assert.equal(after.data[3], 0, 'transparent pixel stays transparent');
  for (let i = 0; i < 16; i += 1) assert.equal(after.data[i * 4 + 3], before.data[i * 4 + 3], 'alpha is untouched');

  const chroma = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
  const centre = (2 * 4 + 2) * 4;
  assert.ok(chroma(after.data, centre) > chroma(before.data, centre), 'centre pixel is more saturated');
  for (let i = 0; i < after.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) assert.ok(after.data[i + c] <= after.data[i + 3] + 1e-6, 'premultiplied invariant');
  }
});

/** A 64px rounded tile (radius 16): flat navy inside, a bright 4px band at the edge, corners cut. */
function borderedTile() {
  const size = 64;
  const r = 16;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const qx = Math.max(Math.abs(x + 0.5 - 32) - (32 - r), 0);
      const qy = Math.max(Math.abs(y + 0.5 - 32) - (32 - r), 0);
      const inside = r - Math.hypot(qx, qy); // >0 inside the rounded square
      if (inside <= 0) continue;
      const band = inside < 4;
      data.set(band ? [120, 230, 255, 255] : [10, 30, 60, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

test('stripBorder paints the edge band over with the interior and leaves alpha alone', () => {
  const tile = borderedTile();
  const out = stripBorder(tile, 6);
  assert.equal(out.width, 64);
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i + 3], tile.data[i + 3], 'alpha is untouched');
    if (tile.data[i + 3] === 0) {
      assert.deepEqual([...out.data.subarray(i, i + 4)], [0, 0, 0, 0], 'transparent pixels are untouched');
    } else {
      assert.deepEqual([...out.data.subarray(i, i + 3)], [10, 30, 60], `pixel ${i / 4} still carries the band`);
    }
  }
  assert.throws(() => stripBorder({ width: 2, height: 3, data: new Uint8Array(24) }, 1), /square/);
  assert.throws(() => stripBorder({ width: 2, height: 2, data: new Uint8Array(16) }, 1), /no opaque pixel/);
});

test('the built icons end in their own ground — no outline band on any edge or corner', () => {
  const { RENDERED } = built();
  // Walk inward from the tile's edge along eight rays — the four edge
  // midpoints and the four corner diagonals — over the band's depth, and
  // require each pixel to match the ground a little further in along the
  // same ray. Relative, so it holds on the bright top edge and the dark
  // bottom one alike; a leftover cyan arc in a corner fails the diagonals.
  // The master's band is ~14px deep at 1024 — measured from the art, not
  // taken from BORDER_DEPTH, so a build that strips too little (or nothing)
  // is caught rather than matched.
  const MASTER_BAND = 14;
  assert.ok(BORDER_DEPTH >= MASTER_BAND, 'BORDER_DEPTH must cover the master band');
  const check = ({ width, data }, label) => {
    const depth = Math.max(1, Math.round((MASTER_BAND * width) / APPLE_CANVAS));
    const alphaAt = (x, y) => data[(y * width + x) * 4 + 3];
    const rgbAt = (x, y) => [0, 1, 2].map((c) => data[(y * width + x) * 4 + c]);
    const mid = width >> 1;
    const rays = [
      [0, mid, 1, 0], [width - 1, mid, -1, 0], [mid, 0, 0, 1], [mid, width - 1, 0, -1], // edge midpoints
      [0, 0, 1, 1], [width - 1, 0, -1, 1], [0, width - 1, 1, -1], [width - 1, width - 1, -1, -1], // corner diagonals
    ];
    for (const [sx, sy, dx, dy] of rays) {
      let x = sx;
      let y = sy;
      while (alphaAt(x, y) <= 128) { x += dx; y += dy; } // find the tile's edge along the ray
      const reference = rgbAt(x + dx * (depth + 3), y + dy * (depth + 3));
      for (let k = 0; k < depth; k += 1) {
        const px = rgbAt(x + dx * k, y + dy * k);
        const off = Math.max(...px.map((v, c) => Math.abs(v - reference[c])));
        assert.ok(off <= 16, `${label}: ray from (${sx},${sy}) still carries a band ${k}px in: (${px}) vs ground (${reference})`);
      }
    }
  };
  check(RENDERED.pngs.get(`${'src-tauri/icons'}/icon.png`), 'icon.png');
  for (const { type, image } of RENDERED.icns.png) if (image.width >= 256) check(image, type);
});

test('sharpen increases local contrast and keeps the premultiplied invariant', () => {
  const image = sample();
  // A single bright pixel in the middle.
  image.data.set([0.9, 0.9, 0.9, 1], (1 * 4 + 1) * 4);
  const out = sharpen(image, SHARPEN);
  const at = (img, x, y) => img.data[(y * 4 + x) * 4];
  assert.ok(at(out, 1, 1) > at(image, 1, 1), 'the bright pixel gets brighter');
  assert.ok(at(out, 1, 2) < at(image, 1, 2), 'its neighbour gets darker');
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) assert.ok(out.data[i + c] <= out.data[i + 3] + 1e-6, 'premultiplied invariant');
    assert.ok(out.data[i + 3] >= 0 && out.data[i + 3] <= 1, 'alpha stays in range');
  }
});

// --- the PNG codec ------------------------------------------------------------

function pngFromRaw(width, height, raw, { colourType = 6, withIdat = true } = {}) {
  const chunk = (type, payload) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload, Buffer.alloc(4)]); // CRC is not checked by the reader
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(withIdat ? [chunk('IDAT', deflateSync(raw))] : []),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('crc32 matches the IEEE reference values', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082, 'the CRC every PNG ends with');
  assert.equal(crc32(Buffer.from('56789'), crc32(Buffer.from('1234'))), 0xcbf43926, 'seeded continuation');
});

test('the PNG codec round-trips and decodes every scanline filter', () => {
  const image = { width: 3, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37) & 0xff) };
  const back = decodePng(encodePng(image));
  assert.deepEqual([back.width, back.height], [3, 2]);
  assert.deepEqual(back.data, image.data);

  // The encoder chooses a filter per row: a flat image and a gradient must
  // both survive, and a gradient row is cheaper filtered than raw.
  const flat = { width: 8, height: 4, data: new Uint8Array(128).fill(200) };
  assert.deepEqual(decodePng(encodePng(flat)).data, flat.data);
  const gradient = { width: 64, height: 64, data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => ((i >> 2) * 3) & 0xff) };
  assert.deepEqual(decodePng(encodePng(gradient)).data, gradient.data);
  const encoded = encodePng(gradient);
  assert.ok(encoded.length < gradient.data.length / 4, `filtered gradient should compress well, got ${encoded.length} bytes`);
  assert.deepEqual(alphaOf(back), Uint8Array.from([image.data[3], image.data[7], image.data[11], image.data[15], image.data[19], image.data[23]]));

  // One row per filter type, each encoding the same known pixels.
  const rows = [
    [0, 10, 20, 30, 40, 50, 60, 70, 80], // None
    [1, 10, 20, 30, 40, 40, 40, 40, 40], // Sub: 10,20,30,40 then +40 each -> 50,60,70,80
    [2, 0, 0, 0, 0, 0, 0, 0, 0], // Up: copies previous row
    [3, 10, 20, 30, 40, 25, 30, 35, 40], // Average of left and up
    [4, 10, 20, 30, 40, 0, 0, 0, 0], // Paeth
  ];
  const raw = Buffer.from(rows.flat());
  const decoded = decodePng(pngFromRaw(2, 5, raw));
  const row = (y) => Array.from(decoded.data.subarray(y * 8, y * 8 + 8));
  assert.deepEqual(row(0), [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.deepEqual(row(1), [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.deepEqual(row(2), [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.deepEqual(row(3), [15, 30, 45, 60, 57, 75, 92, 110]);
  assert.deepEqual(row(4), [25, 50, 75, 100, 57, 75, 92, 110]);
});

test('the PNG codec rejects what it cannot handle', () => {
  assert.throws(() => decodePng(Buffer.alloc(4)), /not a PNG/);
  assert.throws(() => decodePng(Buffer.alloc(64)), /not a PNG/);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => decodePng(signature), /no IHDR/);
  assert.throws(() => decodePng(Buffer.concat([signature, Buffer.alloc(40)])), /no IHDR/);
  assert.throws(() => decodePng(pngFromRaw(1, 1, Buffer.from([0, 1, 2, 3, 4]), { colourType: 2 })), /unsupported PNG/);
  assert.throws(() => decodePng(pngFromRaw(1, 1, Buffer.alloc(0), { withIdat: false })), /no IDAT/);
  assert.throws(() => decodePng(pngFromRaw(2, 2, Buffer.from([0, 1, 2, 3, 4]))), /truncated/);
  assert.throws(() => decodePng(pngFromRaw(1, 1, Buffer.from([7, 1, 2, 3, 4]))), /unknown PNG scanline filter 7/);
  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) }), /expected 16/);
});

// --- containers ---------------------------------------------------------------

test('readIcnsEntries walks a container and rejects a damaged one', () => {
  const png = encodePng({ width: 1, height: 1, data: Uint8Array.from([1, 2, 3, 4]) });
  const icns = encodeIcns([{ type: 'ic07', png }], []);
  assert.deepEqual(
    readIcnsEntries(icns).map((e) => [e.type, e.payload.length]),
    [['ic07', png.length]],
  );

  assert.throws(() => readIcnsEntries(Buffer.from('nope')), /not an ICNS/);
  const wrongLength = Buffer.from(icns);
  wrongLength.writeUInt32BE(icns.length + 1, 4);
  assert.throws(() => readIcnsEntries(wrongLength), /length header says/);
  const badEntry = Buffer.from(icns);
  badEntry.writeUInt32BE(icns.length * 2, 12);
  assert.throws(() => readIcnsEntries(badEntry), /out-of-range length/);
  const zeroEntry = Buffer.from(icns);
  zeroEntry.writeUInt32BE(0, 12);
  assert.throws(() => readIcnsEntries(zeroEntry), /out-of-range length/);
});

test('encodeIcns writes legacy entries as RLE colour planes and a raw mask', () => {
  const image = { width: 2, height: 2, data: Uint8Array.from([9, 8, 7, 255, 9, 8, 7, 128, 9, 8, 7, 0, 1, 2, 3, 255]) };
  const entries = readIcnsEntries(encodeIcns([], [{ type: 'is32', mask: 's8mk', image }]));
  assert.deepEqual(
    entries.map((e) => e.type),
    ['is32', 's8mk'],
  );
  assert.deepEqual(icnsRleDecode(entries[0].payload), Uint8Array.from([9, 9, 9, 1, 8, 8, 8, 2, 7, 7, 7, 3]));
  assert.deepEqual(maskAlpha(entries[1].payload, 2).alpha, Uint8Array.from([255, 128, 0, 255]));
  assert.throws(() => maskAlpha(entries[1].payload, 3), /expected 9/);
});

test('icnsRle round-trips runs, literals and their length limits', () => {
  const cases = [
    [],
    [1],
    [1, 1],
    [1, 1, 1],
    [5, 5, 5, 5, 7, 7, 1, 2, 3, 3, 3, 3, 3, 9],
    Array(300).fill(4),
    Array.from({ length: 257 }, (_, i) => i & 0xff),
    Array.from({ length: 130 }, () => 2).concat([2, 3, 3, 3]),
  ];
  for (const bytes of cases) {
    const input = Uint8Array.from(bytes);
    assert.deepEqual(icnsRleDecode(icnsRle(input)), input, `case of ${bytes.length} bytes`);
  }
  assert.deepEqual(icnsRle(Uint8Array.from([4, 4, 4, 4])), Buffer.from([0x81, 4]), 'a run of 4 is 0x80 + 1');
  assert.deepEqual(icnsRle(Uint8Array.from([1, 2])), Buffer.from([1, 1, 2]), 'a literal of 2 is 1, bytes');
});

test('readIcoEntries reads the directory the build writes and rejects the rest', () => {
  const png = encodePng({ width: 1, height: 1, data: Uint8Array.from([1, 2, 3, 4]) });
  const ico = encodeIco([
    { size: 16, png },
    { size: 256, png },
  ]);
  assert.deepEqual(
    readIcoEntries(ico).map((e) => [e.size, e.payload.length]),
    [
      [16, png.length],
      [256, png.length],
    ],
  );
  assert.throws(() => readIcoEntries(Buffer.from([0, 0, 2, 0, 1, 0])), /not an ICO/);
  assert.throws(() => readIcoEntries(Buffer.from([0, 0, 1, 0, 1, 0])), /past the end/);
  const badOffset = Buffer.from(ico);
  badOffset.writeUInt32LE(ico.length, 6 + 12);
  assert.throws(() => readIcoEntries(badOffset), /out-of-range payload/);
  const bmp = Buffer.from(ico);
  bmp[6 + 16 * 2] = 0x42; // first byte of the first payload
  assert.throws(() => readIcoEntries(bmp), /not PNG-compressed/);
});

test('measureMargins reports full margins for a blank image and honours the threshold', () => {
  const blank = { width: 3, height: 2, alpha: new Uint8Array(6) };
  assert.deepEqual(measureMargins(blank), { left: 3, top: 2, right: 3, bottom: 2 });
  const faint = { width: 3, height: 3, alpha: Uint8Array.from([0, 0, 0, 0, 50, 0, 0, 0, 0]) };
  assert.deepEqual(measureMargins(faint), { left: 3, top: 3, right: 3, bottom: 3 }, 'alpha 50 is under the body threshold');
  assert.deepEqual(measureMargins(faint, 0), { left: 1, top: 1, right: 1, bottom: 1 });
});

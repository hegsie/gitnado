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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

import {
  APPLE_CANVAS,
  APPLE_MARGIN,
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
  encodeIco,
  encodeIcns,
  icnsRle,
  sharpen,
} from './build-icons.mjs';
import {
  BODY_ALPHA_THRESHOLD,
  REPO_ROOT,
  maskAlpha,
  measureMargins,
  pngAlpha,
  readIcnsEntries,
  readIcoEntries,
} from './icon-safe-area.mjs';
import { alphaOf, decodePng, encodePng } from './png.mjs';

const readRepoFile = (path) => readFileSync(join(REPO_ROOT, path));
const SOURCE_PNG = readRepoFile(SOURCE);
const BUILT = buildIcons(SOURCE_PNG);
const COMMITTED = new Map([...BUILT.keys()].map((path) => [path, readRepoFile(path)]));

/** Apple's margin at `size`, as the build lays it out: a whole pixel count. */
const expectedMargin = (size) => Math.floor((size * APPLE_MARGIN) / APPLE_CANVAS);
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

function assertSamePng(committed, built, label) {
  const c = decodePng(committed);
  const b = decodePng(built);
  assert.equal(c.width, b.width, `${label}: width`);
  assert.equal(c.height, b.height, `${label}: height`);
  assert.ok(maxDifference(c.data, b.data) <= 1, `${label}: pixels differ from a fresh build — run node scripts/build-icons.mjs`);
}

test('every committed icon is what build-icons.mjs produces from the master', () => {
  for (const [path, built] of BUILT) {
    const committed = COMMITTED.get(path);
    if (path === ICO_PATH) {
      const c = readIcoEntries(committed);
      const b = readIcoEntries(built);
      assert.deepEqual(
        c.map((e) => e.size),
        b.map((e) => e.size),
        `${path}: entry sizes`,
      );
      c.forEach((entry, i) => assertSamePng(entry.payload, b[i].payload, `${path} ${entry.size}px`));
    } else if (path === ICNS_PATH) {
      const c = readIcnsEntries(committed);
      const b = readIcnsEntries(built);
      assert.deepEqual(
        c.map((e) => e.type),
        b.map((e) => e.type),
        `${path}: entry types`,
      );
      c.forEach((entry, i) => {
        const fresh = b[i].payload;
        if (entry.type in ICNS_PNG_TYPES) assertSamePng(entry.payload, fresh, `${path} ${entry.type}`);
        else if (entry.type in ICNS_LEGACY_TYPES) {
          assert.ok(
            maxDifference(icnsRleDecode(entry.payload), icnsRleDecode(fresh)) <= 1,
            `${path} ${entry.type}: RGB differs from a fresh build`,
          );
        } else assert.ok(maxDifference(entry.payload, fresh) <= 1, `${path} ${entry.type}: mask differs from a fresh build`);
      });
    } else {
      assertSamePng(committed, built, path);
    }
  }
});

test('icon.icns carries the entry set the build writes, PNG and legacy', () => {
  const types = readIcnsEntries(COMMITTED.get(ICNS_PATH)).map((e) => e.type);
  const expected = [
    ...Object.keys(ICNS_PNG_TYPES),
    ...Object.entries(ICNS_LEGACY_TYPES).flatMap(([type, { mask }]) => [type, mask]),
  ];
  assert.deepEqual([...types].sort(), [...expected].sort());
});

test('every icon.icns entry sits on Apple’s grid, shadow inside the canvas', () => {
  for (const { type, payload } of readIcnsEntries(COMMITTED.get(ICNS_PATH))) {
    let image;
    if (type in ICNS_PNG_TYPES) image = pngAlpha(payload);
    else if (legacySize(type)) image = maskAlpha(payload, legacySize(type));
    else continue; // is32/il32 carry colour only; their masks are measured

    const { width, height, alpha } = image;
    assert.equal(width, height, `${type} is not square`);
    if (type in ICNS_PNG_TYPES) assert.equal(width, ICNS_PNG_TYPES[type], `${type} is the wrong size`);

    const m = expectedMargin(width);
    assert.deepEqual(
      measureMargins(image),
      { left: m, top: m, right: m, bottom: m },
      `${type} (${width}px) is off Apple's grid; the body must leave ${m}px on every side`,
    );

    // The shadow: visible just below the body from 64px up, and never
    // reaching the canvas edge at any size.
    if (type in ICNS_PNG_TYPES && width >= 64) {
      const below = alpha[(height - m) * width + (width >> 1)];
      assert.ok(below > 0 && below <= BODY_ALPHA_THRESHOLD, `${type}: no shadow under the body (alpha ${below})`);
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
  for (const [path, size] of Object.entries(FULL_BLEED_PNGS)) {
    const image = pngAlpha(COMMITTED.get(path));
    assert.equal(image.width, size, `${path}: width`);
    assert.equal(image.height, size, `${path}: height`);
    assert.deepEqual(measureMargins(image, 0), { left: 0, top: 0, right: 0, bottom: 0 }, `${path} gained a margin`);
  }
});

test('icon.ico carries every size Windows asks for, each full-bleed', () => {
  const entries = readIcoEntries(COMMITTED.get(ICO_PATH));
  assert.deepEqual(
    entries.map((e) => e.size),
    ICO_SIZES,
  );
  for (const { size, payload } of entries) {
    const image = pngAlpha(payload);
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    assert.deepEqual(measureMargins(image, 0), { left: 0, top: 0, right: 0, bottom: 0 }, `${size}px entry gained a margin`);
  }
});

test('the master is 1024x1024 and the build refuses any other size', () => {
  const master = decodePng(SOURCE_PNG);
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

test('enhance raises chroma, keeps alpha, and lights the rim in the rim colour', () => {
  const before = sample();
  const after = enhance(before, ENHANCE);
  assert.equal(after.data[3], 0, 'transparent pixel stays transparent');
  for (let i = 0; i < 16; i += 1) assert.equal(after.data[i * 4 + 3], before.data[i * 4 + 3], 'alpha is untouched');

  const chroma = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
  // The centre pixel (2,2) is far from the edge: only saturation/contrast apply.
  const centre = (2 * 4 + 2) * 4;
  assert.ok(chroma(after.data, centre) > chroma(before.data, centre), 'centre pixel is more saturated');
  // A pixel next to the transparent corner is on the rim: pulled toward the rim colour (bluer-white).
  const rimPixel = (0 * 4 + 1) * 4;
  assert.ok(after.data[rimPixel] > after.data[centre], 'rim pixel is lighter than the centre');
  for (let i = 0; i < after.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) assert.ok(after.data[i + c] <= after.data[i + 3] + 1e-6, 'premultiplied invariant');
  }
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

test('the PNG codec round-trips and decodes every scanline filter', () => {
  const image = { width: 3, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37) & 0xff) };
  const back = decodePng(encodePng(image));
  assert.deepEqual([back.width, back.height], [3, 2]);
  assert.deepEqual(back.data, image.data);
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

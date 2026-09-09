/**
 * macOS app-icon safe-area contract test.
 *
 * The failure this exists to catch: `icon.icns` regenerated from the
 * full-bleed master, so the macOS icon loses Apple's 824/1024 safe area and
 * renders oversized in the Dock with its corners shaved — reported, in the
 * plainest terms available, as "why is the icon cut off?".
 *
 * The reverse mistake is checked too. `icon-source.png`, `icon.png` and the
 * Linux PNGs are full-bleed on purpose: those hosts composite their own
 * shape and the website's hero art is a square tile. Padding them would fix
 * nothing and make the icon read as undersized everywhere else.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ALPHA_THRESHOLD,
  APPLE_BODY,
  APPLE_CANVAS,
  APPLE_MARGIN,
  ICNS_PNG_TYPES,
  ICONS_DIR,
  MAX_SAFE_AREA,
  MIN_SAFE_AREA,
  decodePngAlpha,
  measureMargins,
  readIcnsPngEntries,
  safeAreaRatios,
} from './icon-safe-area.mjs';

/** Masters and derived icons that must stay edge to edge. */
const FULL_BLEED = [
  'icon-source.png',
  'icon.png',
  '128x128.png',
  '128x128@2x.png',
  '64x64.png',
  '32x32.png',
];

const readIcon = (name) => readFileSync(join(ICONS_DIR, name));

test('the macOS master sits on Apple’s 824/1024 icon grid', () => {
  const image = decodePngAlpha(readIcon('icon-source-macos.png'));
  assert.equal(image.width, APPLE_CANVAS);
  assert.equal(image.height, APPLE_CANVAS);

  const margins = measureMargins(image);
  assert.deepEqual(margins, {
    left: APPLE_MARGIN,
    top: APPLE_MARGIN,
    right: APPLE_MARGIN,
    bottom: APPLE_MARGIN,
  });
  assert.equal(image.width - margins.left - margins.right, APPLE_BODY);
});

test('icon.icns carries the entry set tauri icon writes', () => {
  const entries = readIcnsPngEntries(readIcon('icon.icns'));
  assert.deepEqual(
    entries.map((entry) => entry.type).sort(),
    [...ICNS_PNG_TYPES].sort(),
    'a missing size falls back to a scaled neighbour and looks soft in the Dock',
  );
});

test('every icon.icns entry keeps the macOS safe area on all four edges', () => {
  const entries = readIcnsPngEntries(readIcon('icon.icns'));
  assert.ok(entries.length > 0, 'icon.icns has no PNG entries');

  for (const { type, payload } of entries) {
    const image = decodePngAlpha(payload);
    assert.equal(image.width, image.height, `${type} is not square (${image.width}x${image.height})`);

    const ratios = safeAreaRatios(image);
    for (const [edge, ratio] of Object.entries(ratios)) {
      assert.ok(
        ratio >= MIN_SAFE_AREA && ratio <= MAX_SAFE_AREA,
        `${type} (${image.width}px) leaves ${(ratio * 100).toFixed(2)}% of canvas on the ${edge} edge; ` +
          `Apple's grid wants ${(MIN_SAFE_AREA * 100).toFixed(0)}–${(MAX_SAFE_AREA * 100).toFixed(0)}%. ` +
          'Regenerate icon.icns from icon-source-macos.png, not icon-source.png.',
      );
    }

    const margins = measureMargins(image);
    assert.equal(margins.left, margins.right, `${type} is not horizontally centred`);
    assert.equal(margins.top, margins.bottom, `${type} is not vertically centred`);
  }
});

test('the full-bleed masters and their Windows/Linux/web derivatives stay edge to edge', () => {
  for (const name of FULL_BLEED) {
    const image = decodePngAlpha(readIcon(name));
    assert.equal(image.width, image.height, `${name} is not square`);
    assert.deepEqual(
      measureMargins(image),
      { left: 0, top: 0, right: 0, bottom: 0 },
      `${name} gained a margin; only icon.icns takes Apple's safe area`,
    );
  }
});

test('the alpha reader sees the transparent corners of a full-bleed tile', () => {
  const { width, height, alpha } = decodePngAlpha(readIcon('32x32.png'));
  const at = (x, y) => alpha[y * width + x];
  // The tile is a rounded square: corners cut away, edge midpoints solid.
  assert.ok(at(0, 0) <= ALPHA_THRESHOLD, 'top-left corner should be transparent');
  assert.ok(at(width - 1, height - 1) <= ALPHA_THRESHOLD, 'bottom-right corner should be transparent');
  assert.ok(at(width >> 1, 0) > 250, 'top edge midpoint should be opaque');
  assert.ok(at(0, height >> 1) > 250, 'left edge midpoint should be opaque');
});

test('the alpha reader rejects a PNG it cannot decode correctly', () => {
  const buffer = readIcon('32x32.png');
  const greyscale = Buffer.from(buffer);
  greyscale[25] = 0; // IHDR colour type 0
  assert.throws(() => decodePngAlpha(greyscale), /unsupported PNG/);
  assert.throws(() => decodePngAlpha(Buffer.alloc(64)), /not a PNG/);
});

/**
 * Versions the asset URLs in the website before it is deployed.
 *
 * gitnado.dev is served through Cloudflare and GitHub Pages, both of which
 * cache images for hours, and browsers cache them for as long again. An asset
 * replaced under the same name therefore keeps showing its old contents until
 * every cache expires. Appending `?v=<content hash>` to each reference gives a
 * changed file a new URL, so caches fetch it immediately, while an unchanged
 * file keeps its URL and stays cached.
 *
 * Run by .github/workflows/pages.yml against the checked-out site/ directory
 * just before upload; the committed HTML keeps the plain paths so local
 * previews need no build step.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Matches `assets/<file>.<ext>` wherever it appears in an attribute value. */
const ASSET_REF =
  /assets\/([A-Za-z0-9_.-]+\.(?:webp|png|jpe?g|gif|svg|ico))(?=["'\s),?])/g;

/** Short content hash used as the version tag. */
export function hashFile(path) {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")
    .slice(0, 8);
}

/**
 * Rewrites every asset reference in `html` to carry `?v=<hash>`, where
 * `hashFor(fileName)` returns the hash for that asset. References that already
 * carry a query string are left alone. Returns the new HTML and the list of
 * files it versioned.
 */
export function versionAssets(html, hashFor) {
  const versioned = new Set();
  const out = html.replace(ASSET_REF, (match, file, offset, whole) => {
    if (whole[offset + match.length] === "?") return match;
    versioned.add(file);
    return `${match}?v=${hashFor(file)}`;
  });
  return { html: out, files: [...versioned].sort() };
}

/**
 * Versions `index.html` inside `siteDir` in place, hashing files from its
 * `assets/` directory. A reference to a file that does not exist is an error:
 * shipping a dangling asset URL is exactly what this step exists to prevent.
 */
export function versionSite(siteDir, { log = console.log } = {}) {
  const page = join(siteDir, "index.html");
  const { html, files } = versionAssets(readFileSync(page, "utf8"), (file) => {
    try {
      return hashFile(join(siteDir, "assets", file));
    } catch (error) {
      throw new Error(
        `index.html references assets/${file}, which does not exist (${error.code})`,
      );
    }
  });
  writeFileSync(page, html);
  for (const file of files) log(`versioned assets/${file}`);
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node version-site-assets.mjs <site directory>");
    process.exit(1);
  }
  try {
    versionSite(dir);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

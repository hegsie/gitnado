/**
 * Normalizes Tauri updater `latest.json` URLs from GitHub API asset endpoints
 * to direct browser download URLs.
 *
 * When `tauri-apps/tauri-action` uploads updater metadata to a draft release
 * (`releaseDraft: true`), it populates `platforms.<target>.url` with the GitHub
 * REST API asset endpoint (`https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`)
 * because draft browser URLs require a web session cookie. Once the release is
 * published, however, Tauri's updater fetches `url` without
 * `Accept: application/octet-stream`, causing `api.github.com` asset URLs to
 * return HTTP 404 and breaking in-app auto-updates.
 *
 * This script maps each API asset URL back to its release asset by ID (or exact
 * API URL) and rewrites it to:
 *   `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset.name>`
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API_ASSET_URL_RE =
  /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+)$/;

/**
 * Builds direct browser download URLs keyed by both asset API URL and numeric
 * asset ID string.
 */
export function buildAssetDownloadMap(release, repoOverride) {
  if (!release || typeof release !== "object") {
    throw new Error("Release metadata must be a JSON object");
  }
  const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  if (!tag) {
    throw new Error("Release metadata is missing tag_name");
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const byId = new Map();
  const byApiUrl = new Map();

  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || !asset.name.trim()) {
      continue;
    }
    const match = typeof asset.url === "string" ? asset.url.match(API_ASSET_URL_RE) : null;
    const repo = repoOverride || (match ? match[1] : null);
    const downloadUrl =
      repo
        ? `https://github.com/${repo}/releases/download/${tag}/${asset.name}`
        : typeof asset.browser_download_url === "string" && asset.browser_download_url
          ? asset.browser_download_url
          : null;

    if (!downloadUrl) continue;

    if (asset.id !== undefined && asset.id !== null) {
      byId.set(String(asset.id), downloadUrl);
    }
    if (typeof asset.url === "string" && asset.url) {
      byApiUrl.set(asset.url, downloadUrl);
    }
  }

  return { tag, byId, byApiUrl };
}

/**
 * Rewrites any `api.github.com/repos/.../releases/assets/<id>` URLs in
 * `latest.platforms` to direct `/releases/download/<tag>/<name>` URLs.
 *
 * Throws if a platform has a missing URL or an API asset URL whose asset ID is
 * not present on the release.
 */
export function normalizeLatestJson(latestInput, releaseInput, { repo } = {}) {
  const latest =
    typeof latestInput === "string"
      ? JSON.parse(latestInput)
      : structuredClone(latestInput);
  const release =
    typeof releaseInput === "string" ? JSON.parse(releaseInput) : releaseInput;

  if (!latest || typeof latest !== "object" || !latest.platforms || typeof latest.platforms !== "object") {
    throw new Error("latest.json is missing a platforms object");
  }

  const { byId, byApiUrl } = buildAssetDownloadMap(release, repo);
  let changed = false;

  for (const [platform, entry] of Object.entries(latest.platforms)) {
    if (!entry || typeof entry.url !== "string" || !entry.url.trim()) {
      throw new Error(`Platform ${platform} in latest.json is missing a url`);
    }

    const currentUrl = entry.url.trim();
    const apiMatch = currentUrl.match(API_ASSET_URL_RE);
    if (!apiMatch) {
      if (currentUrl !== entry.url) {
        entry.url = currentUrl;
        changed = true;
      }
      continue;
    }

    const assetId = apiMatch[2];
    const directUrl = byApiUrl.get(currentUrl) ?? byId.get(assetId);
    if (!directUrl) {
      throw new Error(
        `Cannot resolve release asset ${assetId} (${currentUrl}) for platform ${platform}`,
      );
    }

    entry.url = directUrl;
    changed = true;
  }

  return {
    changed,
    latest,
    json: `${JSON.stringify(latest, null, 2)}\n`,
  };
}

const CLI_OPTIONS = ["latest", "release", "repo", "out"];

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const name = flag?.startsWith("--") ? flag.slice(2) : null;
    if (!name || !CLI_OPTIONS.includes(name)) {
      throw new Error(`Unknown argument ${flag}`);
    }
    if (i + 1 >= argv.length) {
      throw new Error(`Missing value for ${flag}`);
    }
    options[name] = argv[i + 1];
  }
  for (const required of ["latest", "release"]) {
    if (!(required in options)) {
      throw new Error(`Missing required argument --${required}`);
    }
  }
  return options;
}

export function main(argv, { log = console.log } = {}) {
  const options = parseArgs(argv);
  const latestRaw = readFileSync(options.latest, "utf8");
  const releaseRaw = readFileSync(options.release, "utf8");
  const result = normalizeLatestJson(latestRaw, releaseRaw, {
    repo: options.repo,
  });
  const outPath = options.out ?? options.latest;
  writeFileSync(outPath, result.json);
  log(result.changed ? "updated" : "unchanged");
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

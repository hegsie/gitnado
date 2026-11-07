import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAssetDownloadMap,
  main,
  normalizeLatestJson,
  parseArgs,
} from "./normalize-latest-json.mjs";

const SCRIPT = fileURLToPath(
  new URL("./normalize-latest-json.mjs", import.meta.url),
);

const RELEASE_FIXTURE = {
  tag_name: "v1.1.2",
  assets: [
    {
      id: 390166863,
      name: "Gitnado_aarch64.app.tar.gz",
      url: "https://api.github.com/repos/hegsie/gitnado/releases/assets/390166863",
      browser_download_url:
        "https://github.com/hegsie/gitnado/releases/download/untagged-draft/Gitnado_aarch64.app.tar.gz",
    },
    {
      id: 390169695,
      name: "Gitnado_1.1.2_amd64.AppImage",
      url: "https://api.github.com/repos/hegsie/gitnado/releases/assets/390169695",
      browser_download_url:
        "https://github.com/hegsie/gitnado/releases/download/v1.1.2/Gitnado_1.1.2_amd64.AppImage",
    },
    {
      id: 390171183,
      name: "Gitnado_1.1.2_x64-setup.exe",
      url: "https://api.github.com/repos/hegsie/gitnado/releases/assets/390171183",
      browser_download_url:
        "https://github.com/hegsie/gitnado/releases/download/v1.1.2/Gitnado_1.1.2_x64-setup.exe",
    },
  ],
};

const DRAFT_LATEST_FIXTURE = {
  version: "1.1.2",
  notes: "See the assets below to download and install this version.",
  pub_date: "2026-11-07T17:38:27.717Z",
  platforms: {
    "darwin-aarch64": {
      signature: "sig-mac",
      url: "https://api.github.com/repos/hegsie/gitnado/releases/assets/390166863",
    },
    "linux-x86_64": {
      signature: "sig-linux",
      url: "https://api.github.com/repos/hegsie/gitnado/releases/assets/390169695",
    },
    "windows-x86_64": {
      signature: "sig-win",
      url: "https://api.github.com/repos/hegsie/gitnado/releases/assets/390171183",
    },
  },
};

test("buildAssetDownloadMap constructs deterministic tag download URLs even for draft assets", () => {
  const { tag, byId } = buildAssetDownloadMap(RELEASE_FIXTURE);
  assert.equal(tag, "v1.1.2");
  // Even if GitHub's draft browser_download_url had untagged-draft, the URL
  // derived from repo + tag_name + asset.name points at the canonical tag path.
  assert.equal(
    byId.get("390166863"),
    "https://github.com/hegsie/gitnado/releases/download/v1.1.2/Gitnado_aarch64.app.tar.gz",
  );
});

test("normalizeLatestJson rewrites all api.github.com asset URLs to direct download URLs", () => {
  const result = normalizeLatestJson(DRAFT_LATEST_FIXTURE, RELEASE_FIXTURE);
  assert.equal(result.changed, true);
  assert.deepEqual(result.latest.platforms, {
    "darwin-aarch64": {
      signature: "sig-mac",
      url: "https://github.com/hegsie/gitnado/releases/download/v1.1.2/Gitnado_aarch64.app.tar.gz",
    },
    "linux-x86_64": {
      signature: "sig-linux",
      url: "https://github.com/hegsie/gitnado/releases/download/v1.1.2/Gitnado_1.1.2_amd64.AppImage",
    },
    "windows-x86_64": {
      signature: "sig-win",
      url: "https://github.com/hegsie/gitnado/releases/download/v1.1.2/Gitnado_1.1.2_x64-setup.exe",
    },
  });

  // Running a second time is idempotent and reports changed: false.
  const second = normalizeLatestJson(result.latest, RELEASE_FIXTURE);
  assert.equal(second.changed, false);
  assert.deepEqual(second.latest, result.latest);
});

test("normalizeLatestJson fails when an API asset ID is missing from the release", () => {
  const broken = structuredClone(DRAFT_LATEST_FIXTURE);
  broken.platforms["darwin-aarch64"].url =
    "https://api.github.com/repos/hegsie/gitnado/releases/assets/999999999";
  assert.throws(
    () => normalizeLatestJson(broken, RELEASE_FIXTURE),
    /Cannot resolve release asset 999999999/,
  );
});

test("parseArgs validates required flags and rejects unknown flags", () => {
  assert.deepEqual(
    parseArgs(["--latest", "latest.json", "--release", "release.json"]),
    { latest: "latest.json", release: "release.json" },
  );
  assert.throws(
    () => parseArgs(["--latest", "latest.json"]),
    /Missing required argument --release/,
  );
  assert.throws(
    () => parseArgs(["--bogus", "1"]),
    /Unknown argument --bogus/,
  );
});

test("CLI rewrites latest.json in place and prints 'updated' then 'unchanged'", () => {
  const dir = mkdtempSync(join(tmpdir(), "latest-json-"));
  const latestPath = join(dir, "latest.json");
  const releasePath = join(dir, "release.json");
  writeFileSync(latestPath, JSON.stringify(DRAFT_LATEST_FIXTURE, null, 2));
  writeFileSync(releasePath, JSON.stringify(RELEASE_FIXTURE, null, 2));

  const logs = [];
  main(["--latest", latestPath, "--release", releasePath], {
    log: (line) => logs.push(line),
  });
  assert.deepEqual(logs, ["updated"]);

  const updated = JSON.parse(readFileSync(latestPath, "utf8"));
  assert.equal(
    updated.platforms["darwin-aarch64"].url,
    "https://github.com/hegsie/gitnado/releases/download/v1.1.2/Gitnado_aarch64.app.tar.gz",
  );

  const cliResult = spawnSync(
    process.execPath,
    [SCRIPT, "--latest", latestPath, "--release", releasePath],
    { encoding: "utf8" },
  );
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(cliResult.stdout.trim(), "unchanged");
});

test("build.yml and publish-packages.yml normalize latest.json and ci.yml caches CMake version", () => {
  const buildWorkflow = readFileSync(
    fileURLToPath(new URL("../workflows/build.yml", import.meta.url)),
    "utf8",
  );
  const publishWorkflow = readFileSync(
    fileURLToPath(new URL("../workflows/publish-packages.yml", import.meta.url)),
    "utf8",
  );
  const ciWorkflow = readFileSync(
    fileURLToPath(new URL("../workflows/ci.yml", import.meta.url)),
    "utf8",
  );

  assert.match(buildWorkflow, /node \.github\/scripts\/normalize-latest-json\.mjs/);
  assert.match(publishWorkflow, /node \.github\/scripts\/normalize-latest-json\.mjs/);
  assert.equal(
    (ciWorkflow.match(/env-vars: ImageOS CMAKE_VERSION/g) ?? []).length,
    4,
  );
});


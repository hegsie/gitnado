import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  hashFile,
  versionAssets,
  versionSite,
} from "./version-site-assets.mjs";

const SCRIPT = fileURLToPath(
  new URL("./version-site-assets.mjs", import.meta.url),
);
const REAL_SITE = fileURLToPath(new URL("../../site/", import.meta.url));
const PAGES_YML = readFileSync(
  fileURLToPath(new URL("../workflows/pages.yml", import.meta.url)),
  "utf8",
);

const hashes = {
  "a.png": "11111111",
  "b.webp": "22222222",
  "c.svg": "33333333",
};
const hashFor = (file) => {
  if (!(file in hashes)) throw new Error(`no hash for ${file}`);
  return hashes[file];
};

test("versionAssets tags every kind of reference and reports the files", () => {
  const html = [
    '<link rel="icon" href="assets/a.png">',
    '<meta property="og:image" content="https://gitnado.dev/assets/b.webp">',
    '<img src="assets/b.webp" srcset="assets/a.png 256w, assets/c.svg 512w">',
    "<div style=\"background:url('assets/a.png')\"></div>",
  ].join("\n");
  const { html: out, files } = versionAssets(html, hashFor);
  assert.equal(
    out,
    [
      '<link rel="icon" href="assets/a.png?v=11111111">',
      '<meta property="og:image" content="https://gitnado.dev/assets/b.webp?v=22222222">',
      '<img src="assets/b.webp?v=22222222" srcset="assets/a.png?v=11111111 256w, assets/c.svg?v=33333333 512w">',
      "<div style=\"background:url('assets/a.png?v=11111111')\"></div>",
    ].join("\n"),
  );
  assert.deepEqual(files, ["a.png", "b.webp", "c.svg"]);
});

test("versionAssets leaves references that already carry a query string alone", () => {
  const html = '<img src="assets/a.png?v=old"> <img src="assets/b.webp">';
  const { html: out, files } = versionAssets(html, hashFor);
  assert.equal(
    out,
    '<img src="assets/a.png?v=old"> <img src="assets/b.webp?v=22222222">',
  );
  assert.deepEqual(files, ["b.webp"]);
});

test("versionAssets is idempotent and ignores non-asset paths", () => {
  const html =
    '<a href="https://github.com/hegsie/gitnado/releases">x</a> <script src="app.js"></script> <img src="assets/a.png">';
  const once = versionAssets(html, hashFor).html;
  assert.equal(versionAssets(once, hashFor).html, once);
  assert.match(once, /assets\/a\.png\?v=11111111/);
  assert.doesNotMatch(once, /releases\?v=|app\.js\?v=/);
});

test("hashFile is a short, stable content hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-hash-"));
  const file = join(dir, "x.bin");
  writeFileSync(file, "gitnado");
  assert.equal(hashFile(file), "9ced9f4c");
  writeFileSync(file, "gitnado!");
  assert.notEqual(hashFile(file), "9ced9f4c");
});

function siteFixture() {
  const dir = mkdtempSync(join(tmpdir(), "site-fixture-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "shot.webp"), "first");
  writeFileSync(
    join(dir, "index.html"),
    '<img src="assets/shot.webp"><meta content="https://gitnado.dev/assets/shot.webp">',
  );
  return dir;
}

test("versionSite rewrites index.html in place and the tag changes with the file", () => {
  const dir = siteFixture();
  const logs = [];
  assert.deepEqual(versionSite(dir, { log: (l) => logs.push(l) }), [
    "shot.webp",
  ]);
  const first = readFileSync(join(dir, "index.html"), "utf8");
  const tag = hashFile(join(dir, "assets", "shot.webp"));
  assert.equal(
    first,
    `<img src="assets/shot.webp?v=${tag}"><meta content="https://gitnado.dev/assets/shot.webp?v=${tag}">`,
  );
  assert.deepEqual(logs, ["versioned assets/shot.webp"]);

  // A replaced asset gets a new URL on the next deploy.
  writeFileSync(join(dir, "assets", "shot.webp"), "second");
  writeFileSync(join(dir, "index.html"), '<img src="assets/shot.webp">');
  versionSite(dir, { log() {} });
  assert.notEqual(
    readFileSync(join(dir, "index.html"), "utf8"),
    `<img src="assets/shot.webp?v=${tag}">`,
  );
});

test("versionSite fails on a reference to a missing asset", () => {
  const dir = siteFixture();
  writeFileSync(join(dir, "index.html"), '<img src="assets/missing.png">');
  assert.throws(
    () => versionSite(dir, { log() {} }),
    /assets\/missing\.png, which does not exist/,
  );
});

test("the real site versions cleanly and every referenced asset exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-real-"));
  cpSync(REAL_SITE, dir, { recursive: true });
  const files = versionSite(dir, { log() {} });
  assert.ok(files.includes("main-window.webp"));
  assert.ok(files.includes("icon-256.png"));
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.doesNotMatch(
    html,
    /assets\/[A-Za-z0-9_.-]+\.(?:webp|png|svg|ico)["'\s)]/,
    "an asset reference was left unversioned",
  );
  assert.match(
    html,
    /og:image" content="https:\/\/gitnado\.dev\/assets\/main-window\.webp\?v=[0-9a-f]{8}"/,
  );
});

test("the CLI versions a directory and reports a missing asset with exit code 1", () => {
  const dir = siteFixture();
  const ok = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /versioned assets\/shot\.webp/);
  writeFileSync(join(dir, "index.html"), '<img src="assets/nope.png">');
  const bad = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /nope\.png/);
  const noArg = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(noArg.status, 1);
});

test("pages.yml runs the versioning step before uploading the site", () => {
  const run = PAGES_YML.indexOf(
    "node .github/scripts/version-site-assets.mjs site",
  );
  const upload = PAGES_YML.indexOf("actions/upload-pages-artifact");
  assert.ok(run > 0, "pages.yml does not run version-site-assets.mjs");
  assert.ok(run < upload, "versioning must happen before the upload");
});

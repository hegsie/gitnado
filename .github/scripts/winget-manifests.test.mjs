import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PACKAGE_IDENTIFIER,
  PLACEHOLDERS,
  TEMPLATE_DIR,
  main,
  manifestDir,
  normalizeValues,
  parseArgs,
  parseProductCode,
  renderManifests,
  renderTemplate,
  sha256Of,
  writeManifests,
} from "./winget-manifests.mjs";

const SCRIPT = fileURLToPath(
  new URL("./winget-manifests.mjs", import.meta.url),
);
const WORKFLOW = readFileSync(
  fileURLToPath(new URL("../workflows/publish-packages.yml", import.meta.url)),
  "utf8",
);

const EXE_SHA =
  "ea96669ad6bdd13051e06502d0d401e3e9891e6af9637347cc5d7a19f6ce72c1";
const MSI_SHA =
  "4A913B86EE3028DD3E69EC61B8FE8640B296A267FEB46011E7B1809392542AE5";
const PRODUCT_CODE = "{1A0C259A-26DF-403E-AAD3-DD086617E759}";

const VALUES = {
  VERSION: "0.9.0",
  RELEASE_DATE: "2026-09-09",
  EXE_SHA256: EXE_SHA,
  MSI_SHA256: MSI_SHA,
  MSI_PRODUCT_CODE: PRODUCT_CODE.toLowerCase(),
};

const MANIFEST_FILES = [
  "hegsie.Gitnado.installer.yaml",
  "hegsie.Gitnado.locale.en-US.yaml",
  "hegsie.Gitnado.yaml",
];

/** A minimal reader for the flat `Key: value` lines the manifests use. */
function topLevel(yaml, key) {
  const match = yaml.match(new RegExp(`^${key}: (.*)$`, "m"));
  return match ? match[1] : undefined;
}

test("manifestDir follows the winget-pkgs layout for the package identifier", () => {
  assert.equal(PACKAGE_IDENTIFIER, "hegsie.Gitnado");
  assert.equal(manifestDir("0.9.0"), "manifests/h/hegsie/Gitnado/0.9.0");
});

test("normalizeValues trims and upper-cases hashes and product codes", () => {
  const values = normalizeValues({
    ...VALUES,
    EXE_SHA256: ` ${EXE_SHA} `,
    VERSION: " 0.9.0 ",
  });
  assert.equal(values.EXE_SHA256, EXE_SHA.toUpperCase());
  assert.equal(values.MSI_SHA256, MSI_SHA);
  assert.equal(values.MSI_PRODUCT_CODE, PRODUCT_CODE);
  assert.equal(values.VERSION, "0.9.0");
  assert.equal(values.RELEASE_DATE, "2026-09-09");
});

test("normalizeValues reports every missing or malformed value at once", () => {
  assert.throws(
    () =>
      normalizeValues({
        VERSION: "v0.9.0",
        RELEASE_DATE: "",
        EXE_SHA256: "not-a-hash",
        MSI_SHA256: MSI_SHA,
        MSI_PRODUCT_CODE: "Gitnado",
      }),
    (error) => {
      assert.match(error.message, /VERSION has unexpected value "v0\.9\.0"/);
      assert.match(error.message, /RELEASE_DATE is missing/);
      assert.match(error.message, /EXE_SHA256 has unexpected value/);
      assert.match(error.message, /MSI_PRODUCT_CODE has unexpected value/);
      assert.doesNotMatch(error.message, /MSI_SHA256/);
      return true;
    },
  );
});

test("renderTemplate substitutes every placeholder and rejects unknown ones", () => {
  const values = normalizeValues(VALUES);
  assert.equal(
    renderTemplate(
      "v{{VERSION}} Gitnado_{{VERSION}}_x64 {{EXE_SHA256}}",
      values,
    ),
    `v0.9.0 Gitnado_0.9.0_x64 ${EXE_SHA.toUpperCase()}`,
  );
  assert.throws(
    () => renderTemplate("{{NOPE}}", values),
    /unknown placeholder \{\{NOPE\}\}/,
  );
});

test("every placeholder used by the real templates is a known one", () => {
  const used = new Set();
  for (const name of readdirSync(TEMPLATE_DIR)) {
    if (!name.endsWith(".template")) continue;
    for (const match of readFileSync(join(TEMPLATE_DIR, name), "utf8").matchAll(
      /\{\{([^}]*)\}\}/g,
    )) {
      used.add(match[1]);
    }
  }
  assert.ok(used.has("VERSION"));
  for (const name of used) {
    assert.ok(
      name in PLACEHOLDERS,
      `template placeholder {{${name}}} is not defined`,
    );
  }
});

test("renderManifests produces the three winget manifests with no placeholders left", () => {
  const manifests = renderManifests(VALUES);
  assert.deepEqual(Object.keys(manifests).sort(), MANIFEST_FILES);

  for (const [name, content] of Object.entries(manifests)) {
    assert.doesNotMatch(
      content,
      /\{\{|\}\}/,
      `${name} still has a placeholder`,
    );
    assert.equal(topLevel(content, "PackageIdentifier"), "hegsie.Gitnado");
    assert.equal(topLevel(content, "PackageVersion"), "0.9.0");
    assert.equal(topLevel(content, "ManifestVersion"), "1.12.0");
  }

  const installer = manifests["hegsie.Gitnado.installer.yaml"];
  assert.equal(topLevel(installer, "ManifestType"), "installer");
  assert.equal(topLevel(installer, "ReleaseDate"), "2026-09-09");
  assert.match(
    installer,
    /InstallerUrl: https:\/\/github\.com\/hegsie\/gitnado\/releases\/download\/v0\.9\.0\/Gitnado_0\.9\.0_x64-setup\.exe\n\s+InstallerSha256: EA96669AD6BDD13051E06502D0D401E3E9891E6AF9637347CC5D7A19F6CE72C1/,
  );
  assert.match(
    installer,
    /InstallerUrl: https:\/\/github\.com\/hegsie\/gitnado\/releases\/download\/v0\.9\.0\/Gitnado_0\.9\.0_x64_en-US\.msi\n\s+InstallerSha256: 4A913B86EE3028DD3E69EC61B8FE8640B296A267FEB46011E7B1809392542AE5/,
  );
  // The MSI ProductCode changes every build; the UpgradeCode is pinned in
  // tauri.conf.json so MSI upgrades replace the previous install.
  assert.equal(
    installer.match(/ProductCode: '\{1A0C259A-26DF-403E-AAD3-DD086617E759\}'/g)
      .length,
    2,
  );
  assert.match(
    installer,
    /UpgradeCode: '\{84C95AFF-09D5-5959-BE4D-927B1CC7FC1B\}'/,
  );
  // The NSIS installer registers under Uninstall\<productName>, so its
  // ProductCode is the product name.
  assert.equal(installer.match(/ProductCode: Gitnado$/gm).length, 2);
  assert.match(installer, /InstallerType: nullsoft\n\s+Scope: user/);
  assert.match(installer, /InstallerType: wix\n\s+Scope: machine/);
  assert.match(
    installer,
    /InstallModes:\n- interactive\n- silent\n- silentWithProgress/,
  );

  const locale = manifests["hegsie.Gitnado.locale.en-US.yaml"];
  assert.equal(topLevel(locale, "ManifestType"), "defaultLocale");
  assert.equal(topLevel(locale, "PackageLocale"), "en-US");
  assert.equal(topLevel(locale, "Moniker"), "gitnado");
  assert.equal(
    topLevel(locale, "ReleaseNotesUrl"),
    "https://github.com/hegsie/gitnado/releases/tag/v0.9.0",
  );

  const version = manifests["hegsie.Gitnado.yaml"];
  assert.equal(topLevel(version, "ManifestType"), "version");
  assert.equal(topLevel(version, "DefaultLocale"), "en-US");
});

test("renderManifests rejects a directory without templates and bad values", () => {
  const empty = mkdtempSync(join(tmpdir(), "winget-empty-"));
  assert.throws(
    () => renderManifests(VALUES, empty),
    /No \.template files found/,
  );
  assert.throws(
    () => renderManifests({ ...VALUES, VERSION: "0.9" }),
    /VERSION has unexpected value/,
  );
});

test("writeManifests places the files at the winget-pkgs path for the version", () => {
  const out = mkdtempSync(join(tmpdir(), "winget-out-"));
  const { dir, files } = writeManifests(VALUES, out);
  assert.equal(dir, join(out, "manifests", "h", "hegsie", "Gitnado", "0.9.0"));
  assert.deepEqual(readdirSync(dir).sort(), MANIFEST_FILES);
  assert.equal(files.length, 3);
  assert.equal(
    readFileSync(join(dir, "hegsie.Gitnado.yaml"), "utf8"),
    renderManifests(VALUES)["hegsie.Gitnado.yaml"],
  );
});

test("sha256Of returns the upper-case hex digest winget expects", () => {
  const dir = mkdtempSync(join(tmpdir(), "winget-sha-"));
  const file = join(dir, "installer.bin");
  writeFileSync(file, "gitnado");
  assert.equal(
    sha256Of(file),
    "9CED9F4CAF7440E302E4B533F1578E83E41B20F2BC7820C1F680E611B563E3AC",
  );
});

test("parseProductCode reads the code from komac analyze output, ignoring colours", () => {
  const output = [
    "\x1b[31mERROR\x1b[0m something unrelated",
    "InstallerLocale: en-US",
    "Architecture: x64",
    "InstallerType: wix",
    "ProductCode: '{1a0c259a-26df-403e-aad3-dd086617e759}'",
    "AppsAndFeaturesEntries:",
    "- ProductCode: '{1A0C259A-26DF-403E-AAD3-DD086617E759}'",
    "  UpgradeCode: '{84C95AFF-09D5-5959-BE4D-927B1CC7FC1B}'",
  ].join("\n");
  assert.equal(parseProductCode(output), PRODUCT_CODE);
  assert.equal(
    parseProductCode("ProductCode: {1A0C259A-26DF-403E-AAD3-DD086617E759}\r\n"),
    PRODUCT_CODE,
  );
  assert.throws(
    () => parseProductCode("ProductCode: Gitnado\n"),
    /No ProductCode found/,
  );
  assert.throws(() => parseProductCode(""), /No ProductCode found/);
});

test("parseArgs requires every option and rejects unknown ones", () => {
  const argv = [
    "--version",
    "0.9.0",
    "--exe",
    "a.exe",
    "--msi",
    "a.msi",
    "--msi-analysis",
    "a.txt",
    "--release-date",
    "2026-09-09",
    "--out",
    "winget",
  ];
  assert.deepEqual(parseArgs(argv), {
    version: "0.9.0",
    exe: "a.exe",
    msi: "a.msi",
    "msi-analysis": "a.txt",
    "release-date": "2026-09-09",
    out: "winget",
  });
  assert.throws(
    () => parseArgs(argv.slice(0, -2)),
    /Missing required arguments: --out/,
  );
  assert.throws(
    () => parseArgs([...argv, "--bogus", "1"]),
    /Unknown argument --bogus/,
  );
  assert.throws(
    () => parseArgs([...argv, "--version"]),
    /Missing value for --version/,
  );
});

function fixtureRun() {
  const dir = mkdtempSync(join(tmpdir(), "winget-cli-"));
  const exe = join(dir, "setup.exe");
  const msi = join(dir, "setup.msi");
  const analysis = join(dir, "msi-analysis.txt");
  writeFileSync(exe, "nsis");
  writeFileSync(msi, "wix");
  writeFileSync(
    analysis,
    `InstallerType: wix\nProductCode: '${PRODUCT_CODE}'\n`,
  );
  const out = join(dir, "out");
  return {
    dir,
    out,
    argv: [
      "--version",
      "0.9.0",
      "--exe",
      exe,
      "--msi",
      msi,
      "--msi-analysis",
      analysis,
      "--release-date",
      "2026-09-09",
      "--out",
      out,
    ],
  };
}

test("main hashes the installers, reads the product code and writes the manifests", () => {
  const { out, argv } = fixtureRun();
  const logs = [];
  const dir = main(argv, { log: (line) => logs.push(line) });
  assert.equal(dir, join(out, "manifests", "h", "hegsie", "Gitnado", "0.9.0"));
  assert.equal(logs.at(-1), dir);
  const installer = readFileSync(
    join(dir, "hegsie.Gitnado.installer.yaml"),
    "utf8",
  );
  assert.match(installer, new RegExp(`InstallerSha256: ${sha256Of(argv[3])}`));
  assert.match(installer, new RegExp(`InstallerSha256: ${sha256Of(argv[5])}`));
  assert.match(
    installer,
    /ProductCode: '\{1A0C259A-26DF-403E-AAD3-DD086617E759\}'/,
  );
});

test("the script runs from the command line and prints the manifest directory last", () => {
  const { out, argv } = fixtureRun();
  const result = spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim().split("\n").at(-1),
    join(out, "manifests", "h", "hegsie", "Gitnado", "0.9.0"),
  );
  assert.deepEqual(
    readdirSync(
      join(out, "manifests", "h", "hegsie", "Gitnado", "0.9.0"),
    ).sort(),
    MANIFEST_FILES,
  );
});

test("the script fails with a clear message when the MSI analysis has no product code", () => {
  const { dir, argv } = fixtureRun();
  writeFileSync(join(dir, "msi-analysis.txt"), "InstallerType: wix\n");
  const result = spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No ProductCode found/);
});

test("publish-packages.yml renders the manifests with this script and submits them non-interactively", () => {
  assert.match(WORKFLOW, /node \.github\/scripts\/winget-manifests\.mjs/);
  assert.match(WORKFLOW, /komac analyze setup\.msi/);
  assert.match(WORKFLOW, /komac submit --yes/);
  // A comment may mention it; a run step must never invoke it.
  assert.doesNotMatch(
    WORKFLOW,
    /^\s*komac new\b/m,
    "komac new prompts and cannot run in CI",
  );
});

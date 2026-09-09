/**
 * Renders the winget manifests for one Gitnado release.
 *
 * Komac's `new` command is interactive by design (it always asks for install
 * modes and a handful of other fields, with no flag to preset them), so the
 * first submission of a package cannot run unattended. Instead the
 * publish-packages workflow renders the three manifests from the templates in
 * packaging/winget/ and hands the directory to `komac submit --yes`, which is
 * non-interactive.
 *
 * Everything here is pure or file-local so it can be unit tested; the workflow
 * supplies the downloaded installers and Komac's `analyze` output for the MSI.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_IDENTIFIER = "hegsie.Gitnado";

/** Directory holding `<manifest name>.template` files. */
export const TEMPLATE_DIR = fileURLToPath(
  new URL("../../packaging/winget/", import.meta.url),
);

const TEMPLATE_SUFFIX = ".template";
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

/** Every placeholder a template may use, with the shape its value must have. */
export const PLACEHOLDERS = {
  VERSION: /^\d+\.\d+\.\d+$/,
  RELEASE_DATE: /^\d{4}-\d{2}-\d{2}$/,
  EXE_SHA256: /^[0-9A-F]{64}$/,
  MSI_SHA256: /^[0-9A-F]{64}$/,
  MSI_PRODUCT_CODE: /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/,
};

/** Placeholders whose values winget expects upper-cased. */
const UPPERCASE = new Set(["EXE_SHA256", "MSI_SHA256", "MSI_PRODUCT_CODE"]);

/**
 * Path of a version's manifests inside winget-pkgs, e.g.
 * `manifests/h/hegsie/Gitnado/0.9.0`. `komac submit` is pointed at this
 * directory.
 */
export function manifestDir(version) {
  const [publisher, name] = PACKAGE_IDENTIFIER.split(".");
  return join(
    "manifests",
    publisher[0].toLowerCase(),
    publisher,
    name,
    version,
  );
}

/**
 * Trims, upper-cases where winget wants it, and validates every placeholder
 * value. Throws one error naming every problem so a bad run fails once.
 */
export function normalizeValues(input) {
  const values = {};
  const problems = [];
  for (const [name, pattern] of Object.entries(PLACEHOLDERS)) {
    let value = input[name];
    if (value === undefined || value === null || String(value).trim() === "") {
      problems.push(`${name} is missing`);
      continue;
    }
    value = String(value).trim();
    if (UPPERCASE.has(name)) value = value.toUpperCase();
    if (!pattern.test(value)) {
      problems.push(`${name} has unexpected value ${JSON.stringify(value)}`);
      continue;
    }
    values[name] = value;
  }
  if (problems.length > 0) {
    throw new Error(`Cannot render winget manifests: ${problems.join("; ")}`);
  }
  return values;
}

/** Replaces `{{NAME}}` placeholders; an unknown placeholder is an error. */
export function renderTemplate(template, values) {
  return template.replace(PLACEHOLDER, (match, name) => {
    if (!(name in values)) {
      throw new Error(`Template uses unknown placeholder ${match}`);
    }
    return values[name];
  });
}

/**
 * Renders every template in `templateDir`. Returns `{ fileName: content }`
 * keyed by the manifest file name (the template name minus `.template`).
 */
export function renderManifests(input, templateDir = TEMPLATE_DIR) {
  const values = normalizeValues(input);
  const templates = readdirSync(templateDir)
    .filter((name) => name.endsWith(TEMPLATE_SUFFIX))
    .sort();
  if (templates.length === 0) {
    throw new Error(`No ${TEMPLATE_SUFFIX} files found in ${templateDir}`);
  }
  const manifests = {};
  for (const templateName of templates) {
    const template = readFileSync(join(templateDir, templateName), "utf8");
    manifests[templateName.slice(0, -TEMPLATE_SUFFIX.length)] = renderTemplate(
      template,
      values,
    );
  }
  return manifests;
}

/**
 * Writes the rendered manifests under `outDir` at the winget-pkgs path for the
 * version. Returns the directory and the files written.
 */
export function writeManifests(input, outDir, templateDir = TEMPLATE_DIR) {
  const manifests = renderManifests(input, templateDir);
  const dir = join(outDir, manifestDir(normalizeValues(input).VERSION));
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [name, content] of Object.entries(manifests)) {
    const path = join(dir, name);
    writeFileSync(path, content);
    files.push(path);
  }
  return { dir, files };
}

/** Upper-case hex SHA-256 of a file, the form winget manifests use. */
export function sha256Of(path) {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")
    .toUpperCase();
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Reads the MSI ProductCode from `komac analyze <msi>` output. Tauri gives
 * every build a fresh ProductCode, so it has to come from the installer
 * itself; the UpgradeCode is pinned in tauri.conf.json and in the template.
 */
export function parseProductCode(analyzeOutput) {
  const match = analyzeOutput
    .replace(ANSI, "")
    .match(/^ProductCode:\s*'?(\{[0-9A-Fa-f-]{36}\})'?\s*$/m);
  if (!match) {
    throw new Error("No ProductCode found in komac analyze output");
  }
  return match[1].toUpperCase();
}

const CLI_OPTIONS = [
  "version",
  "exe",
  "msi",
  "msi-analysis",
  "release-date",
  "out",
];

/** Parses `--option value` pairs; every option is required. */
export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const name = flag.startsWith("--") ? flag.slice(2) : null;
    if (!name || !CLI_OPTIONS.includes(name)) {
      throw new Error(`Unknown argument ${flag}`);
    }
    if (i + 1 >= argv.length) {
      throw new Error(`Missing value for ${flag}`);
    }
    options[name] = argv[i + 1];
  }
  const missing = CLI_OPTIONS.filter((name) => !(name in options));
  if (missing.length > 0) {
    throw new Error(
      `Missing required arguments: ${missing.map((m) => `--${m}`).join(", ")}`,
    );
  }
  return options;
}

/**
 * CLI entry point. Usage:
 *
 *   node .github/scripts/winget-manifests.mjs \
 *     --version 0.9.0 --exe setup.exe --msi setup.msi \
 *     --msi-analysis msi-analysis.txt --release-date 2026-09-09 --out winget
 *
 * Prints the directory to pass to `komac submit`.
 */
export function main(argv, { log = console.log } = {}) {
  const options = parseArgs(argv);
  const { dir, files } = writeManifests(
    {
      VERSION: options.version,
      RELEASE_DATE: options["release-date"],
      EXE_SHA256: sha256Of(options.exe),
      MSI_SHA256: sha256Of(options.msi),
      MSI_PRODUCT_CODE: parseProductCode(
        readFileSync(options["msi-analysis"], "utf8"),
      ),
    },
    options.out,
  );
  for (const file of files) log(`Rendered ${file}`);
  log(dir);
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

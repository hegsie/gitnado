# Package Manager Distribution

Gitnado is delivered through package managers in addition to the direct
downloads on the [Releases](https://github.com/hegsie/gitnado/releases) page.
The [`publish-packages.yml`](../.github/workflows/publish-packages.yml)
workflow runs automatically whenever a release is published (moved out of
draft) and pushes the new version to each channel. It can also be re-run
manually from the Actions tab (workflow dispatch) with a release tag such as
`v0.8.0`, e.g. after fixing a one-time setup issue.

| Channel | Platform | Automation | One-time setup required |
|---------|----------|------------|-------------------------|
| winget | Windows | PR against `microsoft/winget-pkgs` via Komac | `WINGET_TOKEN` secret, fork of winget-pkgs |
| Homebrew | macOS (Apple Silicon) | Push to `hegsie/homebrew-gitnado` tap | Tap repository, `HOMEBREW_TAP_TOKEN` secret |
| Scoop | Windows | Commit to `packaging/scoop/gitnado.json` on `main` | None |
| AUR | Arch Linux | Community-maintained (`gitnado-bin`) | — |

Jobs whose secret is missing are skipped, not failed, so the workflow works
before every channel is set up.

## winget

The `winget` job opens a PR against
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) with the
`.exe` (NSIS) and `.msi` installers for every release, using manifests rendered
from the templates in this repository. Package identifier: `hegsie.Gitnado`.

One-time setup:

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) under
   the `hegsie` account (Komac pushes manifest branches to this fork).
2. Create a **classic** personal access token with the `public_repo` and
   `workflow` scopes and add it as the `WINGET_TOKEN` repository secret.
   `workflow` is needed because syncing the fork merges upstream commits that
   touch winget-pkgs' own `.github/workflows` files; without it GitHub
   rejects the sync with "refusing to allow a Personal Access Token to create
   or update workflow ... without `workflow` scope" (the v1.0.0 release hit
   this).
3. Nothing else. For each release the job first checks whether
   `manifests/h/hegsie/Gitnado/<version>` is already in winget-pkgs and skips
   with a notice if it is, so re-running an already-merged release does not
   open a duplicate PR. Otherwise it renders the three manifests from the templates in [`packaging/winget/`](../packaging/winget/)
   with [`.github/scripts/winget-manifests.mjs`](../.github/scripts/winget-manifests.mjs)
   (installer hashes from the downloaded assets, the MSI `ProductCode` from
   `komac analyze`, the release date from the GitHub release), syncs the
   winget-pkgs fork (Komac creates the PR branch from upstream's latest
   commit, and an out-of-date fork makes GitHub refuse with a misleading
   "permissions to execute CreateRef" error), and submits the directory with
   [Komac](https://github.com/russellbanks/Komac) `submit --yes`, which opens
   the "New package" or "New version" PR. `komac new` and `komac update` are
   not used: both regenerate the manifests themselves, and `komac new` always
   prompts for install modes. Releases up to 1.0.0 used
   [winget-releaser](https://github.com/vedantmgoyal9/winget-releaser) for
   updates, but it regenerates the manifests too and re-added the
   `DisplayVersion` and old schema that moderators had rejected, so each
   update PR needed a manual fix. Older versions are not pruned from
   winget-pkgs automatically (winget-releaser's `max-versions-to-keep` did
   that); remove them with `komac remove` if the list grows long.

Users install with `winget install hegsie.Gitnado`.

New-package PRs go through winget-pkgs moderation and typically take a few
days. The installer manifest declares `Microsoft.VCRedist.2015+.x64` and
`Microsoft.EdgeWebView2Runtime` as package dependencies: `gitnado.exe`
imports `MSVCP140.dll`, which only ships with the VC++ redistributable, so
without it the app exits with `STATUS_DLL_NOT_FOUND` on a clean Windows
install (this is what the winget validation sandbox hit on the first
submission). If the executable check still flags a
`Validation-Executable-Error`, a short comment on the PR explaining that the
app needs a desktop session helps the moderator. The `AppsAndFeaturesEntries`
deliberately omit `DisplayVersion`: moderators reject a value equal to
`PackageVersion` (the 0.9.1 review, microsoft/winget-pkgs#433064), and winget
uses `PackageVersion` when it is absent. The templates use manifest schema
1.28.0, which the 0.9.1 moderator review asked for; bump all three files
together when winget-pkgs moves to a newer schema.
If the Komac step ever fails, render the manifests locally with the same
script and submit them by hand: `node .github/scripts/winget-manifests.mjs
--version <v> --exe <exe> --msi <msi> --msi-analysis <komac analyze output>
--release-date <YYYY-MM-DD> --out winget`, then `komac submit winget/manifests/h/hegsie/Gitnado/<v>`
(or `wingetcreate submit` on Windows). The templates pin the NSIS
`ProductCode` (`Gitnado`, the uninstall registry key Tauri writes) and the
WiX `UpgradeCode` from `tauri.conf.json`; update them together if either
changes.

## Homebrew

The `homebrew` job downloads the release DMG, computes its SHA-256, renders
[`packaging/homebrew/gitnado.rb.template`](../packaging/homebrew/gitnado.rb.template)
and pushes the result to `Casks/gitnado.rb` in the
`hegsie/homebrew-gitnado` tap. Only Apple Silicon is published because CI
builds `aarch64-apple-darwin` only; the cask declares `depends_on arch: :arm64`.

One-time setup:

1. Create a public repository named `homebrew-gitnado` under the `hegsie`
   account (an empty repository with a README is enough; the workflow creates
   `Casks/gitnado.rb`).
2. Create a personal access token with write access to that repository
   (fine-grained with Contents read/write, or classic with `repo`) and add it
   as the `HOMEBREW_TAP_TOKEN` repository secret in the Gitnado repository.

Users install with `brew install --cask hegsie/gitnado/gitnado`.

## Scoop

[`packaging/scoop/gitnado.json`](../packaging/scoop/gitnado.json) is a
Scoop manifest that installs the MSI by extraction (`extract_dir:
"PFiles/Gitnado"`), the same pattern the Scoop Extras bucket uses for other
Tauri apps. The `scoop` job updates its version, URL, and hash on each release
and commits to `main` with `[skip ci]`. Until the first Gitnado release runs
that job the manifest points at the upcoming version and carries no `hash`
(Scoop installs with a warning); the workflow fills it in. No secret is needed — the default
`GITHUB_TOKEN` has `contents: write`. If branch protection on `main` blocks
pushes from `github-actions[bot]`, either allow it or replace the token with a
PAT.

Users install with:

```powershell
scoop install https://raw.githubusercontent.com/hegsie/gitnado/main/packaging/scoop/gitnado.json
```

Because Scoop extracts the MSI rather than running it, the WebView2 runtime
bootstrap never executes; the manifest's `notes` tell users where to get
WebView2 in the unlikely case it is missing. The manifest also carries
`checkver`/`autoupdate` metadata so it could be adopted into a community
bucket (e.g. Extras) unchanged.

## Assets must not change after publishing

Every channel records the SHA-256 of the assets at the moment the release is
published, so the assets must never be replaced afterwards. `build.yml`
therefore builds a release only from the manual dispatch that creates the
draft; publishing the draft creates the tag, and a tag push does not start
another build. (The v0.9.0 assets were rebuilt by a tag-push build minutes
after publishing, which left the winget submission with stale hashes.) If a
release ever needs different binaries, cut a new version instead.

## Release asset naming

The manifests and workflow depend on the Tauri bundle asset names staying
stable:

- `Gitnado_<version>_x64-setup.exe` (NSIS)
- `Gitnado_<version>_x64_en-US.msi` (WiX)
- `Gitnado_<version>_aarch64.dmg` (macOS)

If `productName`, bundle targets, or the Windows installer language in
`src-tauri/tauri.conf.json` change, update `publish-packages.yml`, the Scoop
manifest, and the Homebrew template together. The preflight job verifies these
assets exist on the release and fails early with a clear error if not.

## Future candidates

Not yet automated, in rough order of value: Chocolatey (needs a community
account and moderation), Flathub (needs a flatpak manifest and review), and
Snapcraft (needs a store account).

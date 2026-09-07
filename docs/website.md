# Website (gitnado.dev)

The landing page lives in [`site/`](../site) as plain static files (one HTML
page, a few assets, no build step) and is published to GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) whenever
`site/` changes on `main`. The page reads the latest release from the GitHub
API at load time to fill in version-specific download links, and falls back to
the Releases page if that request fails.

## One-time setup

1. **Enable Pages from Actions.** Repository *Settings → Pages → Build and
   deployment → Source: GitHub Actions*. Then run the "Deploy Website"
   workflow once (Actions tab → Run workflow) or merge a change under `site/`.
2. **Custom domain.** Still under *Settings → Pages*, set *Custom domain* to
   `gitnado.dev` and tick *Enforce HTTPS* once the certificate has been issued
   (`site/CNAME` carries the same value so a deploy never resets it).
3. **DNS for gitnado.dev** (apex domain), at your registrar or DNS host:

   | Type  | Name | Value |
   |-------|------|-------|
   | A     | `@`  | `185.199.108.153` |
   | A     | `@`  | `185.199.109.153` |
   | A     | `@`  | `185.199.110.153` |
   | A     | `@`  | `185.199.111.153` |
   | AAAA  | `@`  | `2606:50c0:8000::153` |
   | AAAA  | `@`  | `2606:50c0:8001::153` |
   | AAAA  | `@`  | `2606:50c0:8002::153` |
   | AAAA  | `@`  | `2606:50c0:8003::153` |
   | CNAME | `www` | `hegsie.github.io` |

   `.dev` is an HSTS-preloaded TLD, so the site only works over HTTPS — GitHub
   provisions the certificate automatically once the A records resolve
   (usually within an hour).
4. **gitnado.com and gitnado.app** — set a registrar-level (or Cloudflare)
   301 redirect to `https://gitnado.dev` for the apex and `www`. Nothing needs
   to be hosted there.

## Updating the page

Edit `site/index.html` and push to `main`. Assets:

- `site/assets/main-window.webp` — hero screenshot, generated from
  `docs/screenshots/main-window.png` (resized to 1600px wide, WebP quality
  82). Regenerate after the 0.9.0 release so the title bar shows *Gitnado*.
- `site/assets/icon-256.png`, `site/assets/favicon-64.png` — from
  `src-tauri/icons/icon.png`.

Download links are matched by asset-name suffix (`_aarch64.dmg`,
`_x64_en-US.msi`, `_x64-setup.exe`, `_amd64.deb`, `_amd64.AppImage`,
`.x86_64.rpm`); if the bundle naming changes, update the `groups` table in the
page's script alongside `publish-packages.yml`.

The `homepage` fields in `src-tauri/tauri.conf.json` (`bundle.homepage`),
`packaging/scoop/gitnado.json` and `packaging/homebrew/gitnado.rb.template`
already point at `https://gitnado.dev`; use the same URL for the winget
manifest's `PublisherUrl` / `PackageUrl` when submitting `hegsie.Gitnado`.

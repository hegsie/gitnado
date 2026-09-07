# Upgrading from Leviathan

Gitnado is the new name of Leviathan, as of 0.9.0. Same app, same code, same
signing key — only the name, icon and identifiers changed. This page lists what
that means for an existing installation and what, if anything, you need to do.

## What carries over automatically

On first launch, Gitnado adopts everything Leviathan stored, so you should not
notice a difference beyond the name and icon:

| Data | Where it lived | What happens |
|------|----------------|--------------|
| Settings, open repositories, workspaces, graph layout, keyboard shortcuts, recent commands, commit history | Browser storage under `leviathan-*` keys | Copied to `gitnado-*` keys before the UI loads; the old keys are removed |
| Profiles, workspaces, unified profiles | `<config dir>/leviathan/` | Directory renamed to `<config dir>/gitnado/` |
| Commit templates, bookmarks | `<data dir>/leviathan/` | Directory renamed to `<data dir>/gitnado/` |
| AI settings, MCP configuration, downloaded local models, embedding indexes | `…/io.github.hegsie.leviathan/` | Directory renamed to `…/io.github.hegsie.gitnado/` (no model re-download) |
| Per-repository rules — commit rules, branch rules, JIRA config, custom actions, Git Flow squash markers | `.git/leviathan/` | Renamed to `.git/gitnado/` the first time the repository is opened |
| Stored git credentials and integration tokens | OS keychain, service `leviathan-git` / `leviathan-integrations` | Read from the old entry on first use, re-stored under the new name, old entry removed |
| OAuth callback deep links | `leviathan://oauth/…` | Still accepted; `gitnado://` is the new scheme |

A directory is only adopted when the new one does not exist yet, so running an
older Leviathan build afterwards will not see the migrated data — that is the
one thing that does not round-trip.

## Installing the new version

- **Windows (MSI):** the Gitnado MSI carries the same upgrade code as
  Leviathan's, so installing it upgrades the existing install in place.
- **Windows (NSIS `.exe`):** the installer is registered under the new name.
  Uninstall Leviathan from *Apps & features* after installing Gitnado — your
  data is not in the install directory, so nothing is lost.
- **macOS:** drag `Gitnado.app` to Applications and delete `Leviathan.app`.
  The in-app updater on Leviathan 0.8.x still points at the old release URL,
  which GitHub redirects to the renamed repository, so it will offer 0.9.0 —
  but the bundle keeps the old file name until you replace it manually.
- **Linux (`.deb` / `.rpm`):** the package name changed, so install `gitnado`
  and remove `leviathan` with your package manager. AppImage users just
  download the new file.
- **Package managers:** `winget install hegsie.Gitnado`,
  `brew install --cask hegsie/gitnado/gitnado`, or the Scoop manifest — see
  the README. The community AUR package is still called `leviathan-bin` until
  its maintainer renames it.

## For integrators

- Environment variables the app sets for git credential helpers are now
  `GITNADO_GIT_TOKEN` / `GITNADO_CLONE_TOKEN` (previously `LEVIATHAN_*`).
- The HTTP `User-Agent` sent to GitHub/GitLab APIs is `Gitnado-Git-Client`.
- The MCP server identifies itself as `gitnado`; the suggested client config
  key in Settings changed accordingly, but any name you chose in your own MCP
  client config keeps working.
- Undo/redo markers in a repository's git config moved from `leviathan.*` to
  `gitnado.*`; an in-flight redo from a Leviathan session is not carried over.

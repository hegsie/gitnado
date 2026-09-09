# Icons

Two masters, because macOS lays icons out differently from everyone else.

| Master                  | Shape                          | Drives                                                     |
| ----------------------- | ------------------------------ | ---------------------------------------------------------- |
| `icon-source.png`       | full-bleed 1024×1024 tile      | `icon.ico`, `icon.png`, the Linux PNGs, `Square*Logo.png`, `android/`, `ios/`, and the website assets in `site/assets/` |
| `icon-source-macos.png` | the same art on Apple's grid   | `icon.icns` only                                            |

## Why macOS needs its own master

macOS draws no frame around an app icon — the icon *is* the frame. Apple's
icon grid reserves a transparent margin for that: on a 1024×1024 canvas the
rounded-square body is 824×824, centred, leaving 100px (9.77%) of empty canvas
on every side. The Dock, Launchpad, the Finder and the app switcher all lay
icons out on that grid.

A full-bleed tile in `icon.icns` renders about a fifth larger than every
neighbour, overflows the Dock's tile, and has its corners shaved by the
system's own rounding — the icon looks cut off.

Windows, Linux and the website composite their own shape (or want a square
hero image), so those keep the full-bleed master. `scripts/icon-safe-area.mjs`
and its test hold both halves of that split in place; they run as part of
`npm test`.

## Regenerating

`tauri icon` rewrites the whole directory from whichever master you hand it,
so generate into a scratch directory and copy back only what that master owns.

```bash
# Windows / Linux / mobile / website — everything except icon.icns
npx tauri icon src-tauri/icons/icon-source.png -o /tmp/icons-full
cp /tmp/icons-full/{icon.ico,icon.png,32x32.png,64x64.png,128x128.png,128x128@2x.png} src-tauri/icons/
cp /tmp/icons-full/{Square*Logo.png,StoreLogo.png} src-tauri/icons/
cp -r /tmp/icons-full/{android,ios} src-tauri/icons/

# macOS
npx tauri icon src-tauri/icons/icon-source-macos.png -o /tmp/icons-macos
cp /tmp/icons-macos/icon.icns src-tauri/icons/

npm run test:contract   # verifies both margins
```

`icon-source-macos.png` is `icon-source.png` scaled to 824×824 and centred on
a transparent 1024×1024 canvas — nothing else changes, and the tile's corner
radius (22.1% of its own width) already matches Apple's rounding closely
enough that no reshaping is needed.

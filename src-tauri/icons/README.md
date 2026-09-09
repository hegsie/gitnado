# Icons

One art master, one build. `icon-source.png` is the full-bleed 1024×1024
tile; everything else in this directory (and the website's icons in
`site/assets/`) is written from it by

```bash
npm run icons:build      # node scripts/build-icons.mjs
npm run test:contract    # rebuilds and checks the committed files match
```

Do not run `tauri icon` over this directory: it resizes and nothing more,
and the contract test will fail on every file it touches. The `android/` and
`ios/` sets are the exception — Gitnado ships no mobile build, they are left
as `tauri icon` made them, and the build does not touch them.

## What the build does that a plain resize does not

- **macOS gets Apple's safe area.** macOS draws no frame around an app icon;
  the icon *is* the frame, and Apple's grid reserves a transparent margin for
  it — an 824×824 body centred on a 1024×1024 canvas, 100px (9.77%) per
  side — with a soft shadow beneath. The Dock, Launchpad, the Finder and the
  app switcher all lay icons out on that grid. A full-bleed tile in
  `icon.icns` renders about a fifth larger than every neighbour and overflows
  its Dock slot: the icon looks cut off. Only `icon.icns` gets the margin;
  Windows, Linux and the website composite their own shape (and the site
  wants a square hero) and would draw a padded tile undersized.
- **Premultiplied resampling.** The colour under the tile's transparent
  corners is dark navy, so a straight resize drags it into the corner
  anti-aliasing — a dark fringe on light desktops.
- **Sharpening at 64px and below.** Windows taskbar and Explorer (16–48px),
  Linux trays and Finder list view are where the tornado's thin strokes turn
  to mush without it.
- **A touch more saturation and contrast, and a light rim** in the tornado's
  own cyan along the tile edge, so the dark tile has an outline against dark
  docks and taskbars. Parameters live at the top of `scripts/build-icons.mjs`.
- **Every size Windows asks for** in `icon.ico` (16, 20, 24, 32, 40, 48, 64,
  256), so the shell scales nothing it does not have to.

## Who reads what

| File(s)                                        | Read by                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `icon.icns`                                    | macOS: Dock, Finder, app switcher, DMG, About                       |
| `32x32.png`                                    | macOS menu-bar tray icon (`default_window_icon`); Linux             |
| `128x128.png`, `128x128@2x.png`, `icon.png`    | Linux hicolor icons (128, 256, 512) in AppImage/deb/rpm, via `bundle.icon` |
| `icon.ico`                                     | Windows: taskbar, Explorer, installer; entry 0 (32px) is the window and tray icon |
| `Square*Logo.png`, `StoreLogo.png`             | Windows Store/MSIX tiles — no current bundle target reads them; kept current so nothing here carries the old art |
| `site/assets/{favicon-64,icon-256,icon-512}`   | the website                                                         |
| `src/assets/mascot/gitnado-400.png`            | the in-app welcome screen — hand-made, not part of the build        |

# HarnessDesk brand assets

Everything in `svgs/` is a true vector: Bézier curves for the whale, the brain
lobes and the circuit traces, exact rectangles for the pixel blocks, and exact
circles for the eye and the node rings. They render crisp at any size.

| File | What it is |
| --- | --- |
| `svgs/harnessdesk-icon-black-transparent.svg` | The mark, black on transparent — for light surfaces |
| `svgs/harnessdesk-icon-white-transparent.svg` | The mark, white on transparent — for dark surfaces |
| `svgs/harnessdesk-icon-blue-transparent.svg` | The mark in Blueprint's blue — for surfaces that speak that palette, never the identity |
| `svgs/harnessdesk-app-icon-light.svg` | App icon, light: black mark, transparent background |
| `svgs/harnessdesk-app-icon-dark.svg` | App icon, dark: white mark, transparent background |
| `svgs/harnessdesk-dock-icon-light.svg` | macOS Dock/bundle icon, light: black mark on a white plate |
| `svgs/harnessdesk-dock-icon-dark.svg` | macOS Dock/bundle icon, dark: white mark on a near-black plate |
| `svgs/harnessdesk-menubar-template.svg` | Menu-bar status item: the mark cropped tight, black (macOS recolours template images) |

All seven share a 1024×1024 viewBox. Five are transparent — the three
`-transparent` marks and the two `-app-icon-*` files — so they drop into any
app or document without bringing a colour with them; that's deliberate, not a
gap to fill in. The two `-dock-icon-*` files are the exception, because a
macOS app icon has to arrive complete.

## What blue is, and is not

The identity is black. On a light surface the mark is black; on a dark one it
is white; documentation, the site and the social preview use those two files
and nothing else — the README carries both in a `<picture>` so GitHub picks
the right one. Blue is the app's default *palette* — Blueprint, one of two in
Settings → Appearance — and `-blue-transparent` exists for a surface that
speaks that palette, the way a screenshot of the default theme does. A new
surface reaching for the blue mark as "the brand" has read this file too
late.

## What macOS does *not* do for an app icon

It does not round your artwork, resize it, or give it a shadow. A legacy
`.icns` is composited exactly as authored, so anything that makes an icon look
native has to be in the image. Measured across the 37 stock icons in
`/System/Applications` (see the alpha profile of `Notes.app`'s icon):

- **The plate is drawn by the app.** 36 of 37 have a fully transparent corner
  pixel — every one of them draws its own rounded rectangle. Only `Phone.app`
  is full-bleed, because it ships the macOS 26 Icon Composer format, where the
  system *does* apply the mask. We ship `.icns`, so we draw the plate.
- **The plate is 824 of the 1024 canvas** (80.5%) — Apple's icon grid, with
  continuous-curvature (superellipse) corners, not circular ones.
- **The shadow is drawn by the app too.** Outside the plate the stock icons
  ramp alpha up to about 8% over ~10 px (at 256), offset slightly downward.
  Measuring the *opaque bounding box* of a stock icon therefore reports ~87.5%
  and tempts you to enlarge the plate to match — that is the shadow, not the
  plate. Don't chase it; match the ramp instead.

`-dock-icon-*` carry the plate and that shadow; `-app-icon-*` carry neither,
since they get composited onto a surface the caller already draws. Both share
the same mark path, so only the plate, shadow and mark scale differ.

## Building the app's rasters

```bash
pnpm run icons
```

renders everything the desktop app needs from these SVGs:

- `packages/desktop/build/icon.icns` (light, the one `electron-builder` ships)
  and `icon-dark.icns` — the bundle icon;
- `packages/desktop/electron/assets/trayTemplate.png` and `@2x` — the menu-bar
  status item, 18 pt tall, as a template image;
- `packages/desktop/electron/assets/mark.svg` — the mark for the app's own About
  window, where it is drawn as a CSS mask so it follows light and dark;
- `packages/desktop/electron/assets/dockIcon.png` — the same face as `icon.icns`,
  as a raster, for the one moment the shell has to hand the Dock its own icon
  back (see below);
- `faces/384/*.png` and `faces/128/*.png` — the mark's colourways, the faces
  someone can wear instead of a whale.

Needs `rsvg-convert` (`brew install librsvg`); `iconutil` ships with macOS. The
rendered files are checked in so a build machine does not need librsvg.

There is no separate development Dock icon. The shell used to set one from a
rendered PNG, which made macOS draw the artwork verbatim — a flat plate with
corners rounder than anything else in the Dock — while macOS 26 shapes an app
icon itself from the bundle. So `script/brand-dev-electron.mjs` copies
`icon.icns` into the Electron bundle `electron .` runs out of (and names it),
and the About window draws `mark.svg` as a CSS mask so it follows the theme.
Both faces now come from the same two files as the packaged app's.

The shell does set one icon at runtime, and only one: the face you pick, and the
app's own face again when you clear it. That last one cannot come from
`icon.icns` — Chromium has no .icns decoder and reads it as an empty image, so
the reset used to do nothing at all — which is what `dockIcon.png` is for. It is
the .icns's own 512 slot, to the pixel. On macOS 26 the tile differs from the
bundle icon by the corner curve LaunchServices applies to a legacy icon, until
the app is next launched and the Dock reads the bundle again.

## The mark as a face

Settings › You offers the whales in `assets/avatars` and, before them, the app's
own face in six colourways — paper, ink, steel, blueprint, blueline, and the
mark with no plate at all. Whichever is chosen goes on the seat *and* on the
Dock, so they are cut the way an app icon is cut: this same plate on the same
824-of-1024 grid, with the same baked shadow. Full-bleed artwork would read fine
in the picker and arrive on the Dock as the one hard-edged square in the row.

Every one is generated from `harnessdesk-dock-icon-light.svg` with its plate and
its ink swapped, and the swapped-in colours are read back out of the files above
— the near-black from the dark dock icon, the blue from the blue mark — so a
recolour here carries to all six. Nothing is a hand-kept copy of the mark.

The one that carries no plate takes the blue: a PNG cannot follow the theme, and
blue is the one ink that holds on a light surface and a dark one. It is the same
reason the black whale is not in the picker.

## Provenance

The mark was drawn as a 1254 px bitmap. The vector was produced once by tracing
that bitmap with `potrace` (curve fitting, 4× supersampled), then replacing the
five detached pixel squares with exact 43 px rectangles and the eye and ring
holes with exact circles. Against the bitmap, the vector differs by ~1,900 of
1.57 M pixels — anti-aliasing noise. The SVGs are now the source of truth; edit
them, not a bitmap.

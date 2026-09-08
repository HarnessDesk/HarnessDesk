// Renders every raster the desktop app needs from the vector sources in assets/brand/svgs.
//
//   pnpm run icons
//
// Needs `rsvg-convert` (brew install librsvg) and macOS `iconutil`. The SVGs are the
// source of truth; the rendered files are checked in so `pnpm dist` works without
// librsvg installed.
//
//   packages/desktop/build/icon.icns, icon-dark.icns   bundle icon (electron-builder)
//   packages/desktop/electron/assets/trayTemplate*.png menu-bar status item (template image)
//   packages/desktop/electron/assets/mark.svg          the About window's mark (masked with currentColor)
//   packages/desktop/electron/assets/menu/*.png        the status item's menu: Lucide glyphs, template images
//   packages/desktop/electron/assets/brands/*.png      the same menu's agent rows: their makers' marks
//   packages/ui/src/assets/brand/mark.svg              the renderer's mark, inlined by BrandIcons
//
// The bundle icon renders from harnessdesk-dock-icon-*.svg (mark on its own plate —
// nothing else draws a background behind a Dock or Finder icon), and it is the only icon
// the Dock ever shows: development runs out of node_modules' Electron.app, which
// script/brand-dev-electron.mjs points at this same .icns. Everything else renders from
// the *-transparent marks or harnessdesk-app-icon-*.svg, which stay transparent on
// purpose: those get composited onto a surface the caller already draws.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { brandsIn } from './brands.mjs'

const root = resolve(import.meta.dirname, '..')
const svgs = join(root, 'assets/brand/svgs')
const buildDir = join(root, 'packages/desktop/build')
const assetsDir = join(root, 'packages/desktop/electron/assets')
const uiBrandDir = join(root, 'packages/ui/src/assets/brand')
mkdirSync(buildDir, { recursive: true })
mkdirSync(assetsDir, { recursive: true })
mkdirSync(uiBrandDir, { recursive: true })

const render = (svg, width, height, out) =>
  execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), join(svgs, svg), '-o', out])

/** The same, for a vector that is a string rather than a file in `assets/brand/svgs`. */
const renderSource = (source, size, out) => {
  const work = mkdtempSync(join(tmpdir(), 'harnessdesk-glyph-'))
  const file = join(work, 'glyph.svg')
  writeFileSync(file, source)
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), file, '-o', out])
  rmSync(work, { recursive: true, force: true })
}

// --- .icns bundle icons
const icons = [
  { svg: 'harnessdesk-dock-icon-light.svg', icns: 'icon.icns' },
  { svg: 'harnessdesk-dock-icon-dark.svg', icns: 'icon-dark.icns' },
]
// iconutil wants exactly these names; each @2x is the same point size at double pixels.
const slots = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
]
for (const { svg, icns } of icons) {
  const work = mkdtempSync(join(tmpdir(), 'harnessdesk-icon-'))
  const iconset = join(work, 'icon.iconset')
  mkdirSync(iconset)
  for (const [name, px] of slots) render(svg, px, px, join(iconset, name))
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, icns)])
  rmSync(work, { recursive: true, force: true })
  console.log(`${svg} -> packages/desktop/build/${icns}`)
}

// --- Menu-bar status item. A template image is black + alpha; macOS recolours it for
// light and dark menu bars and for the highlighted state. 18pt tall, the menu-bar norm.
render('harnessdesk-menubar-template.svg', 25, 18, join(assetsDir, 'trayTemplate.png'))
render('harnessdesk-menubar-template.svg', 50, 36, join(assetsDir, 'trayTemplate@2x.png'))
console.log('harnessdesk-menubar-template.svg -> packages/desktop/electron/assets/trayTemplate{,@2x}.png')

// --- About window: the mark as an SVG mask, so it takes the text colour in light and dark.
copyFileSync(join(svgs, 'harnessdesk-icon-black-transparent.svg'), join(assetsDir, 'mark.svg'))
console.log('harnessdesk-icon-black-transparent.svg -> packages/desktop/electron/assets/mark.svg')

// --- the renderer's mark. The interface draws every brand on `currentColor` at
// one size, so ours arrives the same way rather than as a black shape that has
// to be special-cased in dark mode. The tight menu-bar crop is the one to take:
// the app-icon versions carries padding meant for a plate nothing draws here.
const markSource = readFileSync(join(svgs, 'harnessdesk-menubar-template.svg'), 'utf8')
writeFileSync(
  join(uiBrandDir, 'mark.svg'),
  markSource
    .replace(/<title>[^<]*<\/title>\s*/, '')
    .replaceAll('fill="#000000"', 'fill="currentColor"'),
)
console.log('harnessdesk-menubar-template.svg -> packages/ui/src/assets/brand/mark.svg')

// --- The status item's menu.
//
// A macOS menu item can carry an image beside its label, and it has to be a
// raster: `nativeImage` has no SVG decoder, and the shell has no build step of
// its own. So the glyphs are rendered here, from the same two collections the
// interface draws from — Lucide for actions, lobe-icons for the makers — and
// checked in beside the app.
//
// Every one is a *template* image: black plus alpha, which macOS recolours for
// a light or dark menu and inverts under the highlight. That is also why a
// brand mark loses its colours here and appears as its silhouette; a menu full
// of little logos in full colour is a menu nobody can read at a glance.
const menuDir = join(assetsDir, 'menu')
const brandsDir = join(assetsDir, 'brands')
mkdirSync(menuDir, { recursive: true })
mkdirSync(brandsDir, { recursive: true })

/** 16pt is the size a menu item's image is drawn at; @2x is the same in pixels doubled. */
const MENU_SIZES = [
  ['', 16],
  ['@2x', 32],
]

const uiRequire = createRequire(join(root, 'packages/ui/package.json'))

/**
 * A Lucide icon, as its own SVG.
 *
 * `lucide-react` ships each icon as the array the component is built from, so
 * the geometry is read from there rather than copied into this file: the app's
 * glyph and the menu's glyph are then the same drawing, and stay the same
 * drawing across a Lucide upgrade.
 */
const lucide = (name) => {
  const file = readFileSync(uiRequire.resolve(`lucide-react/dist/esm/icons/${name}.mjs`), 'utf8')
  const body = /const __iconNode = (\[[\s\S]*?\n\]);/.exec(file)?.[1]
  if (!body) throw new Error(`lucide: cannot read ${name}`)
  // The array is JavaScript — bare keys, and Prettier wraps the long entries
  // over several lines — so it is quoted into JSON rather than read by hand.
  const nodes = JSON.parse(body.replace(/(\w+):/g, '"$1":'))
  const elements = nodes.map(
    ([tag, attributes]) =>
      `<${tag} ${Object.entries(attributes)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ')}/>`,
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${elements.join('')}</svg>`
}

/** Menu row -> the glyph the interface already uses for that action. */
const MENU_GLYPHS = {
  'new-session': 'plus',
  'open-folder': 'folder',
  usage: 'gauge',
  settings: 'sliders-horizontal',
  show: 'monitor',
  quit: 'log-out',
}

// An agent's row is drawn with its maker's mark, not a glyph: the row names one
// agent, and the mark is what names it everywhere else in the app.

for (const [row, name] of Object.entries(MENU_GLYPHS)) {
  const source = lucide(name)
  for (const [suffix, px] of MENU_SIZES) renderSource(source, px, join(menuDir, `${row}${suffix}.png`))
}
console.log(`lucide -> packages/desktop/electron/assets/menu/*.png (${Object.keys(MENU_GLYPHS).length} glyphs)`)

// Ours, for the row that is about the app itself. Square here rather than the
// menu-bar crop: it sits in a column of 16pt squares.
for (const [suffix, px] of MENU_SIZES) {
  render('harnessdesk-icon-black-transparent.svg', px, px, join(menuDir, `about${suffix}.png`))
}
console.log('harnessdesk-icon-black-transparent.svg -> packages/desktop/electron/assets/menu/about{,@2x}.png')

/**
 * Every mark the interface can draw beside an agent, read out of `brands.ts`
 * rather than listed again here — for the same reason the Lucide glyphs above
 * are read out of `lucide-react`: the menu and the interface have to name an
 * agent with the same drawing, and a second copy of the list is a second thing
 * to forget. It used to be a copy, and the copy is what left a row with a
 * generic robot beside a name the app itself drew a logo for.
 *
 * The whole list, not the agents half: `brandForRuntime` returns whatever a
 * runtime *declares*, and a hand-written `agents.json` row may declare any key
 * in it. Models never get a menu row, but their marks cost a kilobyte and
 * being a total function costs nothing.
 *
 * The parser is `script/brands.mjs`, and tested there. The floor is the count
 * at the time of writing, and catches a block match that stopped early; lower
 * it only when the list is deliberately cut.
 */
const AGENT_BRANDS = brandsIn(readFileSync(join(root, 'packages/ui/src/lib/brands.ts'), 'utf8'), 47)

for (const brand of AGENT_BRANDS) {
  const source = readFileSync(uiRequire.resolve(`@lobehub/icons-static-svg/icons/${brand}.svg`), 'utf8')
  for (const [suffix, px] of MENU_SIZES) renderSource(source, px, join(brandsDir, `${brand}${suffix}.png`))
}
console.log(`lobe-icons -> packages/desktop/electron/assets/brands/*.png (${AGENT_BRANDS.length} marks)`)

// The agent with no mark of ours, and the row that has to draw something.
for (const [suffix, px] of MENU_SIZES) renderSource(lucide('bot'), px, join(brandsDir, `agent${suffix}.png`))
console.log('lucide bot -> packages/desktop/electron/assets/brands/agent{,@2x}.png')

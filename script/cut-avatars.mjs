// Cuts the avatars out of the sheets in assets/avatars/source.
//
//   pnpm run avatars
//
// Needs ImageMagick 7 (`brew install imagemagick`). The rendered PNGs are checked in,
// so no build depends on having it.
//
// A sheet arrives as one 1536x1024 image: twelve whales on a rough 4x3 grid, a faint
// coloured haze lying over the transparent background, and no two whales quite the same
// size. All three facts are measured out of the pixels here rather than typed in as
// rectangles, because hand-typed rectangles are wrong the first time a sheet is
// regenerated — and there is more than one sheet:
//
//   1. Alpha below ALPHA_FLOOR is that haze, not artwork — 3% of a sheet at an alpha
//      of 1 to 7, invisible on any surface but enough to make every bounding box the
//      size of its whole cell. It is thresholded away before anything is measured.
//   2. Fully transparent columns and rows are what separate the cells. Finding the runs
//      of them defines the grid; the sheets are not on an exact 384x341 pitch, and no
//      two of them share one.
//   3. Inside a cell, a row or column carrying at least BAND of that cell's peak is the
//      whale itself — a crown, a snowflake or a cloud never is. Each whale is centred
//      and scaled on that band, so whales drawn at every size leave here at one size,
//      with their furniture free to spill into the margin. A whale whose furniture
//      would then clip is scaled down until it fits instead: nothing is ever cropped.
//
// BODY is what holds the sheets together: every whale leaves at the same optical size
// whichever sheet it was drawn on, so a row mixing the two does not look like two sets.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dir = join(root, 'assets/avatars')

const ALPHA_FLOOR = 8 // 0-255; below this it is the generator's haze
const BAND = 0.3 // share of a cell's peak that still counts as the whale
const MIN_GAP = 8 // transparent columns/rows that count as a separator
const TILE = 384 // the master, and a sheet's own resolution for one whale
const MARGIN = 10 // art never comes closer than this to a tile edge
const BODY = 270 // every whale leaves at this sqrt(w*h), in tile pixels
const PREVIEW = 96 // contact-sheet tile: costumes still readable, sheet still small
const SIZES = [384, 128, 64] // native master, @3x of the app's largest avatar, @2x of it

// Names in grid order, left to right and top to bottom. On the first sheet the opening
// three are the mark in a colour and nothing else, and the rest of both sheets are
// wearing a job. `ninja` and `shinobi` are the same job on two sheets — red and purple.
const SHEETS = [
  {
    file: 'avatars-sheet-1.png',
    names: [
      'black', 'blue', 'violet', 'reviewer',
      'guardian', 'builder', 'scout', 'lead',
      'astronaut', 'ninja', 'sprout', 'party',
    ],
  },
  {
    file: 'avatars-sheet-2.png',
    names: [
      'wizard', 'samurai', 'winter', 'dj',
      'chef', 'scientist', 'pilot', 'shinobi',
      'cowboy', 'alien', 'knight', 'beach',
    ],
  },
]

const magick = (args) => execFileSync('magick', args, { maxBuffer: 1 << 28 })

/** The spans of `counts` that carry artwork, split on runs of MIN_GAP empty ones. */
const bands = (counts) => {
  const out = []
  let start = null
  let gap = 0
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] > 0) {
      if (start === null) start = i
      gap = 0
    } else if (start !== null) {
      gap += 1
      if (gap >= MIN_GAP) {
        out.push([start, i - gap])
        start = null
      }
    }
  }
  if (start !== null) out.push([start, counts.length - 1])
  return out
}

const cut = ({ file, names }) => {
  const sheet = join(dir, 'source', file)
  const [width, height] = magick(['identify', '-format', '%w %h', sheet]).toString().split(' ').map(Number)
  // One byte of alpha per pixel: small enough to hold, and the only channel that
  // matters for finding where the artwork is.
  const alpha = magick([sheet, '-alpha', 'extract', '-depth', '8', 'gray:-'])
  const opaque = (x, y) => alpha[y * width + x] >= ALPHA_FLOOR

  // --- the grid
  const colCount = new Array(width).fill(0)
  const rowCount = new Array(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (opaque(x, y)) {
        colCount[x] += 1
        rowCount[y] += 1
      }
    }
  }
  const columns = bands(colCount)
  const rows = bands(rowCount)
  if (columns.length * rows.length !== names.length) {
    throw new Error(`${file} reads as ${columns.length}x${rows.length} cells, expected 4x3 for ${names.length} avatars`)
  }

  /** Where the artwork is in one cell, and which part of it is the whale. */
  const measure = ([x0, x1], [y0, y1]) => {
    const cols = new Array(x1 - x0 + 1).fill(0)
    const rowsIn = []
    let fx0 = Infinity, fy0 = Infinity, fx1 = -1, fy1 = -1
    for (let y = y0; y <= y1; y += 1) {
      let n = 0
      for (let x = x0; x <= x1; x += 1) {
        if (!opaque(x, y)) continue
        n += 1
        cols[x - x0] += 1
        if (x < fx0) fx0 = x
        if (x > fx1) fx1 = x
        if (y < fy0) fy0 = y
        if (y > fy1) fy1 = y
      }
      rowsIn.push(n)
    }
    const span = (counts, offset) => {
      const floor = BAND * Math.max(...counts)
      const hit = counts.flatMap((n, i) => (n >= floor ? [i] : []))
      return [offset + hit[0], offset + hit[hit.length - 1]]
    }
    const [bx0, bx1] = span(cols, x0)
    const [by0, by1] = span(rowsIn, y0)
    return { cell: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], full: [fx0, fy0, fx1, fy1], body: [bx0, by0, bx1, by1] }
  }

  // --- the cut
  console.log(file)
  rows.forEach((rowBand, r) => {
    columns.forEach((colBand, c) => {
      const name = names[r * columns.length + c]
      const { cell: [x0, y0, cw, ch], full: [fx0, fy0, fx1, fy1], body: [bx0, by0, bx1, by1] } = measure(colBand, rowBand)
      const cx = (bx0 + bx1) / 2
      const cy = (by0 + by1) / 2
      const reach = Math.max(cx - fx0, fx1 - cx, cy - fy0, fy1 - cy)
      const wanted = BODY / Math.sqrt((bx1 - bx0 + 1) * (by1 - by0 + 1))
      const fits = (TILE / 2 - MARGIN) / reach
      const scale = Math.min(wanted, fits)
      const sw = Math.round(cw * scale)
      const sh = Math.round(ch * scale)
      const dx = Math.round(TILE / 2 - (cx - x0) * scale)
      const dy = Math.round(TILE / 2 - (cy - y0) * scale)

      const master = join(dir, `${TILE}/${name}.png`)
      magick([
        sheet,
        '-crop', `${cw}x${ch}+${x0}+${y0}`, '+repage',
        // Haze to nothing, and the artwork — which tops out at an alpha of 254 — to solid.
        '-channel', 'A', '-level', '3%,99.5%', '+channel',
        // Plain -resize, deliberately: IM7 already weights the resample by alpha. The
        // documented `-alpha associate … disassociate` pair does not round-trip here — it
        // leaves the colour premultiplied, which is a dark halo on every light surface
        // (4% RMSE against compositing the sheet first, where this measures 0.14%) — and
        // on the reductions below it flattens the alpha channel away entirely.
        '-filter', 'Lanczos', '-resize', `${sw}x${sh}!`,
        '-background', 'none', '-extent', `${TILE}x${TILE}-${dx}-${dy}`,
        '-strip', '-define', 'png:color-type=6', '-define', 'png:compression-level=9',
        master,
      ])
      for (const size of SIZES.filter((s) => s !== TILE)) {
        magick([
          master,
          '-filter', 'Lanczos', '-resize', `${size}x${size}`,
          '-strip', '-define', 'png:color-type=6', '-define', 'png:compression-level=9',
          join(dir, `${size}/${name}.png`),
        ])
      }
      const capped = fits < wanted ? '  (scaled to fit its furniture)' : ''
      console.log(`  ${name.padEnd(10)} scale ${scale.toFixed(3)}  margin ${(TILE / 2 - reach * scale).toFixed(0)}px${capped}`)
    })
  })
}

for (const size of SIZES) mkdirSync(join(dir, String(size)), { recursive: true })
SHEETS.forEach(cut)

// --- the contact sheet
// A folder of seventy-two files does not show anyone the set, and the one thing a reader
// has to see before picking a face is that `black` has nothing to say on a dark surface.
// So the preview is two bands, light over dark, one sheet per row within each, in grid
// order rather than the alphabetical order the folder lists them in.
const all = SHEETS.flatMap((sheet) => sheet.names)
const work = mkdtempSync(join(tmpdir(), 'harnessdesk-avatars-'))
const band = (background) => {
  const raw = join(work, 'band-raw.png')
  const out = join(work, `band-${background.replace('#', '')}.png`)
  magick(['montage', ...all.map((n) => join(dir, `128/${n}.png`)),
    '-tile', `${all.length / SHEETS.length}x${SHEETS.length}`, '-geometry', `${PREVIEW}x${PREVIEW}+6+6`,
    '-background', background, `png32:${raw}`])
  magick([raw, '-background', background, '-flatten', out])
  return out
}
// A palette, and no dithering, for the preview alone: it is documentation rather than
// an asset, and at this size 255 flat colours are indistinguishable from the full set
// (1.4% RMSE) at a sixth of the bytes. The avatars themselves are never quantised.
magick([band('white'), band('#16181d'), '-append', '-strip',
  '-dither', 'None', '-colors', '255',
  '-define', 'png:compression-level=9', `PNG8:${join(dir, 'preview.png')}`])
rmSync(work, { recursive: true, force: true })

console.log(`\n${all.length} avatars at ${SIZES.join(', ')} px, and preview.png -> assets/avatars`)

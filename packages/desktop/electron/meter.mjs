/*
 * The meter a tray row draws next to an agent's mark.
 *
 * Electron hands a menu item a raster and nothing else — there is no
 * `NSMenuItem.view` on this side of the bridge — so a bar in the menu has to
 * be pixels we drew ourselves. This module is the drawing, kept free of
 * Electron so it can be read and tested as arithmetic.
 *
 * It draws no colour at all: every pixel is black, and the shape lives in the
 * alpha. The result is a **template image**, which macOS tints to the menu's
 * own appearance, dims on a disabled row, and inverts under the highlight.
 *
 * That is not a simplification, it is the only correct answer. A status item's
 * menu follows the *system* appearance, and an app whose theme is set to Dark
 * on a Light Mac still gets a light menu — `nativeTheme.themeSource` does not
 * reach it, and on macOS `shouldUseDarkColorsForSystemIntegratedUI` is
 * documented to be no more than a copy of `shouldUseDarkColors`. So the shell
 * cannot learn which appearance its own menu is about to use, and any palette
 * it was handed would be wrong for whoever set those two apart: a near-black
 * track painted across a white menu. A mask cannot be wrong.
 *
 * The cost is tone. Amber and red stay on the header strip, where the bar is
 * all there is; a menu row says "12% left, resets in 4d" in words beside it.
 */

import { deflateSync } from 'node:zlib'

/*
 * Geometry.
 *
 * The height and the radius are the header strip's own (`PlanMeters.module.css`
 * — a 5px track, fully rounded), because the status item answers the question
 * the strip answers and a different bar would look like a different instrument.
 *
 * The width is not the strip's 34px. That number was chosen under the header's
 * pressure — it competes with the session's name — and it is described there as
 * the smallest fill still readable at a glance. A menu has no such competition
 * and a harder job: five bars stacked, read against each other rather than one
 * at a time. At 72px a ten-point difference between two agents is 7px of fill,
 * which the eye catches without measuring; at 34px it is 3px, which it does not.
 */
export const MARK = 16
export const GAP = 7
export const METER_WIDTH = 72
export const METER_HEIGHT = 5

/*
 * The two weights, as coverage of the tint rather than as colours.
 *
 * `PlanMeters` sets its track to `bg-module-platform` and its fill to
 * `label-tertiary` — a barely-there channel under a mark that reads. These are
 * that relationship expressed the only way a mask can express it, and the
 * mark keeps the full weight it had when it was a template of its own.
 */
export const TRACK_ALPHA = 0.2
export const FILL_ALPHA = 0.8

const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}

const crc32 = (buffer) => {
  let c = -1
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An RGBA pixel buffer as a PNG. Truecolour with alpha, no filtering. */
export const encodePng = (width, height, rgba) => {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Coverage of one device pixel by a horizontal capsule, 0 to 1. */
const capsule = (x, y, left, right, radius) => {
  const cx = Math.min(Math.max(x, left + radius), Math.max(right - radius, left + radius))
  const distance = Math.hypot(x - cx, y - radius) - radius
  // Antialiasing worth the name: a hard edge on a 10px-tall shape is a
  // staircase, and a staircase in a menu row reads as a rendering bug.
  return Math.min(1, Math.max(0, 0.5 - distance))
}

/** Black at `alpha`, over whatever is there. Only the alpha channel carries. */
const paint = (out, index, alpha) => {
  if (alpha <= 0) return
  const base = out[index + 3] / 255
  out[index + 3] = Math.round(Math.min(1, alpha + base * (1 - alpha)) * 255)
}

/**
 * A row's picture: the agent's mark, then what the plan has left.
 *
 * `mark` is the row's existing template image as raw bytes — black pixels and
 * an alpha channel — which is why the byte order of `nativeImage.toBitmap()`
 * does not matter here: only the coverage is copied.
 *
 * `fraction` is what is LEFT, never what is spent — the bar fills with the
 * same quantity its number names.
 */
export const drawTrayMeter = ({ fraction, mark = null, scale = 2 }) => {
  // The mark's slot is reserved whether or not there is a mark to put in it.
  // A row that loses its picture must not also lose its column: bars that
  // start at different x cannot be read against each other, which is the only
  // thing five stacked bars are for.
  const width = MARK + GAP + METER_WIDTH
  const height = MARK
  const w = width * scale
  const h = height * scale
  const out = Buffer.alloc(w * h * 4)

  const size = MARK * scale
  if (mark?.length === size * size * 4) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // Only the alpha is read, so the byte order of the source bitmap does
        // not matter: the mark is already a template — black and a mask — and
        // copying its coverage into ours keeps it one.
        paint(out, (y * w + x) * 4, mark[(y * size + x) * 4 + 3] / 255)
      }
    }
  }

  // No lane is no bar — the header strip's rule, and for its reason: a row of
  // permanent empty track teaches people to stop looking. The canvas keeps its
  // full width even so, because the agent that has nothing to report still
  // belongs in the same column as the ones that do.
  if (fraction !== null) {
    const barLeft = (MARK + GAP) * scale
    const barTop = Math.round((height - METER_HEIGHT) / 2) * scale
    const radius = (METER_HEIGHT * scale) / 2
    const span = METER_WIDTH * scale
    // A fill shorter than its own cap is a smudge, not a reading: the least a
    // bar can say is "a sliver", and it says it at the width of one round end.
    const filled = Math.max(METER_HEIGHT * scale, Math.round(span * fraction))

    for (let y = 0; y < METER_HEIGHT * scale; y += 1) {
      for (let x = 0; x < span; x += 1) {
        const index = ((barTop + y) * w + barLeft + x) * 4
        const px = x + 0.5
        const py = y + 0.5
        // The fill replaces the track rather than stacking on it: two coverages
        // added would make the filled end darker than the mark beside it.
        const covered = capsule(px, py, 0, filled, radius)
        paint(out, index, Math.max(covered * FILL_ALPHA, capsule(px, py, 0, span, radius) * TRACK_ALPHA))
      }
    }
  }

  return { png: encodePng(w, h, out), width, height }
}

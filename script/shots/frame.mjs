#!/usr/bin/env node
/**
 * The one presentation frame every README visual goes through.
 *
 * A raw screenshot of the app window, pasted straight into a README, reads
 * as a screenshot. The same window on a soft backdrop, with rounded corners
 * and a drop shadow, reads as a product photograph — and doing it once, here,
 * is what keeps a GIF and a still (`shoot.mjs`'s stills, `gif.mjs`'s frames)
 * looking like one set rather than two different people's screenshots.
 *
 * ImageMagick does the compositing; nothing here decides *what* is on
 * screen, only how the finished frame is presented.
 *
 * Usage, as a module:
 *   import { presentationFrame } from './frame.mjs'
 *   await presentationFrame(inputPng, outputPng, { theme: 'light' })
 *
 * Usage, from the command line (one file):
 *   node script/shots/frame.mjs in.png out.png --theme dark
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Backdrop colours: a very light neutral for light frames, a near-black
 * neutral for dark ones — never pure white or pure black, so the app
 * window's own edge still reads as an edge against it.
 */
const BACKDROP = {
  light: '#e9e9e7',
  dark: '#0b0b0d',
}

/**
 * `radius`/`padding`/`shadow` are all in the *source* image's own pixels —
 * callers pass the screenshot at whatever scale they captured it
 * (`shoot.mjs` shoots at 2x, so a "12px" corner is 24 of the source's own
 * pixels), and this never rescales the input itself, only the canvas it
 * sits on. `outWidth`, when given, is the one resize this does, applied to
 * the *finished, framed* image — the size a README or a GIF actually wants.
 */
export const presentationFrame = async (
  input,
  output,
  { theme = 'light', radius = 24, padding = 96, shadowBlur = 40, shadowAlpha = 45, outWidth = null } = {},
) => {
  const backdrop = BACKDROP[theme] ?? BACKDROP.light
  // Three separate `magick` calls, each writing a real file, rather than one
  // long piped pipeline: chaining "round → shadow → pad" as a single
  // invocation left `-layers merge`'s own image on the stack for the pad
  // step's `-alpha remove` to flatten instead of the shape it followed,
  // producing a blank backdrop with nothing on it. A temp file between each
  // stage is what a `-write`/`+delete` dance would otherwise be doing anyway.
  const dir = mkdtempSync(join(tmpdir(), 'hd-shots-frame-'))
  const rounded = join(dir, 'rounded.png')
  const shadowed = join(dir, 'shadowed.png')
  try {
    // 1. Round the screenshot's own corners: a same-size black/white
    //    rounded-rectangle mask, its grayscale copied into the alpha channel
    //    (`-compose CopyOpacity`) — a plain `DstIn` needs the mask's own
    //    alpha to carry the shape, which a freshly-drawn mask does not have;
    //    asking for its grayscale instead is what actually clips the
    //    corners.
    await run('magick', [
      input,
      '(', '+clone', '-fill', 'black', '-colorize', '100', '-fill', 'white',
      '-draw', `roundrectangle 0,0,%[fx:w-1],%[fx:h-1],${radius},${radius}`, ')',
      '-compose', 'CopyOpacity', '-composite',
      rounded,
    ])
    // 2. Drop shadow: a blurred, offset black copy of the rounded shape,
    //    laid down before the shape itself and merged into one flat layer.
    await run('magick', [
      rounded,
      '(', '+clone', '-background', 'black', '-shadow', `${shadowAlpha}x${shadowBlur}+0+${Math.round(shadowBlur / 2)}`, ')',
      '+swap', '-background', 'none', '-layers', 'merge', '+repage',
      shadowed,
    ])
    // 3. Padding: the shadowed shape flattened onto a backdrop-coloured
    //    canvas `2×padding` wider and taller, shape centred. Optional final
    //    resize, done last so the shadow and radius are never softened by
    //    two resamples.
    await run('magick', [
      shadowed,
      '-bordercolor', backdrop, '-border', `${padding}`,
      '-background', backdrop, '-alpha', 'remove', '-alpha', 'off',
      ...(outWidth ? ['-resize', `${outWidth}x`] : []),
      output,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output, ...rest] = process.argv.slice(2)
  const flag = (name, fallback) => {
    const at = rest.indexOf(`--${name}`)
    return at >= 0 && rest[at + 1] ? rest[at + 1] : fallback
  }
  if (!input || !output) {
    process.stderr.write('usage: node script/shots/frame.mjs <in.png> <out.png> [--theme light|dark] [--width N]\n')
    process.exit(1)
  }
  await presentationFrame(input, output, {
    theme: flag('theme', 'light'),
    outWidth: flag('width', null) ? Number(flag('width', null)) : null,
  })
  process.stdout.write(`  ✓ ${output}\n`)
}

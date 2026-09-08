#!/usr/bin/env node
/**
 * The agents a reader already has, as their own marks.
 *
 * The README used to name them in a code fence — `codex · claude · gemini …` —
 * which is a list of strings where the point is recognition. A developer knows
 * these logos on sight and skims past the words, and the sentence above them
 * ("your machine probably already has several of these") only lands if it is
 * answered by something you recognise rather than something you read.
 *
 * One SVG per theme rather than one file per mark: GitHub renders an `<img>`
 * as its own document, so `currentColor` resolves to nothing useful there and
 * a row of separate images cannot be spaced or aligned from Markdown. A strip
 * is one request, one alignment, and one thing to regenerate.
 *
 * The marks are the same ones the app draws — `@lobehub/icons-static-svg`, via
 * `packages/ui/src/components/BrandIcons.tsx` — so the README and the interface
 * cannot drift into two different Codex logos. They belong to their owners and
 * identify them; see TRADEMARKS.md.
 *
 *   node script/agent-marks.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(APP, 'docs/images')

/** Where pnpm actually put the icon package this run. */
const ICONS = execFileSync('/usr/bin/find', [
  join(APP, 'node_modules'),
  '-type', 'd',
  '-path', '*icons-static-svg/icons',
], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)[0]
if (!ICONS) throw new Error('@lobehub/icons-static-svg is not installed — run pnpm install')

/**
 * Who appears, and what to call them.
 *
 * Not the whole roster — the sentence is *you probably already have several of
 * these*, so it wants the ones a developer plausibly has installed, not a
 * completeness claim. The full list of what HarnessDesk drives is a document,
 * not a logo wall.
 */
const AGENTS = [
  ['codex', 'Codex'],
  ['claudecode', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['geminicli', 'Gemini CLI'],
  ['githubcopilot', 'Copilot'],
  ['amp', 'Amp'],
  ['opencode', 'OpenCode'],
  ['cline', 'Cline'],
  ['windsurf', 'Windsurf'],
  ['deepseek', 'DeepSeek'],
]

/* Sized so the strip renders close to 1:1 in a README column rather than
   being scaled down: at 112px per column the marks arrived on screen at about
   seventeen pixels and read as grey smudges. */
const MARK = 28
const STEP = 76
const LABEL_Y = MARK + 20
const HEIGHT = LABEL_Y + 6
const WIDTH = STEP * AGENTS.length

/** The mark's own paths, and the box they were drawn in. */
const glyph = (name) => {
  const raw = readFileSync(join(ICONS, `${name}.svg`), 'utf8')
  const box = /viewBox="([^"]+)"/.exec(raw)?.[1] ?? '0 0 24 24'
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    // The title is the accessible name of a whole document; inside a strip it
    // would be one of ten, so the strip carries its own and these come out.
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .trim()
  const [, , w, h] = box.split(/\s+/).map(Number)
  return { inner, w: w || 24, h: h || 24 }
}

const strip = (ink, label) => {
  const items = AGENTS.map(([name, text], n) => {
    const { inner, w, h } = glyph(name)
    const scale = MARK / Math.max(w, h)
    const x = n * STEP + STEP / 2
    /* Each mark is scaled into a MARK-sized box and centred on the column, so
       a tall logo and a wide one still sit on the same optical line. */
    return `  <g transform="translate(${(x - MARK / 2).toFixed(1)} 0) scale(${scale.toFixed(4)})" fill="${ink}">${inner}</g>
  <text x="${x.toFixed(1)}" y="${LABEL_Y}" fill="${label}" font-size="10.5" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" text-anchor="middle">${text}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${AGENTS.map(([, t]) => t).join(', ')}">
${items.join('\n')}
</svg>
`
}

/* GitHub's own ink, so the row reads as part of the page rather than as an
   image pasted onto it. */
writeFileSync(join(OUT, 'agents-light.svg'), strip('#1f2328', '#59636e'))
writeFileSync(join(OUT, 'agents-dark.svg'), strip('#e6edf3', '#9198a1'))
process.stdout.write(`  ✓ agents-{light,dark}.svg  ${AGENTS.length} marks  ${WIDTH}×${HEIGHT}\n`)

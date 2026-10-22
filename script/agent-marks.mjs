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
 * Who appears, and what to call them: the agents the app's own picker draws a
 * mark for, in the order harnessdesk.app's agent band reads them, so the
 * README and the website show the same roster. `deepseek` stands in for
 * DeepSeek Harness, which has no mark of its own.
 */
const AGENTS = [
  ['codex', 'Codex'],
  ['claudecode', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['geminicli', 'Gemini CLI'],
  ['deepseek', 'DeepSeek'],
  ['githubcopilot', 'Copilot'],
  ['opencode', 'OpenCode'],
  ['cline', 'Cline'],
  ['windsurf', 'Windsurf'],
  ['antigravity', 'Antigravity'],
  ['kiro', 'Kiro'],
  ['kilocode', 'Kilo Code'],
  ['devin', 'Devin'],
  ['trae', 'Trae'],
  ['amp', 'Amp'],
  ['codebuddy', 'CodeBuddy'],
  ['goose', 'Goose'],
  ['hermesagent', 'Hermes'],
  ['junie', 'Junie'],
  ['pi', 'Pi'],
  ['poolside', 'Poolside'],
  ['qoder', 'Qoder'],
  ['openclaw', 'OpenClaw'],
]

/* The social card's strip predates the website's roster and its picture was
   rendered from these twelve; it keeps them until the card is drawn again. */
const BARE_AGENTS = [
  ['codex', 'Codex'], ['claudecode', 'Claude Code'], ['cursor', 'Cursor'], ['geminicli', 'Gemini CLI'],
  ['githubcopilot', 'Copilot'], ['opencode', 'OpenCode'], ['antigravity', 'Antigravity'], ['grok', 'Grok Build'],
  ['cline', 'Cline'], ['kimi', 'Kimi'], ['codebuddy', 'CodeBuddy'], ['deepseek', 'DeepSeek'],
]

/* Twelve to a row: two rows fit a README column where one row of all of them
   would be scaled down to smudges. */
const PER_ROW = 12

/* Sized so the strip renders close to 1:1 in a README column rather than
   being scaled down: at 112px per column the marks arrived on screen at about
   seventeen pixels and read as grey smudges. */
const MARK = 28
const STEP = 76
const LABEL_Y = MARK + 20

/* The bare strip packs tighter because it has no names to sit under. */
const BARE_STEP = 44
const ROW_GAP = 18

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

/**
 * A strip of marks. Pass a `label` colour and each mark carries its name;
 * pass null and the strip is marks only, packed tighter.
 *
 * The bare variant is for the social card, which is seen at the width a link
 * unfurl gives it — around 440px, a third of the card's own 1280. Measured
 * rather than assumed: downscaled to that width the labelled strip's ten names
 * are illegible smears and the marks under them are grey blobs. Names that
 * cannot be read are not information, they are dirt along the bottom edge.
 */
const strip = (ink, label) => {
  const bare = label == null
  const agents = bare ? BARE_AGENTS : AGENTS
  const step = bare ? BARE_STEP : STEP
  const rowHeight = bare ? MARK : LABEL_Y + 6
  const rows = bare ? 1 : Math.ceil(agents.length / PER_ROW)
  const perRow = bare ? agents.length : PER_ROW
  const width = step * perRow
  const height = rowHeight * rows + ROW_GAP * (rows - 1)
  const items = agents.map(([name, text], n) => {
    const { inner, w, h } = glyph(name)
    const scale = MARK / Math.max(w, h)
    const row = Math.floor(n / perRow)
    /* A short last row is centred under the full one above it. */
    const inRow = Math.min(perRow, agents.length - row * perRow)
    const x = (perRow - inRow) * step / 2 + (n % perRow) * step + step / 2
    const y = row * (rowHeight + ROW_GAP)
    /* Each mark is scaled into a MARK-sized box and centred on the column, so
       a tall logo and a wide one still sit on the same optical line. */
    const mark = `  <g transform="translate(${(x - MARK / 2).toFixed(1)} ${y}) scale(${scale.toFixed(4)})" fill="${ink}">${inner}</g>`
    if (bare) return mark
    return `${mark}
  <text x="${x.toFixed(1)}" y="${y + LABEL_Y}" fill="${label}" font-size="10.5" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" text-anchor="middle">${text}</text>`
  })
  const names = agents.map(([, t]) => t)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${names.join(', ')}">
${items.join('\n')}
</svg>
`
}

/* GitHub's own ink, so the row reads as part of the page rather than as an
   image pasted onto it. */
writeFileSync(join(OUT, 'agents-light.svg'), strip('#1f2328', '#59636e'))
writeFileSync(join(OUT, 'agents-dark.svg'), strip('#e6edf3', '#9198a1'))
/* Dark only: the card it feeds has one theme, and an unused light variant is a
   file somebody has to keep believing in. */
writeFileSync(join(OUT, 'agents-bare-dark.svg'), strip('#e6edf3', null))
process.stdout.write(`  ✓ agents-{light,dark}.svg + agents-bare-dark.svg  ${AGENTS.length} marks\n`)

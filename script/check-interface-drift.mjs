/**
 * Desk must be the app, to the pixel.
 *
 * The Interface setting adds a second look (Studio) entirely out of token
 * values, and the whole claim rests on Desk being unchanged. That claim is
 * easy to break by accident and almost impossible to see in review: replacing
 * `padding: 7px 9px` with `padding: var(--hd-page-row-padding)` looks like a
 * refactor in the diff and is a 9px restyle on screen. It happened twice on
 * this branch — once in the sidebar's session rows, once in the settings
 * window's nav — and both times the diff looked like tidying.
 *
 * So this resolves both sides. For every CSS declaration the branch replaced,
 * it computes what the old text meant and what the new text means **under
 * Desk**, and complains when they differ. A token that varies between the two
 * interfaces must therefore be Studio-only, with the Desk value spelled as the
 * `var()` fallback — which is the convention design/tokens.css documents.
 *
 * The second check is the same question asked of the other half of the app.
 * A token defined only in the Studio block resolves to *nothing* under Desk,
 * so every read of one must carry its Desk value as a `var()` fallback. That
 * is easy to honour in a stylesheet and easy to forget in Tailwind, whose
 * `bg-(--x)` shorthand has nowhere to put a fallback — and forgetting it is
 * silent: the room's selected rail row simply had no background under Desk,
 * because tailwind-merge had already dropped the utility it replaced.
 *
 *   node script/check-interface-drift.mjs [--base origin/main]
 *
 * A deliberate move is declared on the declaration itself, as a trailing
 * comment beginning `desk:` — `font-size: var(--hd-heading); /* desk: 26 → 20 *\/`
 * — and is listed rather than flagged. The check exists to catch a change
 * nobody announced; one that announces itself is what a review is for.
 *
 * It compares against a base ref rather than a checked-in file because the
 * question is about a *change*, not a state: what matters is that this branch
 * did not move Desk, and after it merges there is nothing left to hold.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import { resolveTokens } from './design-tokens.mjs'

const arg = process.argv.indexOf('--base')
const BASE = arg > -1 ? process.argv[arg + 1] : 'origin/main'

/*
 * Both Desk faces, because a token can differ between them.
 *
 * Resolving only the light table let a replacement that is right in light and
 * wrong in dark through — exactly the shape of `--hd-shadow-xs`, which this
 * branch gives a different value under `body[data-hd-dark-theme]`. A
 * declaration has to mean what it meant in *both*, so each is resolved twice
 * and the face is named in the report.
 */
const FACES = [
  ['light', resolveTokens({})],
  ['dark', resolveTokens({ dark: true })],
]

/** Follow `var()` to a literal the way the cascade does, honouring fallbacks. */
const resolve = (value, tokens) => {
  let out = value
  for (let guard = 0; guard < 12 && out.includes('var('); guard++) {
    out = out.replace(
      /var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
      (_, name, fallback) => (tokens.has(name) ? tokens.get(name) : (fallback ?? '').trim()),
    )
  }
  return out
    .replace(/calc\((\d+)px\s*-\s*(\d+)px\)/g, (_, a, b) => `${Number(a) - Number(b)}px`)
    .replace(/#fff\b/g, 'rgb(255, 255, 255)')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- naked reads

/** Tokens the Studio block introduces, which therefore do not exist on Desk. */
const studioOnly = (() => {
  const css = readFileSync('packages/ui/src/design/tokens.css', 'utf8')
  /* Anchored on `selector {`, never on the bare selector text. Slicing the
     base block at the first *mention* of the dark selector would end it early
     the day somebody names that selector in a comment above the rule — a
     natural thing to do in a file this annotated — and every token declared
     after that point would be read as Studio-only. */
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`)
    return at < 0 ? '' : css.slice(at, css.indexOf('\n}', at))
  }
  const declared = (text) => new Set([...text.matchAll(/^\s*(--hd-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]))
  const base = declared(block('body'))
  const dark = declared(block('body[data-hd-dark-theme]'))
  return [...declared(block("body[data-hd-interface='studio']"))].filter(
    (name) => !base.has(name) && !dark.has(name),
  )
})()

/* Compiled once, not per line. Built inline this was one `new RegExp` per
   token per line per file — on the order of a million identical compilations
   for a gate that runs on every `pnpm verify`. */
const patterns = studioOnly.map((token) => [token, new RegExp(`\\(\\s*${token}\\s*\\)`)])
/* Nothing to scan for is not a reason to read every file. */
const anyToken = patterns.length > 0 ? new RegExp(patterns.map(([t]) => t).join('|')) : null

const naked = []
if (anyToken) {
  for (const file of execSync('git ls-files packages/ui/src', { encoding: 'utf8' }).split('\n')) {
    if (!/\.(css|tsx|ts)$/.test(file) || file.endsWith('tokens.css')) continue
    /* `ls-files` answers from the index and this reads the disk. A stylesheet
       deleted but not yet staged is in the first and not the second — the
       ordinary state of a branch that removes one, mid-change — and a file
       that is not there has no reads to check. */
    if (!existsSync(file)) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/^\s*[*/]/.test(line)) return // a comment naming a token is not a read
        if (!anyToken.test(line)) return // the cheap reject, which is most lines
        for (const [token, pattern] of patterns) {
          if (pattern.test(line)) naked.push({ file, line: index + 1, token })
        }
      })
  }
}

/*
 * The palette overlays are out of scope, and not as an exemption.
 *
 * `shadcn-themes.css` and `editorial.css` declare tokens only inside
 * `body[data-hd-palette=…]` and `body[data-hd-accent=…]` — a third axis this
 * check does not model. `resolveTokens` answers for the *unscoped* Desk
 * faces, so comparing an accent-scoped declaration against it is not a
 * stricter test but a meaningless one: it reported that green's ink "moved
 * Desk" when nothing outside `[data-hd-accent='green']` had changed at all.
 * design-tokens.mjs leaves both files out of TOKEN_SOURCES for the same
 * reason — they vary the snapshot rather than being it.
 *
 * What holds the accents to their contrast is `tokens.contrast.test.ts`,
 * which reads those blocks directly and knows which accent it is measuring.
 */
const OVERLAYS = /(shadcn-themes|editorial)\.css$/

const files = execSync(`git diff --name-only ${BASE} -- "packages/ui/src/**/*.css"`, {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((file) => !OVERLAYS.test(file))

const findings = []
const deliberate = []
const rewritten = []
let checked = 0

for (const file of files) {
  /* Pair within a hunk, not across the file. `git diff -U0` emits one hunk per
     edited run of lines, which for a stylesheet is one rule or a neighbouring
     pair — close enough that the Nth removed `color` and the Nth added `color`
     are the same declaration. Pairing file-wide instead matched a selected
     row's colour against an icon's three rules away, and reported drift that
     was not there. */
  const diff = execSync(`git diff -U0 ${BASE} -- ${file}`, { encoding: 'utf8' })
  for (const hunk of diff.split(/^@@.*$/m).slice(1)) {
    const removed = new Map()
    const added = new Map()
    for (const line of hunk.split('\n')) {
      const match = /^([-+])\s*([a-z-]+):\s*(.+?);\s*(?:\/\*\s*(.*?)\s*\*\/)?\s*$/.exec(line)
      if (!match) continue
      const [, sign, property, value, note] = match
      /*
       * A move made on purpose says so on the line: `; /* desk: 26 → 20, the
       * heading step *\/`. The check's whole premise is that a Desk change
       * hidden inside a refactor is invisible in review, and a declaration
       * that announces its own change is the opposite of hidden — so it is
       * counted and reported, not flagged. Anything else with a trailing
       * comment is paired exactly as a bare line would be.
       */
      if (sign === '+' && note && /^desk:/i.test(note)) {
        deliberate.push({ file, property, note })
        continue
      }
      const into = sign === '-' ? removed : added
      into.set(property, [...(into.get(property) ?? []), value])
    }
    /*
     * Index-pairing only means something when a hunk is a set of replacements.
     * A hunk that deletes 541 lines and adds 3 is a rewrite, and pairing the
     * Nth deleted `gap` with the Nth added `gap` across it reports a move that
     * never happened. Such a hunk is skipped and counted, so the summary says
     * how much of the diff the check could not read.
     */
    const removedCount = [...removed.values()].reduce((n, list) => n + list.length, 0)
    const addedCount = [...added.values()].reduce((n, list) => n + list.length, 0)
    if (removedCount > 0 && addedCount > 0 && Math.max(removedCount, addedCount) >= 10
      && Math.max(removedCount, addedCount) > 3 * Math.min(removedCount, addedCount)) {
      rewritten.push({ file, removedCount, addedCount })
      continue
    }
    for (const [property, olds] of removed) {
      const news = added.get(property) ?? []
      olds.forEach((old, index) => {
        if (news[index] === undefined) return
        checked++
        for (const [face, tokens] of FACES) {
          const before = resolve(old, tokens)
          const after = resolve(news[index], tokens)
          if (before !== after) findings.push({ file, face, property, before, after })
        }
      })
    }
  }
}

if (deliberate.length > 0) {
  console.log(`${deliberate.length} declaration(s) moved Desk on purpose, and say so:`)
  for (const { file, property, note } of deliberate) console.log(`  ${file}  ${property}: ${note}`)
}
for (const { file, removedCount, addedCount } of rewritten) {
  console.log(`${file}: a rewrite hunk (-${removedCount} +${addedCount} declarations) was not paired; read it by eye.`)
}
if (findings.length === 0 && naked.length === 0) {
  console.log(`${checked} replaced declarations resolve to what they replaced.`)
  console.log(`${studioOnly.length} Studio-only tokens, all read with a Desk fallback.`)
  process.exit(0)
}

for (const { file, line, token } of naked) {
  console.error(`${file}:${line}\n  ${token} is Studio-only and read with no Desk fallback`)
}
if (naked.length > 0) {
  console.error('')
  console.error(`${naked.length} read(s) of a Studio-only token resolve to nothing under Desk.`)
  console.error("In CSS write var(--token, <desk value>); in Tailwind the (--x) shorthand")
  console.error('cannot carry one, so write the long form: bg-[var(--token,<desk value>)].')
  if (findings.length === 0) process.exit(1)
  console.error('')
}

for (const { file, face, property, before, after } of findings) {
  console.error(`${file}  [${face}]\n  ${property}: was "${before}"  ->  Desk now "${after}"`)
}
console.error('')
console.error(`${findings.length} of ${checked} replaced declarations moved Desk.`)
console.error('A token that differs between interfaces belongs in the Studio block,')
console.error('with the Desk value as the var() fallback. If a change is deliberate,')
console.error('say so in the commit — this check is a question, not a law.')
process.exit(1)

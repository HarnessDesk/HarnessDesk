/**
 * Write the design system's documentation out of the design system.
 *
 * The rules an agent needs live in the source already — in the token file's
 * comments and in each primitive's doc comment — because that is where the
 * person changing the behaviour is looking. Restating them in a Markdown file
 * by hand would create the second source of truth this system exists to
 * avoid, and it would be wrong within a fortnight.
 *
 * So the Markdown is generated. `--check` fails when it is stale, which is
 * how the doc stays honest without anybody remembering to update it.
 *
 *   node script/design-doc.mjs           write docs/design-system.md
 *   node script/design-doc.mjs --check   fail if it is out of date
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SECTIONS } from './design-sections.mjs'
import { resolveTokens } from './design-tokens.mjs'
import { BUTTONS, ELEMENTS, SLOTS } from './design-usage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESIGN = path.join(root, 'packages/ui/src/design')
const OUT = path.join(root, 'docs/design-system.md')

const read = (file) => fs.readFileSync(file, 'utf8')

/**
 * The prose from a file's leading block comment, unwrapped.
 *
 * Line breaks survive, unlike `prose` below: a lead comment is the one place
 * these files put structure — an indented two-column table of what lives
 * where, a run of measurements — and joining it into one paragraph turns that
 * structure into a run-on sentence. Four leading spaces is already a Markdown
 * code block, so the indented parts arrive intact for free.
 *
 * The one thing that does need translating is the divider these comments use
 * to separate a file's second thought from its first: a full-width rule with
 * a title under it. Left alone that renders as a horizontal line followed by
 * an ordinary sentence, so the title — which is doing a heading's job in the
 * source — arrives in the documentation weighing nothing.
 */
export const leadComment = (source) => {
  const match = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(source)
  if (!match) return ''
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*ic?\s?/, '').replace(/^\s*\*\s?/, ''))
    .join('\n')
    .replace(/^-{10,}\n(\S.*)$/gm, '### $1')
    .trim()
}

/**
 * A block comment's prose, unwrapped into one paragraph.
 *
 * Two comment styles live in tokens.css — plain indented prose, and the
 * `*`-per-line JSDoc shape — and only the first used to survive the trip here.
 * The second arrived as "* * A page-sized decision * * about how big", in the
 * two longest sections on the page, and had done since the doc was generated.
 *
 * `(?!\*)` is the whole of what the first attempt at that got wrong. A JSDoc
 * gutter is exactly one asterisk; Markdown's bold is exactly two. Stripping
 * one unconditionally ate the opening `**` of the sentence the solid's section
 * is named after and shipped `*Ink is for what you press.**` into the
 * committed doc — which `--check` cannot catch, because the gate only asks
 * whether the file matches what this function produces, and a generator that
 * mangles produces a matching mangled file.
 */
export const prose = (comment) =>
  comment
    .split('\n')
    .map((line) => line.trim().replace(/^\*(?!\*)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Every section of the token file, as its comment plus its declarations. */
const tokenSections = () => {
  const css = read(path.join(DESIGN, 'tokens.css'))
  const sections = []
  const header = /\/\* --- ([a-z ]+) -+\n([\s\S]*?)\*\//g
  let match
  while ((match = header.exec(css)) !== null) {
    const after = css.slice(header.lastIndex)
    const names = [...after.slice(0, after.indexOf('/*') === -1 ? undefined : after.indexOf('/*'))
      .matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)].map((hit) => [hit[1], hit[2].trim()])
    sections.push({
      title: match[1].trim(),
      about: prose(match[2]),
      names,
    })
  }
  return sections
}

const primitives = () =>
  fs
    .readdirSync(path.join(DESIGN, 'primitives'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => {
      const source = read(path.join(DESIGN, 'primitives', name))
      const doc = [...source.matchAll(/\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export const (\w+)/g)].map((hit) => ({
        name: hit[2],
        about: hit[1]
          .split('\n')
          .map((line) => line.replace(/^\s*\*\s?/, ''))
          .join('\n')
          .trim(),
      }))
      return { file: name, exports: doc }
    })
    .filter((entry) => entry.exports.length > 0)

/*
 * The doc comment immediately above an `export const`, and nothing else.
 *
 * `[\s\S]*?` looks non-greedy but is not bounded by the comment it starts in:
 * at a comment close not followed by `export const` it simply extends to the
 * next one, swallowing whatever lies between. A pattern file with a header
 * comment and a private `const` before its first export therefore printed both
 * of them into the documentation as raw TypeScript. The body now cannot
 * contain a comment close at all, which is what "this comment" means.
 */
const patterns = () =>
  fs
    .readdirSync(path.join(DESIGN, 'patterns'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => {
      const source = read(path.join(DESIGN, 'patterns', name))
      return {
        file: name,
        exports: [...source.matchAll(/\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export const (\w+)/g)].map((hit) => ({
          name: hit[2],
          about: hit[1]
            .split('\n')
            .map((line) => line.replace(/^\s*\*\s?/, ''))
            .join('\n')
            .trim(),
        })),
      }
    })

const tokens = resolveTokens({ root })
const baseline = JSON.parse(read(path.join(DESIGN, 'audit-baseline.json')))

const lines = []
lines.push('# The design system')
lines.push('')
lines.push('*Generated by `script/design-doc.mjs` from the source. Do not edit — change the')
lines.push('code and run `pnpm design:doc`. This file exists so an agent can read the rules')
lines.push('without opening a browser; the same rules, rendered, are `pnpm design`.*')
lines.push('')
lines.push(leadComment(read(path.join(DESIGN, 'index.ts'))))
lines.push('')
lines.push('## Foundation')
lines.push('')
for (const section of tokenSections()) {
  lines.push(`### ${section.title.replace(/^./, (c) => c.toUpperCase())}`)
  lines.push('')
  if (section.about) {
    lines.push(section.about)
    lines.push('')
  }
  if (section.names.length > 0) {
    lines.push('| token | value |')
    lines.push('| --- | --- |')
    for (const [name] of section.names) {
      lines.push(`| \`${name}\` | \`${tokens.get(name) ?? ''}\` |`)
    }
    lines.push('')
  }
}

/**
 * The usage table, as prose.
 *
 * Three fields per rule and a heading each, rather than a four-column table:
 * the `because` column runs to a couple of hundred characters, and a Markdown
 * table cell that long is unreadable in the source and wraps to mush in the
 * rendered page. The reason is the part worth reading, so it gets a line.
 */
const rules = (list, key) => {
  for (const rule of list) {
    lines.push(`### \`${rule[key]}\``)
    lines.push('')
    lines.push(`**Use** — ${rule.when}`)
    lines.push('')
    lines.push(`**Not** — ${rule.never}`)
    lines.push('')
    lines.push(`**Why** — ${rule.because}`)
    lines.push('')
  }
}

lines.push('## When to use which')
lines.push('')
lines.push(leadComment(read(path.join(DESIGN, 'usage.ts'))))
lines.push('')
lines.push('### Buttons')
lines.push('')
rules(BUTTONS, 'variant')
lines.push('### Everything else with a rule')
lines.push('')
rules(ELEMENTS, 'variant')
lines.push('### The slots a gate holds')
lines.push('')
lines.push('`pnpm design:audit` fails on a variant that cannot appear in one of these, on one')
lines.push('drawn at the wrong rung, on a second ink action where the slot holds one, and on a')
lines.push('variant written as an expression it cannot read — an unreadable slot is reported')
lines.push('rather than passed. The rest of this page is judgement; this part is enforced.')
lines.push('')
lines.push('| slot | what it is | may be | rung | ink actions | why |')
lines.push('| --- | --- | --- | --- | --- | --- |')
for (const rule of SLOTS) {
  const allow = rule.allow.map((one) => `\`${one}\``).join(', ')
  const rung = rule.size === 'sm' ? '`--hd-btn-h-sm`' : '`--hd-btn-h`'
  const ink = rule.oneInk === true ? 'one' : 'any'
  lines.push(`| \`${rule.slot}\` | ${rule.what} | ${allow} | ${rung} | ${ink} | ${rule.why} |`)
}
lines.push('')
lines.push('## Primitives')
lines.push('')
for (const entry of primitives()) {
  for (const one of entry.exports) {
    lines.push(`### \`${one.name}\``)
    lines.push('')
    lines.push(`\`packages/ui/src/design/primitives/${entry.file}\``)
    lines.push('')
    lines.push(one.about)
    lines.push('')
  }
}

lines.push('## Patterns')
lines.push('')
for (const entry of patterns()) {
  for (const one of entry.exports) {
    lines.push(`### \`${one.name}\``)
    lines.push('')
    lines.push(`\`packages/ui/src/design/patterns/${entry.file}\``)
    lines.push('')
    lines.push(one.about)
    lines.push('')
  }
}

lines.push('## Known drift')
lines.push('')
lines.push('The app predates this system. These are the places it has not caught up, counted')
lines.push('by `pnpm design:audit`. `verify` refuses anything worse than these numbers, so the')
lines.push('list can only go down.')
lines.push('')
lines.push('| finding | count | what it costs |')
lines.push('| --- | --- | --- |')
// The costs come from the audit's own list, not a second copy here. This table
// used to keep its own, which is how three new checks arrived in the doc with
// an empty column and nothing failed.
const COST = new Map(SECTIONS.map(([key, , why]) => [key, why]))
for (const [key, count] of Object.entries(baseline)) {
  lines.push(`| \`${key}\` | ${count} | ${COST.get(key) ?? ''} |`)
}
lines.push('')

const text = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`

/* Everything below is the command; above is importable. A test that had to
   run the generator to reach one pure function would be a test of the
   filesystem. */
const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUT) ? read(OUT) : ''
  if (existing === text) {
    console.log('docs/design-system.md is current.')
    process.exit(0)
  }
  console.error('docs/design-system.md is stale. Run: pnpm design:doc')
  process.exit(1)
}

fs.writeFileSync(OUT, text)
console.log(`wrote ${path.relative(root, OUT)} (${text.split('\n').length} lines)`)
}

/**
 * Hold the token layer against what it resolved to last time.
 *
 * Tokens are the one place in the app where a one-line edit changes every
 * screen at once, and where a chain of `var()` means the edit's real effect is
 * invisible in the diff. Moving `--hd-danger` to a different red, or slipping
 * a definition into a file that loads earlier than the one it must beat, looks
 * like nothing in review and looks like a redesign on screen.
 *
 * So the resolved value of every token is checked in, and this compares
 * against it. Refactoring the token files freely is safe; changing what the
 * interface looks like is a deliberate act that shows up as a snapshot diff.
 *
 *   node script/check-design-tokens.mjs            verify
 *   node script/check-design-tokens.mjs --update   accept the new values
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { snapshot } from './design-tokens.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'packages/ui/src/design/tokens.snapshot.txt')
const current = snapshot(root)

if (process.argv.includes('--update')) {
  fs.writeFileSync(file, current)
  console.log(`updated ${path.relative(root, file)}`)
  process.exit(0)
}

if (!fs.existsSync(file)) {
  console.error('No token snapshot. Run: node script/check-design-tokens.mjs --update')
  process.exit(1)
}

const expected = fs.readFileSync(file, 'utf8')
if (expected === current) {
  const count = current.split('\n').filter((line) => line.includes(' = ')).length
  console.log(`${count} token values match the snapshot.`)
  process.exit(0)
}

/** Say which tokens moved, not that the file differs. */
const parse = (text) => {
  const themes = {}
  let theme = null
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) {
      theme = line.slice(2).trim()
      themes[theme] ??= new Map()
    } else if (line.includes(' = ') && theme) {
      const at = line.indexOf(' = ')
      themes[theme].set(line.slice(0, at), line.slice(at + 3))
    }
  }
  return themes
}

const before = parse(expected)
const after = parse(current)
/* Every face the snapshot carries, taken from the file rather than listed —
   adding one to design-tokens.mjs must not need an edit here too. */
for (const theme of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
  before[theme] ??= new Map()
  after[theme] ??= new Map()
  for (const [name, value] of before[theme]) {
    if (!after[theme].has(name)) console.error(`gone     [${theme}] ${name} (was ${value})`)
    else if (after[theme].get(name) !== value) {
      console.error(`changed  [${theme}] ${name}`)
      console.error(`           was ${value}`)
      console.error(`           now ${after[theme].get(name)}`)
    }
  }
  for (const [name, value] of after[theme]) {
    if (!before[theme].has(name)) console.error(`new      [${theme}] ${name} = ${value}`)
  }
}
console.error('')
console.error('Token values moved. If that was the intent, run:')
console.error('  node script/check-design-tokens.mjs --update')
process.exit(1)

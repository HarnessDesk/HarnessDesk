#!/usr/bin/env node
/**
 * Every licence THIRD_PARTY_NOTICES.md claims is the licence that shipped.
 *
 * The notices file is the one document a reader has to be able to trust
 * without checking, and it is the one that rots most quietly: a dependency is
 * added, a section is written from memory, and nothing ever disagrees out
 * loud. Writing this check found `class-variance-authority` described as MIT
 * when it is Apache-2.0 — in a paragraph added minutes earlier, by someone
 * being careful.
 *
 * So the claims are read back out of the prose and compared with what is
 * installed. Two shapes carry them, and both are already the file's own
 * style:
 *
 *   - Package: `@zed-industries/claude-code-acp` (0.16.2)
 *   - License: Apache 2.0 — see `licenses/Apache-2.0.txt`
 *
 *   | `react`, `react-dom` | MIT | The renderer |
 *
 * A package the notices name but the workspace does not install is skipped
 * rather than failed: the file also describes things that are vendored as
 * source or reached over a protocol, and those have no package.json here.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const notices = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')

/** "Apache 2.0", "Apache-2.0" and "Apache License 2.0" are one licence. */
const canonical = (value) =>
  value
    .trim()
    .replace(/\s*—.*$/, '')
    .replace(/\bLicense\b/gi, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase()
    .replace(/^APACHE-?2(\.0)?$/, 'APACHE-2.0')
    .replace(/^SIL-OFL-1\.1$|^OFL-1\.1$/, 'OFL-1.1')

/**
 * Where pnpm put a package, if it put it anywhere.
 *
 * `find` exits 1 when the start directory is missing or a subtree is
 * unreadable, and `execFileSync` turns that into a throw — so on a checkout
 * installed with `node-linker=hoisted`, which has no `.pnpm` at all, the gate
 * died with a stack trace instead of reporting a licence. A package it cannot
 * find is a package it cannot check, which is the `null` case that was
 * already handled.
 */
const installedLicence = (name) => {
  let found = []
  try {
    found = execFileSync(
      'find',
      ['node_modules/.pnpm', '-maxdepth', '5', '-path', `*/node_modules/${name}/package.json`],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split('\n')
      .filter(Boolean)
  } catch {
    return null
  }
  if (found.length === 0) return null
  const manifest = JSON.parse(readFileSync(resolve(root, found[0]), 'utf8'))
  return typeof manifest.license === 'string' ? manifest.license : null
}

const claims = []
const problems = []

/*
 * "- Packages: `a` (1.2), `b` (3.4)" … then the "- License:" line under it.
 *
 * A list item is not a line. This file wraps its longer ones, and reading only
 * the first line of each dropped `@agentclientprotocol/sdk` — an installed
 * package, silently unchecked, while the gate reported every other claim
 * matching. The licence was looked for in a fixed five-line window for the
 * same reason, which one more wrapped `- Source:` line would have slid it out
 * of. Both now walk the item to its end, and a package block with no licence
 * under it is an error rather than a quiet `continue`.
 */
const lines = notices.split('\n')
/** The whole of the list item starting at `index`, continuation lines folded in. */
const itemAt = (index) => {
  let text = lines[index]
  let cursor = index + 1
  while (cursor < lines.length && /^\s{2,}\S/.test(lines[cursor]) && !/^\s*-\s/.test(lines[cursor])) {
    text += ` ${lines[cursor].trim()}`
    cursor += 1
  }
  return { text, next: cursor }
}

for (let index = 0; index < lines.length; index += 1) {
  if (!/^-\s+Packages?:/.test(lines[index])) continue
  const stanza = itemAt(index)
  const names = [...stanza.text.matchAll(/`([^`]+)`/g)].map((match) => match[1])

  // Walk the following list items until the licence, or until the section ends.
  let licence = null
  let cursor = stanza.next
  while (cursor < lines.length) {
    if (/^\s*$/.test(lines[cursor]) || /^#/.test(lines[cursor])) break
    if (/^-\s+Packages?:/.test(lines[cursor])) break
    const item = itemAt(cursor)
    const found = item.text.match(/^-\s+Licen[cs]e:\s*(.+)$/)
    if (found) { licence = found[1]; break }
    cursor = item.next
  }
  if (!licence) {
    problems.push(
      `line ${index + 1}: a package block naming ${names.map((n) => `\`${n}\``).join(', ') || 'nothing'} has no "- License:" under it.`,
    )
    continue
  }
  for (const name of names) claims.push({ name, licence, where: `line ${index + 1}` })
}

// "| `react`, `react-dom` | MIT | The renderer |"
for (const [index, line] of lines.entries()) {
  const row = line.match(/^\|\s*(`[^|]+`[^|]*)\|\s*([^|]+?)\s*\|/)
  if (!row || /^\|\s*-+/.test(line)) continue
  for (const match of row[1].matchAll(/`([^`]+)`/g)) {
    claims.push({ name: match[1], licence: row[2], where: `line ${index + 1}` })
  }
}

let checked = 0
let skipped = 0

for (const claim of claims) {
  // A version in the name — "`marked` (15.0)" — is prose, not part of it.
  const name = claim.name.replace(/\s*\(.*$/, '').trim()
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) continue
  const actual = installedLicence(name)
  if (actual === null) {
    skipped += 1
    continue
  }
  checked += 1
  if (canonical(actual) !== canonical(claim.licence)) {
    problems.push(
      `${name}: THIRD_PARTY_NOTICES.md says ${claim.licence.trim()} (${claim.where}), the installed package says ${actual}.`,
    )
  }
}

// A licence file the notices point at must exist, or the pointer is a promise
// the repository does not keep.
for (const match of notices.matchAll(/`(licenses\/[^`]+)`/g)) {
  if (!existsSync(resolve(root, match[1]))) {
    problems.push(`${match[1]}: pointed at by THIRD_PARTY_NOTICES.md and not in the repository.`)
  }
}

if (problems.length === 0) {
  console.log(
    `${checked} licence claim(s) in THIRD_PARTY_NOTICES.md match what is installed` +
      `${skipped > 0 ? `; ${skipped} name(s) are not packages in this workspace` : ''}.`,
  )
  process.exit(0)
}

console.error('THIRD_PARTY_NOTICES.md disagrees with what ships:\n')
for (const problem of problems) console.error(`  - ${problem}`)
console.error(
  '\n  Attribution is the one document a reader cannot check for themselves.' +
    '\n  Fix the notice, or the dependency, before this goes out.',
)
process.exit(1)

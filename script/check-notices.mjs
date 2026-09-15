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
 *   - Package: `@agentclientprotocol/claude-agent-acp` (0.77.0)
 *   - License: Apache 2.0 — see `licenses/Apache-2.0.txt`
 *
 *   | `react`, `react-dom` | MIT | The renderer |
 *
 * A package the notices name but the workspace does not install is skipped
 * rather than failed: the file also describes things that are vendored as
 * source or reached over a protocol, and those have no package.json here.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
 * Checks `node_modules/<name>/package.json` first, and if not present, walks
 * `node_modules/.pnpm` using native filesystem calls so the gate does not depend
 * on an external `find` utility (which fails or does not exist on Windows, or
 * when find is unavailable in PATH).
 */
export const installedLicence = (name, baseDir = root) => {
  const directPath = join(baseDir, 'node_modules', name, 'package.json')
  if (existsSync(directPath)) {
    try {
      const manifest = JSON.parse(readFileSync(directPath, 'utf8'))
      return typeof manifest.license === 'string' ? manifest.license : null
    } catch {
      return null
    }
  }

  const pnpmDir = join(baseDir, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null

  // Fast direct traversal of .pnpm subdirectories
  try {
    const entries = readdirSync(pnpmDir, { withFileTypes: true })
    const targetSubpath = join('node_modules', name, 'package.json')
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(pnpmDir, entry.name, targetSubpath)
      if (existsSync(candidate)) {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
        return typeof manifest.license === 'string' ? manifest.license : null
      }
    }
  } catch {
    return null
  }

  return null
}

/**
 * Parses claims from notices content and checks them against installed packages.
 * Exported for testing so the verification logic can be tested directly.
 */
export const checkNotices = (noticesText = notices, baseDir = root) => {
  const claims = []
  const problems = []

  const lines = noticesText.split('\n')
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
    const name = claim.name.replace(/\s*\(.*$/, '').trim()
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) continue
    const actual = installedLicence(name, baseDir)
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

  for (const match of noticesText.matchAll(/`(licenses\/[^`]+)`/g)) {
    if (!existsSync(resolve(baseDir, match[1]))) {
      problems.push(`${match[1]}: pointed at by THIRD_PARTY_NOTICES.md and not in the repository.`)
    }
  }

  if (checked === 0) {
    problems.push(
      'No licence claims could be verified against installed packages in node_modules. ' +
        'Check that dependencies are installed and accessible.',
    )
  }

  return { checked, skipped, problems }
}

const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const { checked, skipped, problems } = checkNotices(notices, root)
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
}

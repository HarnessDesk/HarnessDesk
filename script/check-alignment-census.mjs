#!/usr/bin/env node
/**
 * The alignment census's table may only fall.
 *
 * `e2e/ui-system/alignment-census.spec.ts` holds the rendered parts to
 * `packages/ui/src/design/alignment-census.json`: a new or risen signature
 * fails it. But the table is the spec's own input, and `pnpm design:alignment`
 * rewrites it to whatever renders — so a branch that re-records lets every new
 * misalignment through, and the spec, reading the new table, passes. That is
 * how #1161 took `header-off-body` from 80 to 92 a few hours after the census
 * landed, with every check green.
 *
 *   node script/check-alignment-census.mjs [--base origin/main]
 *
 * So the table is compared with the one this branch started from: the merge
 * base with `--base`, not its tip. Against the tip, a branch that never
 * touched the census would fail the moment main fixed something, for a table
 * it did not write. Against the merge base, a branch answers for exactly the
 * edits it made to the table. Every signature's multiplicity, and every
 * check's total, may stay or fall; none may appear or rise. A part that
 * renders a new misalignment is fixed in the part (`docs/design.md`, the
 * layout rules), not recorded.
 *
 * A frame or board id that is renamed reads as one signature vanishing and a
 * new one appearing. Keep the id: it is the key, and the visible heading
 * beside it is free to change.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TABLE = 'packages/ui/src/design/alignment-census.json'

/** Every way `head` records more than `base`, one line each; empty when it records no more. */
export const compareTables = (base, head) => {
  const problems = []
  for (const [check, entry] of Object.entries(head)) {
    const was = base[check]
    if (!was) {
      if (entry.count > 0) problems.push(`${check}: a new check recorded with ${entry.count} findings`)
      continue
    }
    if (entry.count > was.count) problems.push(`${check}: total rose ${was.count} → ${entry.count}`)
    for (const [signature, count] of Object.entries(entry.signatures ?? {})) {
      const before = was.signatures?.[signature] ?? 0
      if (count <= before) continue
      problems.push(before === 0 ? `${check}: new (×${count})  ${signature}` : `${check}: rose ${before} → ${count}  ${signature}`)
    }
  }
  return problems
}

const main = () => {
  const arg = process.argv.indexOf('--base')
  const base = arg > -1 ? process.argv[arg + 1] : 'origin/main'
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  let start
  try {
    start = git('merge-base', 'HEAD', base).trim()
  } catch {
    console.error(`alignment census: no merge base with ${base}; fetch it (a CI checkout needs fetch-depth: 0).`)
    process.exit(1)
  }
  let before
  try {
    before = JSON.parse(git('show', `${start}:${TABLE}`))
  } catch {
    console.log(`alignment census: the merge base with ${base} had no table yet; nothing to hold.`)
    return
  }
  const after = JSON.parse(readFileSync(path.join(root, TABLE), 'utf8'))
  const problems = compareTables(before, after)
  if (problems.length === 0) {
    const totals = Object.entries(after).map(([check, { count }]) => `${check} ${before[check]?.count ?? 0} → ${count}`)
    console.log(`alignment census: the table did not rise (${totals.join(', ')}).`)
    return
  }
  console.error(
    `alignment census: ${TABLE} rose against ${start.slice(0, 9)}, the merge base with ${base}.\n` +
      'Re-recording is for a fall. Fix the part that renders these instead:\n\n' +
      problems.map((p) => `  ${p}`).join('\n') +
      '\n',
  )
  process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

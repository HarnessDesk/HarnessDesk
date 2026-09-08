#!/usr/bin/env node
/**
 * The local gate and CI must run the same commands.
 *
 * `verify.mjs` opens by saying that this file and `.github/workflows/ci.yml`
 * drifting apart "is what let a broken build reach main once already" — and
 * then nothing checked it. This is that check.
 *
 * It reads the commands `verify.mjs` actually shells out to and asks whether
 * each one appears in the workflow. Not a diff of the two files: CI has jobs,
 * caches and a release path that have no business here, and the ordering is
 * its own concern. The property is one-way and narrow — **anything the gate
 * runs, CI runs too** — because that is the direction that fails silently.
 * The other direction is loud: a CI step nobody runs locally shows up as a
 * red pipeline on the pull request.
 *
 * That loud direction was theoretical here for a while. Actions was switched
 * off on the repository until 2026-09-07, and for the fortnight before that
 * every run died in about four seconds on "the job was not started because
 * recent account payments have failed" — which looks identical to a failing
 * build in the UI and is an entirely different fix. While the gate is the only
 * thing running, its list has to stay honest: a command that only ever ran
 * locally is a command that was never really checked.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Steps CI deliberately does not run, and the reason, which must also be
 * written down where the step is.
 *
 * An entry here is a promise that the omission was decided rather than
 * forgotten. Adding one is how you say "CI cannot do this"; it is not a way
 * to make this check quiet.
 */
const NOT_IN_CI = new Map([
  [
    'script/generate-codex-protocol.mjs',
    'needs a real `codex` binary, which the runner does not have',
  ],
])

// One entry, and it should stay that way. This check runs in CI too — it
// compares two files that are both in the checkout, so there is nothing
// stopping it.


/**
 * Every `run(command, [args])` in the gate, as the command line it becomes.
 *
 * Two quote styles, because a formatter is entitled to change them and this
 * check must not quietly stop seeing a command because Prettier rewrote it.
 * And it counts what it read: a `run(` the parser cannot take apart is a
 * command that would silently leave the comparison, which is precisely the
 * failure this file exists to prevent — so it fails instead, naming the line.
 */
export const gateCommands = (raw) => {
  /*
   * Comment lines first, or prose becomes a command.
   *
   * `verify.mjs` is a heavily commented file whose comments talk about the
   * thing it does. A note reading "this was a bare run( call" made the count
   * disagree and failed the check over a command that does not exist; a note
   * quoting a whole `run('pnpm', ['run', 'build'])` was read as a seventeenth
   * step. Both are ordinary things to write and neither should cost the next
   * person an afternoon.
   *
   * Whole lines only — a line whose first non-space character opens or
   * continues a comment. Stripping comments *properly* means not stripping
   * them from inside strings, and the first attempt here did exactly that:
   * `packages/…/test/**​/*.test.js` contains a `/**​/`, so a block-comment
   * regex ate the middle of the test glob and every command after it. This
   * file's comments all sit on their own lines, and a line carrying a `run(`
   * never begins with a comment marker, so the two sets do not overlap.
   */
  const source = raw
    .split('\n')
    .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n')
  const out = []
  const call = /\brun\(\s*(['"])(.*?)\1\s*,\s*\[([\s\S]*?)\]\s*\)/g
  for (const [, , command, rawArgs] of source.matchAll(call)) {
    const args = [...rawArgs.matchAll(/(['"])(.*?)\1/g)].map(([, , value]) => value)
    out.push({ command, args })
  }
  const attempted = [...source.matchAll(/\brun\(/g)].length
  if (attempted !== out.length) {
    process.stderr.write(
      `script/verify.mjs has ${attempted} run(...) calls and this check could read ${out.length}.\n` +
        'A call it cannot read is a command that leaves the comparison silently.\n' +
        'Either write it as run(\'cmd\', [\'arg\', …]) with literal strings, or teach\n' +
        'the parser in script/check-verify-drift.mjs the shape you need.\n',
    )
    process.exit(1)
  }
  return out
}

/**
 * What CI actually *runs* — the `run:` values, and nothing else.
 *
 * Searching the whole file would let a comment satisfy the check: a line of
 * prose naming `script/check-layering.mjs` reads the same to `includes()` as
 * a step that executes it, and this file is full of comments naming its own
 * commands. So the workflow is reduced to its `run:` values first, including
 * the folded (`run: >`) ones, then flattened — quotes dropped and whitespace
 * collapsed — so a quoted glob written inline in YAML matches the same command
 * assembled from the gate's argument array.
 */
export const ciCommands = (yaml) => {
  const lines = yaml.split('\n')
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const inline = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line)
    if (!inline) continue
    const value = (inline[1] ?? '').trim()
    if (value !== '>' && value !== '|' && value !== '>-' && value !== '|-') {
      out.push(value)
      continue
    }
    // A folded scalar: every following line indented past the `run:` itself.
    const indent = (/^\s*/.exec(line) ?? [''])[0].length
    const block = []
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? ''
      if (candidate.trim() === '') continue
      if ((/^\s*/.exec(candidate) ?? [''])[0].length <= indent) break
      block.push(candidate.trim())
      index = next
    }
    out.push(block.join(' '))
  }
  return out.map((one) => one.replace(/["']/g, '').replace(/\s+/g, ' ')).join('\n')
}

/* The two parsers above are exported so the gate that keeps `verify.mjs` and
   `ci.yml` equal can itself be tested without running it. Importing this file
   must therefore not *be* the check — an import that exits 1 on drift would
   kill the test file with no failing test named, which is the least useful
   way a suite can go red. Same guard as `check-layering.mjs`. */
const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const workflow = ciCommands(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
  const gate = gateCommands(readFileSync(resolve(root, 'script/verify.mjs'), 'utf8'))

  const missing = []
  for (const { command, args } of gate) {
    if (args.some((arg) => NOT_IN_CI.has(arg))) continue
    const line = [command, ...args].join(' ')
    if (!workflow.includes(line)) missing.push(line)
  }

  if (missing.length > 0) {
    process.stderr.write(
      'These run in `pnpm verify` and not in CI. Add them to .github/workflows/ci.yml,\n' +
        'or record the reason in NOT_IN_CI in script/check-verify-drift.mjs:\n\n',
    )
    for (const line of missing) process.stderr.write(`  ${line}\n`)
    process.exit(1)
  }

  process.stdout.write(`gate and CI agree on ${gate.length} commands\n`)
}

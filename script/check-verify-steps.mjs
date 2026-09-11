/**
 * Every step `pnpm verify` runs is named where a person is told what the gate
 * does: the "Before you commit" section of `AGENTS.md` and "The gate" section
 * of `CONTRIBUTING.md`.
 *
 * Both list the steps in prose and nothing compared either list with
 * `verify.mjs`. #189 brought them up to date by hand; the next step added
 * would leave both short again with nothing to say so, which is how AGENTS.md
 * went wrong in the first place (#92, #246).
 *
 * The prose does not repeat the step names — "the layering rule" for a step
 * called `layering rule`, one phrase covering the four test suites — so the
 * correspondence is written here, one pattern per step. That is the point of
 * the table rather than a weakness of it: adding a step means saying how the
 * two documents name it, and a step nobody described fails the check with that
 * instruction. It is the same idiom as `NOT_IN_CI` in `check-verify-drift.mjs`
 * — the exception is recorded where the check can read it.
 *
 * Scoped to those two sections rather than the whole file: "the build" appears
 * all over `AGENTS.md`, and a pattern that matches prose elsewhere would be a
 * check that cannot fail.
 *
 * Each section is flattened before it is matched, because the prose is
 * hard-wrapped: "every test suite (Node packages, gate scripts, UI and
 * desktop)" is two lines in the file, and a pattern written as the sentence
 * reads would miss it — which is how the first run of this check reported five
 * steps as unnamed when both documents named all five.
 *
 *   node script/check-verify-steps.mjs
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where each document lists the steps, and nothing else in it. */
export const SECTIONS = new Map([
  ['AGENTS.md', '## Before you commit'],
  ['CONTRIBUTING.md', '## The gate'],
])

/**
 * How the two documents name each step. One pattern, matched against both:
 * where they word it differently, the alternation says so.
 */
export const DESCRIBED_AS = new Map([
  ['lockfile installs', /lockfile/i],
  ['build', /\bthe build\b/i],
  ['node tests', /test suite/i],
  ['gate tests', /gate scripts/i],
  ['ui typecheck', /UI typecheck/i],
  ['ui tests', /UI and desktop/i],
  ['desktop tests', /UI and desktop/i],
  ['layering rule', /layering rules?/i],
  ['tracked secrets', /tracked-secrets/i],
  ['reachable methods', /reachable-methods/i],
  ['third-party notices', /third-party notices/i],
  ['design tokens', /design-system gates/i],
  ['design drift', /design-system gates/i],
  ['design doc', /design-system gates/i],
  ['interface drift', /interface drift/i],
  ['recorded claims', /recorded-claims/i],
  ['gate matches CI', /gate-against-CI|gate and CI to one list/i],
  ['codex protocol drift', /Codex protocol drift/i],
  ['steps are documented', /name every step the gate runs/i],
])

/**
 * The section under `heading`, up to the next one of the same level.
 *
 * A heading that is not there is an empty section rather than the whole file:
 * a renamed section should fail loudly, not quietly widen what counts.
 */
export const sectionOf = (text, heading) => {
  const start = text.indexOf(`\n${heading}`)
  if (start === -1) return ''
  const body = text.slice(start + heading.length + 1)
  const next = body.search(/\n## /)
  return next === -1 ? body : body.slice(0, next)
}

/**
 * The steps `verify.mjs` declares, in order.
 *
 * Whole comment lines are dropped first, for the reason `gateCommands` drops
 * them: this file's prose talks about the thing it does, and a note quoting a
 * `step('…')` call would otherwise be a step.
 */
export const stepNames = (raw) => {
  const source = raw
    .split('\n')
    .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n')
  return [...source.matchAll(/\bstep\(\s*(['"])(.*?)\1/g)].map(([, , name]) => name)
}

/** Every step a document does not name, every step nobody described, and every entry for a step that is gone. */
export const problemsWith = (steps, docs, described = DESCRIBED_AS) => {
  const problems = []
  // One line each, so a phrase the wrapping broke in two still reads as itself.
  const flat = Object.entries(docs).map(([file, text]) => [file, text.replace(/\s+/g, ' ')])
  for (const step of steps) {
    const pattern = described.get(step)
    if (pattern === undefined) {
      problems.push(`${step} — no entry here: say how the two documents name it`)
      continue
    }
    for (const [file, text] of flat) {
      if (!pattern.test(text)) problems.push(`${step} — ${file} does not name it (${pattern})`)
    }
  }
  for (const step of described.keys()) {
    if (!steps.includes(step)) problems.push(`${step} — described here, but the gate no longer runs it`)
  }
  return problems
}

/* Both sides through realpath: `import.meta.url` is always resolved through
   symlinks and `process.argv[1]` is whatever was typed, so comparing them any
   other way disables the command through a link, silently, at exit 0. */
const isMain =
  process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  const steps = stepNames(readFileSync(resolve(root, 'script/verify.mjs'), 'utf8'))
  const docs = Object.fromEntries(
    [...SECTIONS].map(([file, heading]) => [file, sectionOf(readFileSync(resolve(root, file), 'utf8'), heading)]),
  )

  const problems = problemsWith(steps, docs)
  if (problems.length > 0) {
    process.stderr.write(
      'These steps of `pnpm verify` are not named where the documents say what it does.\n' +
        'Name them in both sections, and record the wording in DESCRIBED_AS in\n' +
        'script/check-verify-steps.mjs:\n\n',
    )
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    process.exit(1)
  }

  process.stdout.write(`both documents name all ${steps.length} steps the gate runs\n`)
}

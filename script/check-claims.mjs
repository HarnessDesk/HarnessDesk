#!/usr/bin/env node
/**
 * The claims a recording proved, and the tests that keep them true.
 *
 * A scenario recording drives the real app with real agents and asserts what
 * it shows. That is the strongest evidence this repository has — and it was
 * evidence with no half-life: once a take was delivered, nothing connected it
 * to the code again. A rebase demonstrated the cost. Taking another branch's
 * version of four files wholesale dropped three copy fixes *and the two tests
 * that pinned them*, and `pnpm verify` stayed green, because a test cannot
 * fail once it has been deleted along with the thing it was watching.
 *
 * So a recorded claim is written down here with the tests that pin it, and
 * this check enforces the link: every claim must name at least one test, and
 * every named test must still exist. Delete the fix and its test together and
 * verify now says which recording proved the thing you just removed.
 *
 * What this does *not* do is re-run the recordings — they need signed-in
 * vendor agents and minutes of real model time, which no CI runner has. The
 * `recorded` date is a human record of when a live take last showed the claim
 * true. What is mechanically enforced is the link, and that is the half that
 * rots silently.
 *
 *   node script/check-claims.mjs                 # the gate `pnpm verify` runs
 *   node script/check-claims.mjs --adopt <file>  # fold in a run's claims
 *
 * `--adopt` takes the `<name>.claims.json` a recording writes beside its mp4,
 * so the ledger is grown from what a take actually asserted rather than typed
 * out by hand and hoped for.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(root, 'script/recorded-claims.json')

const read = (file) => readFileSync(file, 'utf8')

/**
 * A recording is driven on somebody's own machine, so what it observed carries
 * that machine's home directory. The ledger is published; the home directory is
 * not. Scrub it on the way in, the same shape the diagnostics bundle uses —
 * `/Users/someone/code/x` becomes `~/code/x` — so a take never has to be
 * remembered about. The check below refuses one that slipped through anyway.
 */
/*
 * Anchored, because unanchored it ate URLs: `https://acme.dev/home/settings`
 * became `https://acme.dev~`, corrupting an observation on the way in and —
 * worse — failing a ledger that legitimately recorded one. A home directory
 * starts a path, so it follows the start of the string, whitespace, a quote,
 * an opening bracket, or a `file://`. `/var/home` is where Fedora Silverblue
 * and SteamOS put one.
 */
const HOME_PATH = /(?<=^|[\s"'(=[]|file:\/\/)(?:\/var)?(?:\/Users|\/home)\/[^/\s"']+/g

/*
 * `pinnedBy` is a list of test names, not prose about a machine. A test really
 * called "resolves /Users/alice/repo to root" would have its name rewritten on
 * the way into the ledger and then match no test at all — the scrub silently
 * breaking the very link this file exists to keep.
 */
const scrubHome = (value, key = null) =>
  key === 'pinnedBy'
    ? value
    : typeof value === 'string'
      ? value.replace(HOME_PATH, '~')
      : Array.isArray(value)
        ? value.map((inner) => scrubHome(inner))
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, inner]) => [k, scrubHome(inner, k)]))
          : value

/** Every test name declared in the repo, as `path :: name`. */
const testNames = () => {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      // The desktop shell's tests are plain `.mjs`; a claim about the shell
      // has to be pinnable by them.
      if (!/\.test\.(ts|tsx|mts|mjs)$/.test(entry)) continue
      const relative = full.slice(root.length + 1)
      /* The declaration, not a call: `it(` and `test(` at the start of a line,
         with a quoted name. Either quote — a name containing an apostrophe
         has to be written in double quotes, and reading only single-quoted
         ones made every such test invisible here: the ledger could not cite
         `test("an ACP turn's fold line …")` at all, and said no test by that
         name existed. A name built from a template or a variable is still not
         addressable and must not be cited. */
      for (const match of read(full).matchAll(/^\s*(?:it|test)\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/gm)) {
        const name = match[2].replace(/\\(['"])/g, '$1')
        if (!found.has(name)) found.set(name, [])
        found.get(name).push(relative)
      }
    }
  }
  walk(join(root, 'packages'))
  return found
}

const ledger = JSON.parse(read(LEDGER))

if (process.argv.includes('--adopt')) {
  const file = process.argv[process.argv.indexOf('--adopt') + 1]
  if (!file) {
    console.error('--adopt needs the claims file a recording wrote.')
    process.exit(1)
  }
  const run = JSON.parse(read(file))
  const kept = ledger.recordings.filter((one) => one.scenario !== run.scenario)
  /* Claims a take *failed* are not adopted: the ledger is what a recording
     showed to be true, and folding in a red claim would turn this check into
     a record of what somebody hoped for. */
  // The whole recording, not only its claims: a rig outside this repository
  // writes the envelope — `cast`, `scenario`, anything it grows next — and an
  // unscrubbed field there reaches the published ledger just as easily.
  const proved = run.claims.filter((claim) => claim.held !== false)
  const dropped = run.claims.length - proved.length
  ledger.recordings = [...kept, scrubHome({ ...run, claims: proved })].sort((a, b) =>
    a.scenario.localeCompare(b.scenario),
  )
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`)
  console.log(
    `Adopted ${proved.length} claim(s) from ${run.scenario}${
      dropped > 0 ? ` — ${dropped} the take did not prove were left out` : ''
    }.`,
  )
  process.exit(0)
}

const names = testNames()
const problems = []

for (const recording of ledger.recordings) {
  /* The envelope too — `cast`, `scenario`, whatever a future rig adds beside
     them. Checking only the claims let a home directory ride in on any other
     field of the recording and out into the published file. */
  const envelope = JSON.stringify({ ...recording, claims: undefined }).match(HOME_PATH)
  if (envelope) {
    problems.push(
      `${recording.scenario}: the recording carries a home directory — ${envelope[0]}/… .\n` +
        `      Write it as ~/… ; the ledger is published and the path is not.`,
    )
  }
  for (const claim of recording.claims) {
    /* The ledger ships in the repository, so it may not carry the home
       directory of whoever ran the take. `--adopt` scrubs one out; this is
       the half that catches a claim typed in by hand. */
    const leaked = JSON.stringify(claim).match(HOME_PATH)
    if (leaked) {
      problems.push(
        `${recording.scenario} · ${claim.id}: carries a home directory — ${leaked[0]}/… .\n` +
          `      Write it as ~/… ; the ledger is published and the path is not.`,
      )
    }
    const pinned = claim.pinnedBy ?? []
    if (pinned.length === 0) {
      problems.push(
        `${recording.scenario} · ${claim.id}: proved by a recording and pinned by no test.`,
      )
      continue
    }
    for (const name of pinned) {
      const where = names.get(name)
      if (!where) {
        problems.push(
          `${recording.scenario} · ${claim.id}: no test is called “${name}”.\n` +
            `      The recording showed: ${claim.says}`,
        )
      }
    }
  }
}

const total = ledger.recordings.reduce((sum, one) => sum + one.claims.length, 0)
if (problems.length === 0) {
  console.log(
    `${total} recorded claim(s) across ${ledger.recordings.length} scenario(s), each still pinned.`,
  )
  process.exit(0)
}

console.error('Problems in the recorded-claims ledger:\n')
for (const problem of problems) console.error(`  - ${problem}`)
if (problems.some((problem) => problem.includes('no test is called'))) {
  console.error(
    '\n  A recording of the real app proved these. If the behaviour is gone on purpose,' +
      '\n  drop the claim from script/recorded-claims.json in the same commit and say why.' +
      '\n  If it is not, the test was lost — put it back.',
  )
}
process.exit(1)

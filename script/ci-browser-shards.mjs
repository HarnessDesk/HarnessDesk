#!/usr/bin/env node
// Which browser specs one CI shard runs.
//
// Playwright's own `--shard=n/m` deals the suite out by how many tests each
// shard gets, and a test here takes anywhere from two seconds to three
// minutes: six shards of about the same count took from ten to twenty minutes,
// and the job was as slow as its slowest. This deals the spec *files* out by
// the time they took instead, longest first onto the lightest shard, so the
// shards finish together.
//
//   node script/ci-browser-shards.mjs 3/8     the specs shard 3 of 8 runs, one path per line
//   node script/ci-browser-shards.mjs --count  how many shards the work in the environment needs
//
// What the environment says the run is (CI sets both; both default to the whole suite):
//
//   UI_SYSTEM_MATRIX=pr          a pull request's theme matrix (see playwright.ui-system.config.ts),
//                                dealt by `durations.pr.json`, with missing times scaled from the full table
//   UI_SYSTEM_SPECS='[...]'      only these spec files (a JSON list of `e2e/ui-system/…` paths); an entry
//                                `…spec.ts#a,b` is that spec narrowed to its impact units (script/ui-impact.mjs)
//
// Both tables record test seconds per spec from the `list` reporter:
// `e2e/ui-system/durations.json` measures the dev server with coverage in both
// themes; `durations.pr.json` measures the PR theme matrix without coverage,
// using built pages where supported and the dev server elsewhere. Refresh the
// full table from the last five push runs of `main` that ran the whole suite,
// and the PR table from bounded pull-request runs of `ci.yml`
// (several selections may be needed to cover the suite). A stale table shows up as a shard much slower than its plan.
// A spec neither table knows counts as a typical one in its own regime.
//
//   gh run view <id> --log > run.log
//   node script/ci-browser-shards.mjs --refresh run.log … > e2e/ui-system/durations.json
//
// Write to `e2e/ui-system/durations.pr.json` for the PR run. Only shard jobs
// count in a prefixed run log; a spec's time is the median of its logs.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUITE = 'e2e/ui-system'
const SPEC = /\.spec\.[cm]?[jt]sx?$/

// A shard targets this many recorded test seconds: two workers plus about
// 100 seconds of setup, or 850 seconds (14m 10s) of planned wall time via
// plannedWallSeconds(SHARD_SECONDS, 100). MAX_SHARDS caps the runners, so the
// whole suite carries more per shard and takes about 22 minutes. A selection
// needs fewer runners; each unnecessary shard repeats that setup.
export const SHARD_SECONDS = 1500
export const MAX_SHARDS = 16

// Two workers share the recorded load; headroom checks allow 120 seconds of setup.
export function plannedWallSeconds(load, setupSeconds = 120) {
  return load / 2 + setupSeconds
}

// A spec narrowed to some of its units is weighed as the whole spec: the table has no finer time.
const timeOf = (seconds, spec) => seconds[spec.replace(/#.*$/, '')]

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// Every spec file in the suite, as a path under it, in a stable order.
export function specFiles(root) {
  const walk = directory => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  return walk(join(root, SUITE)).filter(file => SPEC.test(file)).map(file => relative(join(root, SUITE), file)).sort()
}

// Recorded test seconds in this matrix's regime. Missing PR measurements use
// the median PR/full ratio of shared specs, keeping their estimates in PR units.
// Without overlap, the full times still stand in for the missing measurements.
export function recordedSeconds(root, matrix = 'full') {
  const full = JSON.parse(readFileSync(join(root, SUITE, 'durations.json'), 'utf8'))
  const file = join(root, SUITE, 'durations.pr.json')
  if (matrix !== 'pr' || !existsSync(file)) return full
  const pr = JSON.parse(readFileSync(file, 'utf8'))
  const ratio = median(Object.keys(pr).filter(spec => full[spec] !== undefined).map(spec => pr[spec] / full[spec])) ?? 1
  return { ...Object.fromEntries(Object.entries(full).map(([spec, seconds]) => [spec, seconds * ratio])), ...pr }
}

// How many shards the given specs need: enough that each carries about
// SHARD_SECONDS, at least one, at most MAX_SHARDS.
export function shardCount(specs, seconds, { target = SHARD_SECONDS, max = MAX_SHARDS } = {}) {
  const typical = median(Object.values(seconds)) ?? 1
  const total = specs.reduce((sum, spec) => sum + (timeOf(seconds, spec) ?? typical), 0)
  // Never more shards than specs: a shard with nothing to run fails the workflow's guard against an empty deal.
  return Math.min(max, Math.max(1, specs.length), Math.max(1, Math.ceil(total / target)))
}

// The specs a run covers, as paths under the suite: all of them, or the list
// `UI_SYSTEM_SPECS` names. A name that is not a spec of the suite is an error and
// not an empty deal, so a typo cannot turn into a green run of nothing.
export function selectedSpecs(root, selection = process.env.UI_SYSTEM_SPECS) {
  const all = specFiles(root)
  if (!selection || selection === 'all') return all
  const prefix = `${SUITE}/`
  const named = JSON.parse(selection).map(path => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
  const unknown = named.filter(spec => !all.includes(spec.replace(/#.*$/, '')) || /#(?:,|$)|,,|,$/.test(spec))
  if (unknown.length > 0) throw new Error(`not specs of ${SUITE}: ${unknown.join(', ')}`)
  return named.filter((spec, at) => named.indexOf(spec) === at).sort()
}

// Longest first, each onto the shard with the least so far (the first of equals
// wins), which keeps the heaviest shard within the longest single spec of the
// lightest. Deterministic, so the shards of one run never disagree.
export function plan(specs, seconds, total) {
  const typical = median(Object.values(seconds)) ?? 1
  const weight = spec => timeOf(seconds, spec) ?? typical
  const shards = Array.from({ length: total }, () => ({ load: 0, specs: [] }))
  for (const spec of [...specs].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((best, shard) => shard.load < best.load ? shard : best)
    lightest.load += weight(spec)
    lightest.specs.push(spec)
  }
  return shards.map(shard => ({ load: shard.load, specs: shard.specs.sort() }))
}

// Seconds per spec file out of shard jobs' `list` reporter lines in CI logs:
// `✓  12 e2e/ui-system/row-box.spec.ts:81:1 › a title (5.0s)`. A spec's time
// in one log is the sum of its tests; across logs, the median. Unprefixed lines
// count too, so plain shard logs and mixed logs keep working.
export function secondsFromLogs(logs) {
  const timed = /(?:✓|✘)\s+\d+ e2e\/ui-system\/(\S+?\.spec\.[cm]?[jt]sx?):\d+:\d+ › .* \(([\d.]+)(ms|s|m)\)\s*$/
  // A skipped test has no time, but its file is still in the suite and still has to run somewhere.
  const skipped = /-\s+\d+ e2e\/ui-system\/(\S+?\.spec\.[cm]?[jt]sx?):\d+:\d+ › /
  const perLog = new Map()
  for (const log of logs) {
    const sums = new Map()
    for (const text of log.split('\n')) {
      // eslint-disable-next-line no-control-regex
      const plain = text.replace(/\u001b\[[0-9;]*m/g, '')
      // `gh run view --log` puts `<job>\t<step>\t` before every line; a plain shard log has no such prefix.
      const prefix = /^([^\t]+)\t[^\t]*\t/.exec(plain)
      if (prefix && !/^UI system browser integration shard \d+\/\d+$/.test(prefix[1])) continue
      const match = timed.exec(plain)
      if (match) {
        const unit = { ms: 0.001, s: 1, m: 60 }[match[3]]
        sums.set(match[1], (sums.get(match[1]) ?? 0) + Number(match[2]) * unit)
      } else {
        const skip = skipped.exec(plain)
        if (skip && !sums.has(skip[1])) sums.set(skip[1], 0)
      }
    }
    for (const [spec, total] of sums) perLog.set(spec, [...(perLog.get(spec) ?? []), total])
  }
  return Object.fromEntries([...perLog].sort(([a], [b]) => a < b ? -1 : 1).map(([spec, totals]) => [spec, Math.max(1, Math.round(median(totals)))]))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const [first, ...rest] = process.argv.slice(2)
  const matrix = process.env.UI_SYSTEM_MATRIX === 'pr' ? 'pr' : 'full'
  const refuse = message => {
    process.stderr.write(`${message}\n`)
    process.exit(2)
  }
  try {
    if (first === '--refresh') {
      process.stdout.write(`${JSON.stringify(secondsFromLogs(rest.map(file => readFileSync(file, 'utf8'))), null, 2)}\n`)
    } else if (first === '--count') {
      process.stdout.write(`${shardCount(selectedSpecs(root), recordedSeconds(root, matrix))}\n`)
    } else {
      const match = /^(\d+)\/(\d+)$/.exec(first ?? '')
      const index = Number(match?.[1])
      const total = Number(match?.[2])
      if (!match || index < 1 || index > total) refuse('usage: node script/ci-browser-shards.mjs <shard>/<shards>   (for example 3/8)')
      const shard = plan(selectedSpecs(root), recordedSeconds(root, matrix), total)[index - 1]
      process.stdout.write(shard.specs.map(spec => `${SUITE}/${spec}\n`).join(''))
    }
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
}

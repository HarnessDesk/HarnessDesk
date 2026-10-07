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
//
// The times are `e2e/ui-system/durations.json`: seconds per spec file, the
// median of five green runs on `main`, from the `list` reporter's lines. A spec
// the file does not know yet counts as a typical one, so a new spec runs
// somewhere the day it is added and the file only has to be refreshed to make
// the balance exact again:
//
//   node script/ci-browser-shards.mjs --refresh <shard log> … > e2e/ui-system/durations.json
//
// where the logs are those of the shards (`gh run view <id> --log`, any number
// of runs; a spec's time is the median of the logs it appears in).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUITE = 'e2e/ui-system'
const SPEC = /\.spec\.[cm]?[jt]sx?$/

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

export function recordedSeconds(root) {
  return JSON.parse(readFileSync(join(root, SUITE, 'durations.json'), 'utf8'))
}

// Longest first, each onto the shard with the least so far (the first of equals
// wins), which keeps the heaviest shard within the longest single spec of the
// lightest. Deterministic, so the shards of one run never disagree.
export function plan(specs, seconds, total) {
  const typical = median(Object.values(seconds)) ?? 1
  const weight = spec => seconds[spec] ?? typical
  const shards = Array.from({ length: total }, () => ({ load: 0, specs: [] }))
  for (const spec of [...specs].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((best, shard) => shard.load < best.load ? shard : best)
    lightest.load += weight(spec)
    lightest.specs.push(spec)
  }
  return shards.map(shard => ({ load: shard.load, specs: shard.specs.sort() }))
}

// Seconds per spec file out of the `list` reporter's lines in CI logs:
// `✓  12 e2e/ui-system/row-box.spec.ts:81:1 › a title (5.0s)`. A spec's time
// in one log is the sum of its tests; across logs, the median.
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
  if (first === '--refresh') {
    process.stdout.write(`${JSON.stringify(secondsFromLogs(rest.map(file => readFileSync(file, 'utf8'))), null, 2)}\n`)
  } else {
    const match = /^(\d+)\/(\d+)$/.exec(first ?? '')
    const index = Number(match?.[1])
    const total = Number(match?.[2])
    if (!match || index < 1 || index > total) {
      process.stderr.write('usage: node script/ci-browser-shards.mjs <shard>/<shards>   (for example 3/8)\n')
      process.exit(2)
    }
    const shard = plan(specFiles(root), recordedSeconds(root), total)[index - 1]
    process.stdout.write(shard.specs.map(spec => `${SUITE}/${spec}\n`).join(''))
  }
}

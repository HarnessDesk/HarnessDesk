#!/usr/bin/env node
// Which UI unit test files one CI shard runs: longest first onto the lightest
// shard, deterministically. Paths are relative to packages/ui, where Vitest runs.
//
//   node script/ci-unit-shards.mjs 2/4
//   node script/ci-unit-shards.mjs --count
//
// script/ci-unit-durations.json records milliseconds per file from Vitest's
// reporter, not the job's wall time: imports, environments and worker scheduling
// also cost time. Refresh from the last five main push runs that ran all unit
// tests. A stale table shows up as a shard slower than its plan. Unknown files
// count as a typical file (the median); the tree, never the table, names the suite.
//
//   gh run view <id> --log > run.log
//   node script/ci-unit-shards.mjs --refresh run.log … > script/ci-unit-durations.json
//
// Only UI tests and UI unit tests shard <i>/<n> jobs count in prefixed logs.
// A file's time is its reporter number in one log, and the median across logs.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UI = 'packages/ui'

// About 500s recorded in total, with a largest file of 68s: a 125s target
// needs roughly four shards. Each repeats about 60s of install/build, giving
// about 185s planned wall time; more runners mostly repeat setup for less gain.
export const UNIT_SHARD_SECONDS = 125
export const UNIT_MAX_SHARDS = 4

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// CI space-joins the deal and expands it as shell words. No whitespace, shell
// syntax or glob may turn one discovered path into different Vitest filters.
const checkedFiles = files => {
  for (const file of files) {
    if (!/^[\w./@+-]+$/.test(file)) throw new Error(`Unsafe unit test path: ${JSON.stringify(file)}`)
  }
  return files
}

// Exactly the dom includes in vitest.config.ts. NODE_TESTS moves some of these
// to the node project; it adds no files. The completeness test pins that contract.
export function testFiles(root) {
  const walk = directory => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  return checkedFiles(walk(join(root, UI, 'src')).filter(file => /\.test\.tsx?$/.test(file))
    .map(file => relative(join(root, UI), file)).sort())
}

export function recordedMilliseconds(root) {
  return JSON.parse(readFileSync(join(root, 'script/ci-unit-durations.json'), 'utf8'))
}

export function weightsFor(milliseconds) {
  const typical = median(Object.values(milliseconds)) ?? 1
  return file => milliseconds[file] ?? typical
}

export function shardCount(files, milliseconds, { target = UNIT_SHARD_SECONDS * 1000, max = UNIT_MAX_SHARDS } = {}) {
  const weight = weightsFor(milliseconds)
  const total = files.reduce((sum, file) => sum + weight(file), 0)
  return Math.min(max, Math.max(1, files.length), Math.max(1, Math.ceil(total / target)))
}

// The first shard wins ties, as does the alphabetically first file. Keep the
// dealt order, so each shard's command line is longest first too.
export function plan(files, milliseconds, total) {
  const weight = weightsFor(milliseconds)
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }))
  for (const file of [...checkedFiles(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((best, shard) => shard.load < best.load ? shard : best)
    lightest.load += weight(file)
    lightest.files.push(file)
  }
  return shards
}

export function millisecondsFromLogs(logs) {
  const timed = /(?:✓|❯|✘)\s+(?:dom|node)\s+(src\/\S+?\.test\.tsx?)\s+\([^\n]*?tests?[^\n]*?\)\s+(\d+)ms\s*$/
  const perLog = new Map()
  for (const log of logs) {
    const times = new Map()
    for (const text of log.split('\n')) {
      // eslint-disable-next-line no-control-regex
      const plain = text.replace(/\u001b\[[0-9;]*m/g, '')
      // gh run view --log prefixes job, step and timestamp. Filter the job
      // before reading anything after it, even if that text names a unit job.
      const prefix = /^([^\t]+)\t[^\t]*\t/.exec(plain)
      if (prefix && !/^(?:UI tests|UI unit tests shard \d+\/\d+)$/.test(prefix[1])) continue
      const match = timed.exec(plain)
      if (match) times.set(match[1], Number(match[2]))
    }
    for (const [file, time] of times) perLog.set(file, [...(perLog.get(file) ?? []), time])
  }
  return Object.fromEntries([...perLog].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([file, times]) => [file, Math.max(1, Math.round(median(times)))]))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const [first, ...rest] = process.argv.slice(2)
  try {
    if (first === '--refresh') {
      if (rest.length === 0) throw new Error('usage: --refresh <log>…')
      process.stdout.write(`${JSON.stringify(millisecondsFromLogs(rest.map(file => readFileSync(file, 'utf8'))), null, 2)}\n`)
    } else if (first === '--count') {
      process.stdout.write(`${shardCount(testFiles(root), recordedMilliseconds(root))}\n`)
    } else {
      const match = /^(\d+)\/(\d+)$/.exec(first ?? '')
      const index = Number(match?.[1]), total = Number(match?.[2])
      const files = testFiles(root)
      if (!match || index < 1 || index > total || total > Math.max(1, files.length)) {
        throw new Error('usage: node script/ci-unit-shards.mjs <shard>/<shards> (for example 2/4)')
      }
      const shard = plan(files, recordedMilliseconds(root), total)[index - 1]
      process.stdout.write(shard.files.map(file => `${file}\n`).join(''))
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
}

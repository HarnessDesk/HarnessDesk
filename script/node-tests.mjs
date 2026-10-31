#!/usr/bin/env node
/**
 * The Node-package tests, in one place: which files there are, which
 * invocation each runs in, on which runtime and under which deadline, and how
 * CI deals them into jobs that run side by side.
 *
 * This replaced a `find … ! -path …` list kept in three copies (`ci.yml`,
 * `verify.mjs`, the root `test` script) with a step per carved-out glob in
 * each: a file added to a group had to be named five times, and a job could
 * only be as fast as the files somebody had put in it by hand.
 *
 *   node script/node-tests.mjs                  every group, one after another (verify)
 *   node script/node-tests.mjs --group <name>   one group
 *   node script/node-tests.mjs --job <name>     what one CI job runs
 *   node script/node-tests.mjs --plan           the CI jobs, as `node_jobs=<json>`
 *   node script/node-tests.mjs --refresh <seconds.json>…
 *                                               write measured seconds to the table
 *
 * Every invocation reports with `spec`, whose closing summary names each
 * failing test: Node 22 otherwise prints TAP when it is not on a terminal, and
 * a failing file then sits fifty thousand lines up a CI log with nothing at the
 * end to say which it was. With `HD_NODE_TEST_SECONDS=<file>` it also writes
 * each file's measured seconds there, which `--refresh` folds into the table.
 *
 * Nothing here needs an install: CI plans before it installs.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DURATIONS = 'script/node-test-durations.json'

/**
 * Each group is one `node --test` invocation, in this order. A file belongs to
 * the first group whose pattern names it; `unit` takes the rest.
 *
 * - `concurrency`: files at once. Unset is Node's own (cores - 1).
 * - `node`: the major version CI runs it on. The Lead's child and its network
 *   denial probes need a permission model that blocks the network (Node 26).
 */
export const GROUPS = [
  {
    name: 'retention',
    // The 20 real Flow runs settle under heap/CPU budgets and a workload
    // deadline; hundreds of server fixtures beside it would spend them, so it
    // is an invocation of its own and nothing runs beside it.
    patterns: ['packages/server/dist/test/host-retention.test.js'],
    timeout: 120_000, node: 22,
  },
  {
    name: 'end-to-end',
    // On Node 22 `--test-timeout` caps each *file*'s cumulative time, not one
    // test's. These files give each case a ceiling of its own (flow-host-evidence
    // 260s behind a 200s safety dump; intake and the command line 120s and
    // 240s, #1003, #1289), so the file cap has to be wide enough for one case
    // stuck to its ceiling plus the rest of the file run slow under load, or
    // the runner cuts the file before the case can say what did not move.
    patterns: [
      'packages/server/dist/test/flow-host-evidence-*.test.js',
      'packages/server/dist/test/intake-*.test.js',
      'packages/cli/dist/test/e2e*.test.js',
    ],
    timeout: 600_000, node: 22,
  },
  {
    name: 'lead',
    // Service and client fixtures also exercise the supervisor runtime gate;
    // these cases start a real Lead child. The assembly unit tests stay on 22.
    patterns: [
      'packages/lead/dist/test/supervisor.test.js',
      'packages/server/dist/test/lead-service.test.js',
      'packages/server/dist/test/lead-client.test.js',
      'packages/server/dist/test/lead-assembly-child.test.js',
      'packages/server/dist/test/lead-repair-host.test.js',
    ],
    timeout: 120_000, node: 26,
  },
  {
    name: 'lead-e2e',
    // Every case owns a real host, child, restricted door, journal and Flow
    // engine, and keeps a core or two busy: one file at a time.
    patterns: ['packages/server/dist/test/lead-e2e-*.test.js'],
    timeout: 600_000, node: 26, concurrency: 1,
  },
  {
    name: 'unit',
    // A deadline is not about slow tests: a test that hangs must fail by name
    // well inside the job's limit instead of burning it and reporting nothing.
    patterns: [],
    timeout: 120_000, node: 22,
  },
]

const stripComments = text => text.replace(/^\s*\/\/.*$/gm, '')

/** The packages `tsc -b` builds: the solution file's references. */
const builtPackages = root => JSON.parse(stripComments(readFileSync(join(root, 'tsconfig.json'), 'utf8')))
  .references.map(reference => reference.path)

const walk = directory => existsSync(directory)
  ? readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  : []

/**
 * Every compiled test file, named from its source: `test/x.test.ts` builds to
 * `dist/test/x.test.js`. Read from source so CI can deal before it builds;
 * `run` refuses a dealt file the build did not produce.
 */
export const testFiles = (root = ROOT) => builtPackages(root).flatMap(pkg =>
  walk(join(root, pkg, 'test')).filter(file => file.endsWith('.test.ts'))
    .map(file => `${pkg}/dist/${relative(join(root, pkg), file).replace(/\.ts$/, '.js')}`))
  .sort()

const globPattern = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)

/** The group a compiled test file runs in. */
export const groupOf = file => GROUPS.find(group => group.patterns.some(pattern => globPattern(pattern).test(file)))
  ?? GROUPS.find(group => group.name === 'unit')

/** Each group with its files, in run order. */
export const grouped = (files = testFiles()) => GROUPS.map(group => ({ ...group, files: files.filter(file => groupOf(file) === group) }))

export const readSeconds = (root = ROOT) => {
  try { return JSON.parse(readFileSync(join(root, DURATIONS), 'utf8')) } catch { return {} }
}

/**
 * How many CI jobs each runtime's files are dealt into. Sized so no job runs
 * much past five minutes of tests: Node 22 carries the unit and end-to-end
 * groups, Node 26 the Lead's, whose four end-to-end files each fill a job.
 */
export const JOBS = { 22: 3, 26: 4 }

/** Files at once in a group's invocation: its own setting, else Node's default on a four-core runner. */
const parallel = group => group.concurrency ?? 3

/**
 * The CI jobs. Every file of one runtime is dealt, longest first, to the job
 * of that runtime with the least work so far, where a file's work is its
 * recorded seconds over the files its group runs at once (a file with no
 * record counts as the median). A job then runs its files group by group, one
 * invocation each, in `GROUPS` order. Deterministic for one tree, so a job
 * deals itself the same files the plan named.
 */
export const plan = (files = testFiles(), seconds = readSeconds(), jobs = JOBS) => {
  const known = Object.values(seconds).filter(Number.isFinite).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1
  const groups = grouped(files)
  const out = []
  for (const node of [...new Set(groups.map(group => group.node))]) {
    const work = groups.filter(group => group.node === node)
      .flatMap(group => group.files.map(file => ({ file, group, load: (seconds[file] ?? fallback) / parallel(group) })))
      .sort((a, b) => b.load - a.load || a.file.localeCompare(b.file))
    if (work.length === 0) continue
    const bins = Array.from({ length: Math.min(jobs[node] ?? 1, work.length) }, (_, index) => ({ job: `node${node}-${index + 1}`, node, load: 0, files: [] }))
    for (const item of work) {
      const lightest = bins.reduce((best, bin) => bin.load < best.load ? bin : best)
      lightest.files.push(item)
      lightest.load += item.load
    }
    for (const bin of bins) out.push({
      job: bin.job, node, seconds: Math.round(bin.load),
      runs: groups.map(group => ({ group: group.name, files: bin.files.filter(item => item.group.name === group.name).map(item => item.file).sort() }))
        .filter(run => run.files.length > 0),
    })
  }
  return out
}

const invocation = (group, files, record) => {
  const args = ['--test', `--test-timeout=${group.timeout}`]
  if (group.concurrency) args.push(`--test-concurrency=${group.concurrency}`)
  args.push('--test-reporter=spec', '--test-reporter-destination=stdout')
  if (record) args.push(`--test-reporter=${join(ROOT, 'script/lib/test-seconds-reporter.mjs')}`, `--test-reporter-destination=${record}`)
  return [...args, ...files]
}

const execute = (runs, { record } = {}) => {
  let failed = 0
  for (const [index, { group: name, files }] of runs.entries()) {
    const group = GROUPS.find(one => one.name === name)
    const missing = files.filter(file => !existsSync(join(ROOT, file)))
    if (missing.length) {
      console.error(`${name}: not built: ${missing.join(', ')}. Run pnpm run build:node first.`)
      failed = 1
      continue
    }
    if (files.length === 0) continue
    console.log(`\n▶ ${name}: ${files.length} file${files.length === 1 ? '' : 's'}, ${group.timeout / 1000}s per file`)
    const out = record ? resolve(ROOT, `${record}.${index}.json`) : null
    if (out) mkdirSync(dirname(out), { recursive: true })
    const result = spawnSync(process.execPath, invocation(group, files, out), { cwd: ROOT, stdio: 'inherit' })
    if (result.status !== 0) failed = 1
  }
  return failed
}

/** Measured seconds, merged into the table: newest wins, files that no longer exist go. */
export const refresh = (current, measured, files = testFiles()) => {
  const next = { ...current }
  for (const table of measured) for (const [file, value] of Object.entries(table)) next[file] = value
  return Object.fromEntries(Object.entries(next).filter(([file]) => files.includes(file)).sort(([a], [b]) => a.localeCompare(b)))
}

const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [flag, ...rest] = process.argv.slice(2)
  const record = process.env.HD_NODE_TEST_SECONDS || undefined
  if (flag === '--plan') {
    const jobs = plan()
    console.log(`node_jobs=${JSON.stringify(jobs.map(({ job, node }) => ({ job, node })))}`)
    console.log(`summary=Node tests: ${jobs.map(job => `${job.job} (~${job.seconds}s)`).join(', ')}.`)
  } else if (flag === '--job') {
    const job = plan().find(one => one.job === rest[0])
    if (!job) {
      console.error(`No Node test job named ${rest[0]}. Jobs: ${plan().map(one => one.job).join(', ')}`)
      process.exit(1)
    }
    process.exit(execute(job.runs, { record }))
  } else if (flag === '--group') {
    const group = grouped().find(one => one.name === rest[0])
    if (!group) {
      console.error(`No Node test group named ${rest[0]}. Groups: ${GROUPS.map(one => one.name).join(', ')}`)
      process.exit(1)
    }
    process.exit(execute([{ group: group.name, files: group.files }], { record }))
  } else if (flag === '--refresh') {
    const measured = rest.map(file => JSON.parse(readFileSync(file, 'utf8')))
    writeFileSync(join(ROOT, DURATIONS), `${JSON.stringify(refresh(readSeconds(), measured), null, 2)}\n`)
  } else if (flag === undefined) {
    process.exit(execute(grouped().map(group => ({ group: group.name, files: group.files })), { record }))
  } else {
    console.error(`Unknown argument ${flag}. See the comment at the top of script/node-tests.mjs.`)
    process.exit(1)
  }
}

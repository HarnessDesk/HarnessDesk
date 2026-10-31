import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { GROUPS, JOBS, groupOf, grouped, plan, readSeconds, refresh, testFiles } from './node-tests.mjs'
import { TEST_GLOB, globToRegExp } from './prune-dist.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = testFiles(root)

test('the manifest names the compiled tests the build writes, by the glob prune-dist reads', (t) => {
  assert.ok(files.length > 400, 'it finds the repository’s Node tests')
  const glob = globToRegExp(TEST_GLOB)
  assert.deepEqual(files.filter(file => !glob.test(file)), [], 'every file is under packages/*/dist/test')
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  const built = readdirSync(join(root, 'packages')).flatMap(pkg => {
    const directory = join(root, 'packages', pkg, 'dist/test')
    return existsSync(directory) ? walk(directory).filter(file => file.endsWith('.test.js')).map(file => relative(root, file)) : []
  })
  if (built.length === 0) {
    t.skip('nothing is built')
    return
  }
  // A test the build wrote that the manifest does not name would run nowhere.
  assert.deepEqual(built.filter(file => !files.includes(file)), [])
})

test('every test file is dealt to exactly one job, in its own group, on its group’s runtime', () => {
  const jobs = plan(files, readSeconds(root))
  const dealt = jobs.flatMap(job => job.runs.flatMap(run => run.files.map(file => ({ file, job, run }))))
  assert.deepEqual(dealt.map(one => one.file).sort(), [...files].sort(), 'the jobs together run every file once')
  for (const { file, job, run } of dealt) {
    assert.equal(groupOf(file).name, run.group, `${file} runs in its own group's invocation`)
    assert.equal(groupOf(file).node, job.node, `${file} runs on its group's runtime`)
  }
  for (const job of jobs) {
    const order = job.runs.map(run => GROUPS.findIndex(group => group.name === run.group))
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${job.job} runs its groups in manifest order`)
    assert.equal(new Set(job.runs.map(run => run.group)).size, job.runs.length, `${job.job} runs each group once`)
  }
  for (const [node, count] of Object.entries(JOBS)) {
    assert.equal(jobs.filter(job => job.node === Number(node)).length, count, `Node ${node} is dealt into ${count} jobs`)
  }
  assert.deepEqual(plan(files, readSeconds(root)), jobs, 'the same tree deals the same jobs')
})

test('each group pattern still names a test, and the Lead files run on the Lead runtime', () => {
  for (const group of GROUPS) {
    for (const pattern of group.patterns) {
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
      assert.ok(files.some(file => re.test(file)), `${group.name}: ${pattern} matches a test file`)
    }
  }
  const byName = Object.fromEntries(grouped(files).map(group => [group.name, group]))
  assert.ok(byName['lead-e2e'].files.length >= 4, 'the Lead end-to-end cases are split over files')
  assert.ok(byName.lead.files.includes('packages/lead/dist/test/supervisor.test.js'))
  assert.equal(byName.retention.files.length, 1, 'retention runs alone in its invocation')
  assert.ok(byName.unit.files.length > 300, 'everything else is a unit test')
  // `*` in a pattern never crosses a directory (#1052's review: `find -path` did).
  assert.equal(groupOf('packages/server/dist/test/intake-sub/probe.test.js').name, 'unit')
})

test('a file with no recorded seconds counts as the median, and the deal balances by load', () => {
  const sample = ['packages/a/dist/test/big.test.js', 'packages/a/dist/test/b.test.js', 'packages/a/dist/test/c.test.js', 'packages/a/dist/test/d.test.js']
  const jobs = plan(sample, { [sample[0]]: 300, [sample[1]]: 3, [sample[2]]: 3 }, { 22: 2 })
  assert.deepEqual(jobs.map(job => job.runs[0].files), [[sample[0]], sample.slice(1).sort()], 'the big file has a job to itself')
  assert.deepEqual(plan([], {}, { 22: 3 }), [], 'no tests, no jobs')
})

test('refreshing the table keeps measured seconds for files that still exist', () => {
  const next = refresh({ 'packages/a/dist/test/gone.test.js': 9, 'packages/a/dist/test/kept.test.js': 1 },
    [{ 'packages/a/dist/test/kept.test.js': 4, 'packages/a/dist/test/new.test.js': 2 }],
    ['packages/a/dist/test/kept.test.js', 'packages/a/dist/test/new.test.js'])
  assert.deepEqual(next, { 'packages/a/dist/test/kept.test.js': 4, 'packages/a/dist/test/new.test.js': 2 })
})

test('CI runs the planned jobs on the planned runtimes, reporting with spec', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
  const job = workflow.slice(workflow.indexOf('\n  node-tests:\n'), workflow.indexOf('\n  ui-typecheck:\n'))
  assert.match(job, /include: \$\{\{ fromJSON\(needs\.changes\.outputs\.node_jobs\) \}\}/)
  assert.match(job, /node-version: \$\{\{ matrix\.node \}\}/)
  assert.match(job, /NODE_JOB: \$\{\{ matrix\.job \}\}/)
  assert.match(job, /run: node script\/node-tests\.mjs --job \$NODE_JOB/)
  assert.match(workflow, /node_jobs: \$\{\{ steps\.paths\.outputs\.node_jobs \}\}/)
  assert.match(workflow, /node script\/node-tests\.mjs --plan/)
  const runner = readFileSync(join(root, 'script/node-tests.mjs'), 'utf8')
  assert.match(runner, /'--test-reporter=spec', '--test-reporter-destination=stdout'/)
})

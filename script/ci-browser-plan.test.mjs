import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { MAX_SHARDS, SHARD_SECONDS, plan, plannedWallSeconds, recordedSeconds, secondsFromLogs, selectedSpecs, shardCount, specFiles } from './ci-browser-shards.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const CLI = fileURLToPath(new URL('./ci-browser-shards.mjs', import.meta.url))
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

const durationRoot = (t, full, pr) => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-duration-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const suite = join(directory, 'e2e/ui-system')
  mkdirSync(suite, { recursive: true })
  writeFileSync(join(suite, 'durations.json'), JSON.stringify(full))
  if (pr !== undefined) writeFileSync(join(suite, 'durations.pr.json'), JSON.stringify(pr))
  return directory
}

test('missing pull-request times use the median ratio of shared specs', t => {
  const full = { 'alpha.spec.ts': 100, 'beta.spec.ts': 200, 'gamma.spec.ts': 300, 'missing.spec.ts': 80 }
  const pr = { 'alpha.spec.ts': 25, 'beta.spec.ts': 100, 'gamma.spec.ts': 600 }
  const directory = durationRoot(t, full, pr)
  assert.deepEqual(recordedSeconds(directory, 'pr'), { ...pr, 'missing.spec.ts': 40 })
  assert.deepEqual(recordedSeconds(directory, 'full'), full, 'the full matrix keeps its recorded times')
})

test('pull-request times without shared specs fall back to the full times', t => {
  const full = { 'alpha.spec.ts': 100 }
  const pr = { 'beta.spec.ts': 30 }
  assert.deepEqual(recordedSeconds(durationRoot(t, full, pr), 'pr'), { ...full, ...pr })
})

test('a missing pull-request table keeps the full times', t => {
  const full = { 'alpha.spec.ts': 100 }
  assert.deepEqual(recordedSeconds(durationRoot(t, full), 'pr'), full)
})

test('recording either browser baseline stays serial even on CI with a worker override', () => {
  for (const flag of ['UPDATE_METRICS', 'UPDATE_ALIGNMENT']) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      "import config from './playwright.ui-system.config.ts'; console.log(JSON.stringify({ workers: config.workers, fullyParallel: config.fullyParallel }))",
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', PLAYWRIGHT_UI_SYSTEM_WORKERS: '2', UPDATE_METRICS: '0', UPDATE_ALIGNMENT: '0', [flag]: '1' },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), { workers: 1, fullyParallel: false }, flag)
  }
})

test('every spec runs on exactly one shard, however many shards there are', () => {
  const specs = specFiles(root)
  assert.ok(specs.length > 50, 'the suite is found')
  for (const total of [1, 2, 3, 6, 8, 12, 16]) {
    const dealt = plan(specs, recordedSeconds(root), total).flatMap(shard => shard.specs)
    assert.deepEqual([...dealt].sort(), specs, `${total} shards`)
  }
})

test('the browser matrix is the planner\'s shards, numbered from one, and the job names the count it was dealt', () => {
  const job = workflow.match(/ui-system-browser:[\s\S]*?(?=\n  [\w-]+:\n)/)?.[0] ?? ''
  assert.match(job, /shard:\s*\$\{\{\s*fromJSON\(needs\.changes\.outputs\.shards\)\s*\}\}/, 'the matrix is the list the planner printed')
  assert.match(job, /ci-browser-shards\.mjs \$\{\{ matrix\.shard \}\}\/\$\{\{ needs\.changes\.outputs\.shard_count \}\}/, 'each shard deals against the same count')
})

for (const matrix of ['full', 'pr']) {
  test(`the ${matrix} suite's heaviest planned shard is at most 1.15 times its mean`, () => {
    const specs = specFiles(root)
    const seconds = recordedSeconds(root, matrix)
    const count = matrix === 'full' ? MAX_SHARDS : shardCount(specs, seconds)
    const loads = plan(specs, seconds, count).map(shard => shard.load)
    const mean = loads.reduce((sum, load) => sum + load, 0) / loads.length
    const heaviest = Math.max(...loads)
    assert.ok(heaviest <= mean * 1.15, `${matrix}: max/mean ${heaviest / mean} at ${count} shards; refresh the times or split a heavy spec`)
  })
}

test('the deal is longest first onto the lightest shard, and the same every time', () => {
  const seconds = { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, g: 3 }
  const specs = Object.keys(seconds)
  const dealt = plan(specs, seconds, 3)
  // a, b, c take one shard each; d joins the lightest (c's), e the next (b's), f the next (a's); g finds all three level and takes the first.
  assert.deepEqual(dealt.map(shard => shard.specs), [['a', 'f', 'g'], ['b', 'e'], ['c', 'd']])
  assert.deepEqual(dealt.map(shard => shard.load), [16, 13, 13])
  assert.deepEqual(plan([...specs].reverse(), seconds, 3), dealt)
})

test('a spec nobody has timed yet still runs, counted as a typical one', () => {
  const dealt = plan(['known-a', 'known-b', 'known-c', 'new'], { 'known-a': 30, 'known-b': 30, 'known-c': 30 }, 2)
  assert.deepEqual(dealt.flatMap(shard => shard.specs).sort(), ['known-a', 'known-b', 'known-c', 'new'])
  assert.equal(dealt.reduce((sum, shard) => sum + shard.load, 0), 120)
})

test('a shard is printed as the paths Playwright is given', () => {
  const run = spawnSync(process.execPath, [CLI, '2/8'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const paths = run.stdout.trim().split('\n')
  assert.ok(paths.length > 5)
  for (const path of paths) {
    assert.match(path, /^e2e\/ui-system\/[\w./-]+\.spec\.ts$/)
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path)
  }
  for (const wrong of ['0/8', '9/8', '2', 'x/8', '']) {
    const refused = spawnSync(process.execPath, [CLI, wrong], { encoding: 'utf8' })
    assert.equal(refused.status, 2, `${wrong} is refused`)
    assert.equal(refused.stdout, '')
  }
})

test('the refresh reads the list reporter: a spec is the sum of its tests, the median of the logs it appears in', () => {
  const first = [
    '2026-10-07T17:43:56.6588235Z   ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (11.2s)',
    '2026-10-07T17:44:07.1028894Z   ✓    2 e2e/ui-system/alpha.spec.ts:30:3 › two (500ms)',
    '2026-10-07T17:44:12.1475912Z   ✓    3 e2e/ui-system/beta.spec.ts:81:1 › three (1m)',
    '2026-10-07T17:44:12.1475912Z   -    4 e2e/ui-system/gamma.spec.ts:5:1 › skipped, so it has no time',
    '2026-10-07T17:44:12.1475912Z \u001b[32m  ✓\u001b[39m    5 e2e/ui-system/delta.spec.ts:9:1 › coloured (2.0s)',
    'Running 5 tests using 1 worker, shard 1 of 6',
  ].join('\n')
  const second = '  ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (20.0s)\n  ✘    2 e2e/ui-system/alpha.spec.ts:30:3 › two (4.0s)\n'
  const third = '  ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (1.0s)\n'
  assert.deepEqual(secondsFromLogs([first]), { 'alpha.spec.ts': 12, 'beta.spec.ts': 60, 'delta.spec.ts': 2, 'gamma.spec.ts': 1 })
  assert.equal(secondsFromLogs([first, second, third])['alpha.spec.ts'], 12, 'the middle of 11.7, 24 and 1')
})

test('the refresh counts only shard jobs in a prefixed run log', () => {
  const log = [
    'UI system browser integration shard 2/16\tRun browser specs\t2026-10-07T17:43:56Z \u001b[32m  ✓\u001b[39m    1 e2e/ui-system/alpha.spec.ts:12:3 › one (11.2s)',
    'UI system pages\tTry the build\t2026-10-07T17:44:07Z   ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (20.0s)',
    'UI system pages\tTry the build\t2026-10-07T17:44:12Z   -    2 e2e/ui-system/build-only.spec.ts:5:1 › skipped',
  ].join('\n')
  assert.deepEqual(secondsFromLogs([log]), { 'alpha.spec.ts': 11 })
})

test('the refresh drops a prefixed job line whatever follows the prefix', () => {
  const log = [
    'UI system browser integration shard 2/16\tRun browser specs\t2026-10-07T17:43:56.123Z   ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (11.2s)',
    'UI system pages\tTry the build\talpha ran   ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (20.0s)',
    'UI system pages\tTry the build\t   ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (20.0s)',
  ].join('\n')
  assert.deepEqual(secondsFromLogs([log]), { 'alpha.spec.ts': 11 })
})

test('the refresh handles prefixed and plain lines in the same log', () => {
  const log = [
    'UI system browser integration shard 1/2\tRun browser specs\t2026-10-07T17:43:56Z   ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (10.0s)',
    'UI system pages\tTry the build\t2026-10-07T17:44:07Z   ✓    1 e2e/ui-system/alpha.spec.ts:12:3 › one (20.0s)',
    '2026-10-07T17:44:12Z   ✘    2 e2e/ui-system/alpha.spec.ts:30:3 › two (5.0s)',
    '  -    3 e2e/ui-system/beta.spec.ts:5:1 › skipped',
  ].join('\n')
  assert.deepEqual(secondsFromLogs([log]), { 'alpha.spec.ts': 15, 'beta.spec.ts': 1 })
})

const withEnv = (env, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, UI_SYSTEM_MATRIX: '', UI_SYSTEM_SPECS: '', ...env } })

test('shards are sized to the work: at least one, enough that each carries about SHARD_SECONDS, never more than MAX_SHARDS', () => {
  const seconds = { a: 10, b: 20, c: 30 }
  assert.equal(shardCount([], seconds), 1)
  assert.equal(shardCount(['a'], seconds), 1)
  assert.equal(shardCount(['a', 'b', 'c'], seconds), 1)
  assert.equal(shardCount(['a', 'b', 'c'], seconds, { target: 30 }), 2)
  assert.equal(shardCount(['a', 'b', 'c'], seconds, { target: 20 }), 3)
  assert.equal(shardCount(['a', 'b', 'c', 'd', 'e'], { ...seconds, d: 40, e: 50 }, { target: 1, max: 4 }), 4, 'the cap, when there are more specs than the cap')
  assert.equal(shardCount(['a', 'b', 'c'], seconds, { target: 1, max: 4 }), 3, 'and never an empty shard')
  assert.equal(shardCount(['new'], seconds, { target: 20 }), 1, 'a spec nobody has timed counts as a typical one')
})

test('MAX_SHARDS caps the runners for the whole suite in either matrix', () => {
  const specs = specFiles(root)
  for (const matrix of ['full', 'pr']) {
    const seconds = recordedSeconds(root, matrix)
    assert.ok(shardCount(specs, seconds) <= MAX_SHARDS, `${matrix} must not ask for more than ${MAX_SHARDS} runners`)
  }
})

test('a selection never asks for more shards than it has specs', () => {
  assert.equal(shardCount(['big.spec.ts'], { 'big.spec.ts': 2600 }), 1, 'one spec cannot fill two shards')
  assert.equal(shardCount(['a', 'b'], { a: 5000, b: 5000 }), 2)
  assert.equal(shardCount([], {}), 1)
})

test('planned wall time shares recorded seconds between two workers and adds setup', () => {
  assert.equal(plannedWallSeconds(SHARD_SECONDS, 100), 850)
  assert.equal(plannedWallSeconds(SHARD_SECONDS), 870)
})

test('the full suite plans at most 25 minutes for its heaviest shard at MAX_SHARDS', () => {
  const specs = specFiles(root)
  const loads = plan(specs, recordedSeconds(root, 'full'), MAX_SHARDS).map(shard => shard.load)
  const wall = plannedWallSeconds(Math.max(...loads), 120)
  assert.ok(wall <= 25 * 60, `${MAX_SHARDS} shards plan a heaviest wall time of ${Math.round(wall)}s; the suite has outgrown that many runners`)
})

test('the pull-request table is lighter overall and both tables name only suite specs', () => {
  const full = JSON.parse(readFileSync(new URL('../e2e/ui-system/durations.json', import.meta.url), 'utf8'))
  const own = JSON.parse(readFileSync(new URL('../e2e/ui-system/durations.pr.json', import.meta.url), 'utf8'))
  const pr = recordedSeconds(root, 'pr')
  const total = seconds => Object.values(seconds).reduce((sum, value) => sum + value, 0)
  assert.ok(total(own) < total(full), 'the pull-request table records less total test time')
  const smaller = Object.keys(own).filter(spec => own[spec] < full[spec])
  assert.ok(smaller.length > 10, 'the geometry contracts take less in a pull request')
  const suite = new Set(specFiles(root))
  for (const [name, seconds] of [['durations.json', full], ['durations.pr.json', own]]) {
    for (const spec of Object.keys(seconds)) assert.ok(suite.has(spec), `${name} names ${spec}, which is not a spec`)
  }
  // A spec neither table knows yet is dealt as a typical one (the day it is added), so only the timed ones are held to an entry.
  for (const spec of Object.keys(full)) assert.ok(Object.hasOwn(pr, spec), `the pull-request plan needs a time for ${spec}`)
})

test('a selection narrows the deal to the named specs and refuses a name that is no spec', () => {
  const specs = specFiles(root)
  assert.deepEqual(selectedSpecs(root, 'all'), specs)
  assert.deepEqual(selectedSpecs(root, ''), specs)
  assert.deepEqual(selectedSpecs(root, undefined), specs)
  assert.deepEqual(selectedSpecs(root, JSON.stringify(['e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/rules.spec.ts'])), ['row-box.spec.ts', 'rules.spec.ts'])
  assert.throws(() => selectedSpecs(root, JSON.stringify(['e2e/ui-system/not-a-spec.spec.ts'])), /not specs of e2e\/ui-system: not-a-spec\.spec\.ts/)
})

test('Lead real-host and flag-off specs are both selectable in each browser matrix', () => {
  const names = ['lead-hidden.spec.ts', 'lead.spec.ts']
  const selection = JSON.stringify(names.map(name => `e2e/ui-system/${name}`))
  assert.deepEqual(selectedSpecs(root, selection), names)
  for (const matrix of ['full', 'pr']) {
    const dealt = plan(names, recordedSeconds(root, matrix), 2).flatMap(shard => shard.specs).sort()
    assert.deepEqual(dealt, names, matrix)
  }
})

test('the command line deals a selection across the shards the selection needs, and counts them', () => {
  const selection = JSON.stringify(['e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/rules.spec.ts'])
  assert.equal(withEnv({ UI_SYSTEM_SPECS: selection }, '--count').stdout.trim(), '1')
  assert.equal(withEnv({ UI_SYSTEM_SPECS: selection }, '1/1').stdout, 'e2e/ui-system/row-box.spec.ts\ne2e/ui-system/rules.spec.ts\n')
  const full = Number(withEnv({}, '--count').stdout)
  const pr = Number(withEnv({ UI_SYSTEM_MATRIX: 'pr' }, '--count').stdout)
  assert.ok(pr > 0 && pr <= full, `${pr} <= ${full}`)
  const refused = withEnv({ UI_SYSTEM_SPECS: JSON.stringify(['e2e/ui-system/typo.spec.ts']) }, '1/1')
  assert.equal(refused.status, 2)
  assert.equal(refused.stdout, '')
})

test('every shard of a run together run every selected spec once', () => {
  const dealt = []
  const count = Number(withEnv({ UI_SYSTEM_MATRIX: 'pr' }, '--count').stdout)
  for (let shard = 1; shard <= count; shard += 1) dealt.push(...withEnv({ UI_SYSTEM_MATRIX: 'pr' }, `${shard}/${count}`).stdout.trim().split('\n'))
  assert.deepEqual(dealt.sort(), specFiles(root).map(spec => `e2e/ui-system/${spec}`))
})

// The pull-request matrix leaves the dark half of the geometry contracts for main
// (playwright.ui-system.config.ts). That is safe only while those specs assert
// geometry; this finds the day one of them starts to assert a colour.
const configOf = matrix => {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    "import config, { COLOUR_SPECS, geometryInDark } from './playwright.ui-system.config.ts'; console.log(JSON.stringify({ grepInvert: config.grepInvert ? config.grepInvert.source : null, COLOUR_SPECS, source: geometryInDark.source }))",
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true', UI_SYSTEM_MATRIX: matrix } })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout)
}

test('only the pull-request matrix skips anything, and only through the one pattern', () => {
  assert.equal(configOf('').grepInvert, null)
  assert.equal(configOf('full').grepInvert, null)
  const pr = configOf('pr')
  assert.equal(pr.grepInvert, pr.source)
})

test('the pattern skips a dark geometry case and nothing else', () => {
  const { source } = configOf('pr')
  const skips = new RegExp(source)
  // Playwright matches the project name, the file and the title joined by spaces.
  const title = (file, name) => ` ${file}.spec.ts ${name}`
  assert.ok(skips.test(title('frame-contract-popup-menus', 'C10 exhaustive popup contracts a, b at 720 in dark')))
  assert.ok(skips.test(title('frame-fix5-settings5', 'S5 rows at 1440 in dark')))
  assert.ok(!skips.test(title('frame-contract-popup-menus', 'C10 exhaustive popup contracts a, b at 720 in light')))
  assert.ok(!skips.test(title('frame-contract-popup-menus', 'a case that names no theme')))
  assert.ok(!skips.test(title('frame-contract-menus', 'S22 disabled popup rows share one ink in dark')), 'a colour spec reads both themes')
  assert.ok(!skips.test(title('frame-contract-tools', 'tools in dark')), 'a colour spec reads both themes')
  assert.ok(!skips.test(title('row-box', 'rows in dark')), 'only the frame specs are on the pull-request matrix')
  assert.ok(!skips.test(title('flow-canvas', 'edges in dark')), 'only the frame specs are on the pull-request matrix')
  assert.ok(skips.test(title('frame-contract-menus-extra', 'in dark')), 'a spec that merely starts like a colour spec is a different spec')
})

test('a frame spec that asserts a colour is listed, so it reads both themes', () => {
  const { COLOUR_SPECS } = configOf('pr')
  const colour = /contrast|luminance|[cC]olor\b|backgroundColor|rgb\(|--hd-ink|toHaveCSS|boxShadow|opacity/
  const unlisted = specFiles(root)
    .filter(spec => /^frame-.*\.spec\.ts$/.test(spec))
    .filter(spec => !COLOUR_SPECS.includes(spec.replace(/\.spec\.ts$/, '')))
    .filter(spec => colour.test(readFileSync(new URL(`../e2e/ui-system/${spec}`, import.meta.url), 'utf8')))
  assert.deepEqual(unlisted, [], 'add these to COLOUR_SPECS in playwright.ui-system.config.ts, so a pull request reads their dark cases')
  for (const name of COLOUR_SPECS) assert.ok(existsSync(new URL(`../e2e/ui-system/${name}.spec.ts`, import.meta.url)), `${name} is listed but is no spec`)
})

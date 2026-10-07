import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { plan, recordedSeconds, secondsFromLogs, specFiles } from './ci-browser-shards.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const CLI = fileURLToPath(new URL('./ci-browser-shards.mjs', import.meta.url))

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
  for (const total of [1, 2, 3, 6, 8, 12]) {
    const dealt = plan(specs, recordedSeconds(root), total).flatMap(shard => shard.specs)
    assert.deepEqual([...dealt].sort(), specs, `${total} shards`)
  }
})

test('the shards of the recorded suite finish together', () => {
  const loads = plan(specFiles(root), recordedSeconds(root), 8).map(shard => shard.load)
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length
  assert.ok(Math.max(...loads) - Math.min(...loads) <= mean * 0.1, `loads ${loads.join(', ')}`)
})

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

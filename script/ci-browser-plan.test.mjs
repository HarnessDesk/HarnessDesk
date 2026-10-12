import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { MAX_SHARDS, SHARD_SECONDS, plan, recordedSeconds, secondsFromLogs, selectedSpecs, shardCount, specFiles } from './ci-browser-shards.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const CLI = fileURLToPath(new URL('./ci-browser-shards.mjs', import.meta.url))
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

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

test('the shards of the recorded suite finish together', () => {
  const specs = specFiles(root)
  const seconds = recordedSeconds(root)
  const loads = plan(specs, seconds, shardCount(specs, seconds)).map(shard => shard.load)
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

const withEnv = (env, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, UI_SYSTEM_MATRIX: '', UI_SYSTEM_SPECS: '', ...env } })

test('shards are sized to the work: at least one, enough that each carries about SHARD_SECONDS, never more than MAX_SHARDS', () => {
  const seconds = { a: 10, b: 20, c: 30 }
  assert.equal(shardCount([], seconds), 1)
  assert.equal(shardCount(['a'], seconds), 1)
  assert.equal(shardCount(['a', 'b', 'c'], seconds), 1)
  assert.equal(shardCount(['a', 'b', 'c'], seconds, { target: 30 }), 2)
  assert.equal(shardCount(['a', 'b', 'c'], seconds, { target: 20 }), 3)
  assert.equal(shardCount(['a', 'b', 'c'], seconds, { target: 1, max: 4 }), 4)
  assert.equal(shardCount(['new'], seconds, { target: 20 }), 1, 'a spec nobody has timed counts as a typical one')
})

test('the suite never leaves a shard much heavier than SHARD_SECONDS, in either matrix', () => {
  const specs = specFiles(root)
  for (const matrix of ['full', 'pr']) {
    const seconds = recordedSeconds(root, matrix)
    const needed = shardCount(specs, seconds, { max: Infinity })
    const carried = specs.reduce((sum, spec) => sum + (seconds[spec] ?? 0), 0) / Math.min(needed, MAX_SHARDS)
    // MAX_SHARDS stops a big suite from asking for more runners than the account has; the shards then carry more.
    assert.ok(carried <= SHARD_SECONDS * 1.5, `${matrix}: ${Math.round(carried)}s a shard at ${Math.min(needed, MAX_SHARDS)} shards (${needed} would carry ${SHARD_SECONDS}s); split a big spec, or raise MAX_SHARDS and the runners it needs`)
  }
})

test('the pull-request matrix is dealt by its own times, which are never above the full ones', () => {
  const full = recordedSeconds(root, 'full')
  const pr = recordedSeconds(root, 'pr')
  assert.deepEqual(Object.keys(pr).sort(), Object.keys(full).sort())
  const smaller = Object.keys(pr).filter(spec => pr[spec] < full[spec])
  assert.ok(smaller.length > 10, 'the geometry contracts take less in a pull request')
  for (const spec of Object.keys(pr)) assert.ok(pr[spec] <= full[spec], spec)
  const own = JSON.parse(readFileSync(new URL('../e2e/ui-system/durations.pr.json', import.meta.url), 'utf8'))
  const suite = new Set(specFiles(root))
  for (const spec of Object.keys(own)) assert.ok(suite.has(spec), `durations.pr.json names ${spec}, which is not a spec`)
})

test('the shards of a pull request finish together too', () => {
  const specs = specFiles(root)
  const seconds = recordedSeconds(root, 'pr')
  const loads = plan(specs, seconds, shardCount(specs, seconds)).map(shard => shard.load)
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length
  assert.ok(Math.max(...loads) - Math.min(...loads) <= mean * 0.1, `loads ${loads.join(', ')}`)
})

test('a selection narrows the deal to the named specs and refuses a name that is no spec', () => {
  const specs = specFiles(root)
  assert.deepEqual(selectedSpecs(root, 'all'), specs)
  assert.deepEqual(selectedSpecs(root, ''), specs)
  assert.deepEqual(selectedSpecs(root, undefined), specs)
  assert.deepEqual(selectedSpecs(root, JSON.stringify(['e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/rules.spec.ts'])), ['row-box.spec.ts', 'rules.spec.ts'])
  assert.throws(() => selectedSpecs(root, JSON.stringify(['e2e/ui-system/not-a-spec.spec.ts'])), /not specs of e2e\/ui-system: not-a-spec\.spec\.ts/)
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

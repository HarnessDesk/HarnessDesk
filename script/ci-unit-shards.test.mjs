import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { UNIT_MAX_SHARDS, UNIT_SHARD_SECONDS, millisecondsFromLogs, plan, recordedMilliseconds, shardCount, testFiles, weightsFor } from './ci-unit-shards.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = testFiles(root)
const times = recordedMilliseconds(root)
const count = shardCount(files, times)
const shards = plan(files, times, count)
const cli = args => spawnSync(process.execPath, [join(root, 'script/ci-unit-shards.mjs'), ...args], { encoding: 'utf8' })
const assertLongestFirst = (deal, milliseconds) => {
  const weight = weightsFor(milliseconds)
  for (const shard of deal) {
    const weights = shard.files.map(weight)
    assert.ok(weights.every(Number.isFinite), 'every dealt file has an effective weight')
    assert.deepEqual(weights, [...weights].sort((a, b) => b - a))
  }
}

test('the ordering guard accepts a new test absent from the duration table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-unknown-'))
  try {
    mkdirSync(join(dir, 'packages/ui/src'), { recursive: true })
    for (const name of ['heavy', 'new', 'light']) writeFileSync(join(dir, `packages/ui/src/${name}.test.ts`), '')
    const measured = { 'src/heavy.test.ts': 10, 'src/light.test.ts': 2 }
    const deal = plan(testFiles(dir), measured, 1)
    assert.deepEqual(deal, [{ load: 18, files: ['src/heavy.test.ts', 'src/new.test.ts', 'src/light.test.ts'] }])
    assertLongestFirst(deal, measured)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('longest first onto the lightest shard, with stable ties and a typical unknown file', () => {
  const input = ['d', 'c', 'b', 'a', 'unknown']
  const measured = { a: 10, b: 8, c: 4, d: 2 }
  assert.deepEqual(plan(input, measured, 2), [
    { load: 16, files: ['a', 'c', 'd'] },
    { load: 14, files: ['b', 'unknown'] },
  ])
  assert.deepEqual(plan([...input].reverse(), measured, 2), plan(input, measured, 2))
  assert.deepEqual(plan(['b', 'a'], { a: 1, b: 1 }, 2).map(shard => shard.files), [['a'], ['b']])
})

test('the real tree is dealt once, deterministically, with each shard longest first', () => {
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), files)
  assert.equal(new Set(shards.flatMap(shard => shard.files)).size, files.length)
  assert.deepEqual(plan([...files].reverse(), times, count), shards)
  assertLongestFirst(shards, times)
  for (let index = 1; index <= count; index++) {
    const result = cli([`${index}/${count}`])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split('\n'), shards[index - 1].files)
  }
})

test('a fixture tree includes only the two Vitest test suffixes under src', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-shards-'))
  try {
    const input = ['src/z.test.ts', 'src/nested/a.test.tsx', 'src/helper.ts', 'src/no.test.mts', 'site-demo/no.test.ts']
    for (const path of input) {
      mkdirSync(join(dir, 'packages/ui', path, '..'), { recursive: true })
      writeFileSync(join(dir, 'packages/ui', path), '')
    }
    const found = testFiles(dir)
    assert.deepEqual(found, ['src/nested/a.test.tsx', 'src/z.test.ts'])
    const deal = plan(found, {}, 2)
    assert.deepEqual(deal.flatMap(shard => shard.files).sort(), found)
    assert.deepEqual(plan([...found].reverse(), {}, 2), deal)
    mkdirSync(join(dir, 'script'))
    for (const path of ['ci-unit-shards.mjs', 'ci-unit-durations.json']) cpSync(join(root, 'script', path), join(dir, 'script', path))
    assert.equal(existsSync(join(dir, 'node_modules')), false)
    const result = spawnSync(process.execPath, ['script/ci-unit-shards.mjs', '--count'], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), String(shardCount(found, times)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('count is bounded by the target, cap and file count, with at least one shard', () => {
  assert.equal(shardCount([], {}), 1)
  assert.equal(shardCount(['a'], { a: 1 }), 1)
  assert.equal(shardCount(['a', 'b'], { a: 1000000, b: 1000000 }), 2)
  assert.equal(shardCount(Array.from({ length: 100 }, (_, i) => String(i)), {}, { target: 1, max: 3 }), 3)
  assert.equal(shardCount(['a', 'unknown'], { a: 100 }, { target: 100 }), 2)
  assert.ok(count >= 1 && count <= UNIT_MAX_SHARDS && count <= files.length)
  assert.ok(UNIT_SHARD_SECONDS > 0)
  assert.equal(cli(['--count']).stdout.trim(), String(count))
  for (const arg of ['0/4', '5/4', '1/0', 'bad']) assert.equal(cli([arg]).status, 2, arg)
})

const assertVitestContract = (config, node, planned) => {
  const message = 'Vitest selection changed: update script/ci-unit-shards.mjs and its completeness test'
  const clean = config.split('\n').filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n')
  // Both the planner and selector know only @/ -> src. Pin its mapping too,
  // refusing extra aliases, array aliases and per-project overrides.
  assert.equal([...clean.matchAll(/(?:\balias|['"]alias['"])\s*:/g)].length, 1, message)
  assert.match(clean, /(?:\balias|['"]alias['"])\s*:\s*\{\s*['"]@['"]\s*:\s*fileURLToPath\(\s*new URL\(\s*['"]\.\/src['"]\s*,\s*import\.meta\.url\s*\)\s*\)\s*,?\s*\}/, message)
  for (const [, specifier] of clean.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"`]([^'"`\n]+)['"`]/g)) {
    assert.ok(specifier.startsWith('node:') || specifier === 'vitest/config' || specifier === './vitest.node-tests.ts', message)
  }
  assert.doesNotMatch(clean, /\b(?:includeSource|typecheck|browser|workspace)\s*:/, message)
  assert.equal([...clean.matchAll(/\bprojects\s*:/g)].length, 1, message)
  assert.deepEqual([...clean.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)].map(([, name]) => name), ['dom', 'node'], message)
  // Count top-level project objects, refusing strings, spreads and anonymous
  // extra projects too. Discovery below remains the authority over the result.
  const skeleton = clean.replace(/(['"`])[^]*?\1/g, '_')
  const projectBody = skeleton.slice(skeleton.indexOf('projects: [') + 'projects: ['.length)
  let depth = 0, projects = 0
  for (const char of projectBody) {
    if (char === ']' && depth === 0) break
    if (/[{[(]/.test(char)) {
      if (depth === 0) { assert.equal(char, '{', message); projects++ }
      depth++
    } else if (/[}\])]/.test(char)) depth--
    else if (depth === 0) assert.match(char, /[\s,]/, message)
  }
  assert.equal(projects, 2, message)
  assert.deepEqual([...config.matchAll(/include:\s*(\[[^\]]*\])/g)].map(match => match[1]),
    ["['src/**/*.test.ts', 'src/**/*.test.tsx']", '[...NODE_TESTS]'], message)
  assert.match(config, /import \{ NODE_TESTS \} from '\.\/vitest\.node-tests\.ts'/, message)
  assert.match(config, /exclude: \[\.\.\.configDefaults\.exclude, \.\.\.NODE_TESTS\]/, message)
  const body = node.match(/export const NODE_TESTS: readonly string\[\] = \[([^]*?)\]\s*;?\s*$/)?.[1]
  assert.ok(body, message)
  assert.match(body.replace(/'[^']*'/g, '_'), /^\s*(?:_\s*,\s*)+$/, message)
  const nodeFiles = [...body.matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.equal(new Set(nodeFiles).size, nodeFiles.length, message)
  assert.ok(nodeFiles.length > 0, message)
  for (const file of nodeFiles) assert.ok(planned.includes(file), `${message}: ${file}`)
  assert.equal([...config.matchAll(/exclude:/g)].length, 1, message)
}

const config = readFileSync(join(root, 'packages/ui/vitest.config.ts'), 'utf8')
const nodeConfig = readFileSync(join(root, 'packages/ui/vitest.node-tests.ts'), 'utf8')

test('the planner matches the pinned Vitest includes and NODE_TESTS partition', () => {
  assertVitestContract(config, nodeConfig, files)
})

for (const [name, changed] of [
  ['an extra key', config.replace("'@':", "'@gates': '../../script', '@':")],
  ['resolve.alias in a project', config.replace('extends: true,', "extends: true, resolve: { alias: { '@gates': '../../script' } },")],
  ['an alias array in a project', config.replace('extends: true,', "extends: true, alias: [{ find: '@gates', replacement: '../../script' }],")],
  ['a different @ target', config.replace("new URL('./src',", "new URL('../../script',")],
]) {
  test(`the discovery pin refuses an unknown alias mapping: ${name}`, () => {
    assert.throws(() => assertVitestContract(changed, nodeConfig, files), /Vitest selection changed/)
  })
}

for (const extra of ["import './config/hooks.ts'", "export * from './config/hooks.ts'", 'import(`./config/hooks.ts`)']) {
  test(`the discovery pin refuses a new config dependency: ${extra}`, () => {
    assert.throws(() => assertVitestContract(`${extra}\n${config}`, nodeConfig, files), /Vitest selection changed/)
  })
}

for (const key of ['includeSource', 'typecheck', 'browser', 'workspace']) {
  test(`the early completeness guard refuses ${key}`, () => {
    const changed = config.replace('test: {', `test: { ${key}: [],`)
    assert.throws(() => assertVitestContract(changed, nodeConfig, files), /Vitest selection changed/)
  })
}

for (const project of ["{ test: { name: 'third' } },", "'another.config.ts',"]) {
  test(`the early completeness guard refuses an extra project ${project}`, () => {
    const changed = config.replace('projects: [', `projects: [${project}`)
    assert.throws(() => assertVitestContract(changed, nodeConfig, files), /Vitest selection changed/)
  })
}

const discoveredFiles = directory => {
  const ui = join(directory, 'packages/ui')
  // Call the installed binary with Node; pnpm need not be on a child's PATH.
  const result = spawnSync(process.execPath, [join(root, 'packages/ui/node_modules/vitest/vitest.mjs'), 'list', '--filesOnly'], {
    cwd: ui, encoding: 'utf8', timeout: 60000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return [...new Set(result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const path = line.replace(/^\[[^\]]+\]\s+/, '')
    return relative(ui, resolve(ui, path)).replaceAll('\\', '/')
  }))].sort()
}

test('real Vitest discovery equals the planner and the union of all four shards', { timeout: 60000 }, t => {
  const started = performance.now()
  const discovered = discoveredFiles(root)
  t.diagnostic(`Vitest discovery: ${(performance.now() - started).toFixed(0)}ms, ${discovered.length} files`)
  assert.deepEqual(discovered, files, 'Vitest discovery changed: update the planner')
  assert.deepEqual(discovered, plan(files, times, 4).flatMap(shard => shard.files).sort())
})

test('real discovery exposes a file outside the two planned test suffixes', { timeout: 60000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-discovery-'))
  try {
    mkdirSync(join(dir, 'packages/ui/src'), { recursive: true })
    writeFileSync(join(dir, 'packages/ui/src/normal.test.ts'), '')
    writeFileSync(join(dir, 'packages/ui/src/extra.ts'), '')
    writeFileSync(join(dir, 'packages/ui/vitest.config.mjs'), "export default { test: { include: ['src/**/*.ts'] } }\n")
    const discovered = discoveredFiles(dir)
    assert.deepEqual(discovered, ['src/extra.ts', 'src/normal.test.ts'])
    assert.throws(() => assert.deepEqual(discovered, testFiles(dir)), /extra\.ts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const assertVitestFilters = paths => {
  for (const file of paths) {
    assert.match(file, /^[\w./@+-]+$/, `unsafe space-joined Vitest filter: ${file}`)
    assert.deepEqual(paths.filter(other => other.toLowerCase().includes(file.toLowerCase())), [file], `ambiguous Vitest filter: ${file}`)
  }
}

test('a Vitest filename filter never also selects another test file', () => {
  assertVitestFilters(files)
})

for (const pair of [
  ['src/a.test.ts', 'src/nested/src/A.test.ts'],
  ['src/a.test.ts', 'src/A.test.ts'],
]) {
  test(`the Vitest filter guard refuses a case-insensitive overlap: ${pair.join(', ')}`, () => {
    assert.throws(() => assertVitestFilters(pair), /ambiguous Vitest filter/)
  })
}

for (const path of ['src/space name.test.ts', 'src/tab\tname.test.ts', 'src/new\nline.test.ts',
  'src/star*.test.ts', 'src/question?.test.ts', 'src/[bracket].test.ts', 'src/{brace}.test.ts']) {
  test(`the planner refuses a shell-unsafe test path ${JSON.stringify(path)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-unit-path-'))
    try {
      mkdirSync(join(dir, 'packages/ui/src'), { recursive: true })
      writeFileSync(join(dir, 'packages/ui', path), '')
      assert.throws(() => testFiles(dir), /Unsafe unit test path/)
      assert.throws(() => plan([path], {}, 1), /Unsafe unit test path/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('refresh strips ANSI, filters both unit job names, accepts plain logs and takes per-log medians', () => {
  const line = (file, ms) => ` ✓  dom  src/${file}.test.tsx (110 tests) ${ms}ms`
  const prefix = (job, text) => `${job}\tTest\t2026-10-13T00:00:00Z ${text}`
  const logs = [
    [prefix('UI tests', `\u001b[32m${line('a', 10)}\u001b[0m`),
      prefix('UI unit tests shard 1/4', line('b', 20)),
      prefix('Other job', line('a', 9000)),
      prefix('Other job', `UI tests ${line('wrong', 9000)}`), line('zero', 0)].join('\n'),
    [line('a', 30), line('b', 40)].join('\n'),
    line('a', 20),
  ]
  const expected = { 'src/a.test.tsx': 20, 'src/b.test.tsx': 30, 'src/zero.test.tsx': 1 }
  assert.deepEqual(millisecondsFromLogs(logs), expected)
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-refresh-'))
  try {
    const paths = logs.map((text, i) => {
      const path = join(dir, `${i}.log`)
      writeFileSync(path, text)
      return path
    })
    const result = cli(['--refresh', ...paths])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refresh CLI reproduces the table from the five supplied main logs', { skip: !process.env.UNIT_REFRESH_LOGS }, () => {
  const logs = JSON.parse(process.env.UNIT_REFRESH_LOGS)
  assert.equal(logs.length, 5)
  const result = cli(['--refresh', ...logs])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, readFileSync(join(root, 'script/ci-unit-durations.json'), 'utf8'))
})

test('the measured deal is balanced and has room below ten minutes including setup', () => {
  const mean = shards.reduce((sum, shard) => sum + shard.load, 0) / count
  const max = Math.max(...shards.map(shard => shard.load))
  const message = 'refresh script/ci-unit-durations.json from the last five main runs, or raise the shard cap'
  assert.ok(max <= mean * 1.15, `${max}/${mean}: ${message}`)
  assert.ok(max / 1000 + 60 < 600, `${max / 1000 + 60}s: ${message}`)
  assert.ok(Object.values(times).every(ms => Number.isInteger(ms) && ms >= 1))
})

const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
const job = name => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))
  assert.ok(match, `CI must keep the ${name} job`)
  return match[1]
}

test('changes computes one unit plan and supplies every shard the same mode, files and count', () => {
  const changes = job('changes'), units = job('ui-unit-tests')
  for (const output of ['unit_mode', 'unit_shard_count', 'unit_shards']) {
    assert.ok(changes.includes(`      ${output}: \${{ steps.paths.outputs.${output} }}`), output)
    assert.ok(units.includes(`needs.changes.outputs.${output}`), output)
  }
  assert.equal((workflow.match(/node script\/ci-unit-tests\.mjs/g) ?? []).length, 1)
  assert.ok(changes.includes('node script/ci-unit-tests.mjs "$list"'))
  assert.match(units, /^    needs: changes$/m)
  assert.match(units, /^    name: UI unit tests shard \$\{\{ matrix.shard \}\}\/\$\{\{ needs.changes.outputs.unit_shard_count \}\}$/m)
  assert.match(units, /^        shard: \$\{\{ fromJSON\(needs.changes.outputs.unit_shards\) \}\}$/m)
  assert.match(units, /^    if: needs.changes.outputs.unit_mode != 'none'$/m)
  assert.match(units, /^      fail-fast: false$/m)
  assert.match(units, /fetch-depth: 1/)
  assert.match(units, /node-version: 22/)
  assert.match(units, /pnpm install --frozen-lockfile/)
  assert.match(units, /pnpm run build:node/)
  assert.doesNotMatch(units, /run: pnpm run build\n|run typecheck|desktop run test|git diff/)
  assert.match(units, /- name: Deal UI tests\n        id: deal\n        if: needs.changes.outputs.unit_mode == 'all'\n        run: \|/)
  assert.ok(units.includes('node script/ci-unit-shards.mjs ${{ matrix.shard }}/${{ needs.changes.outputs.unit_shard_count }} > "$deal"'))
  assert.ok(units.includes('test -s "$deal"'))
  assert.match(units, /- name: UI tests\n        if: needs.changes.outputs.unit_mode == 'all'\n        env:\n          UNIT_DEAL: \$\{\{ steps.deal.outputs.files \}\}\n        run: pnpm --filter @harnessdesk\/ui run test \$UNIT_DEAL\n/)
  assert.doesNotMatch(units, /vitest related|UNIT_FILES/, 'CI runs the dealt suite, not a related selection')
  assert.match(units, /timeout-minutes: 15/)
  const once = job('ui-typecheck')
  // It waits only for the runner pick, never for the change plan.
  assert.match(once, /^    needs: runners$/m)
  assert.doesNotMatch(once, /needs: (?!runners$)|if:|matrix:/m)
  for (const command of ['pnpm --filter @harnessdesk/ui run typecheck', 'pnpm --filter @harnessdesk/desktop run test']) {
    assert.ok(once.includes(command))
    assert.equal(workflow.split(command).length - 1, 1)
  }
  assert.match(once, /timeout-minutes: 15/)
})

test('the change job produces the planner matrix for all and related, and a safe skipped matrix for none', () => {
  const block = job('changes').match(/          node script\/ci-unit-tests\.mjs[^]*/)?.[0]
  assert.ok(block)
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-matrix-'))
  try {
    for (const mode of ['all', 'related', 'none']) {
      const output = join(dir, 'output'), summary = join(dir, 'summary')
      writeFileSync(output, '')
      const stub = `node() { if [ "$1" = script/ci-unit-tests.mjs ]; then printf 'mode=%s\\nfiles=src/a.ts\\nsummary=unit plan\\n' "$MODE"; elif [ "$1" = script/ci-unit-shards.mjs ]; then echo "$COUNT"; else command node "$@"; fi; }\n`
      const result = spawnSync('bash', ['-e', '-c', stub + block], { encoding: 'utf8', env: {
        ...process.env, MODE: mode, COUNT: String(count), RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      } })
      assert.equal(result.status, 0, result.stderr)
      const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
      assert.equal(values.unit_mode, mode === 'none' ? 'none' : 'all')
      assert.equal(values.unit_files, undefined)
      assert.equal(Number(values.unit_shard_count), mode === 'none' ? 0 : count)
      assert.deepEqual(JSON.parse(values.unit_shards), mode === 'none' ? [1] : shards.map((_, i) => i + 1))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the deal step emits the exact files and refuses an empty or failed planner before publishing', () => {
  const units = job('ui-unit-tests')
  const body = units.match(/- name: Deal UI tests\n[^]*?        run: \|\n([^]*?)(?=^      -)/m)?.[1]
  assert.ok(body)
  const shell = body.replaceAll('${{ matrix.shard }}', '1').replaceAll('${{ needs.changes.outputs.unit_shard_count }}', String(count))
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-deal-'))
  try {
    const output = join(dir, 'output')
    for (const [content, status] of [[null, 0], ['', 0], ['src/partial.test.ts\n', 2]]) {
      writeFileSync(output, '')
      const stub = content === null ? '' : 'node() { printf "%s" "$DEAL_CONTENT"; return "$DEAL_STATUS"; }\n'
      const result = spawnSync('bash', ['-e', '-c', stub + shell], { cwd: root, encoding: 'utf8', env: {
        ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, DEAL_CONTENT: content ?? '', DEAL_STATUS: String(status),
      } })
      assert.equal(result.status, content === null ? 0 : status || 1, result.stderr)
      assert.equal(readFileSync(output, 'utf8'), content === null ? `files=${shards[0].files.join(' ')}\n` : '')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('UI tests stays the aggregate and only accepts the exact requested result table through its shell', () => {
  const aggregate = job('ui-tests')
  assert.match(aggregate, /^    name: UI tests$/m)
  assert.match(aggregate, /^    needs: \[changes, ui-typecheck, ui-unit-tests\]$/m)
  assert.match(aggregate, /^    if: always\(\)$/m)
  for (const line of ['CHANGES_RESULT: ${{ needs.changes.result }}', 'UNIT_MODE: ${{ needs.changes.outputs.unit_mode }}',
    'TYPECHECK_RESULT: ${{ needs.ui-typecheck.result }}', 'SHARDS_RESULT: ${{ needs.ui-unit-tests.result }}']) assert.ok(aggregate.includes(line), line)
  const shell = aggregate.match(/        run: \|\n([^]*)/)[1]
  const results = ['success', 'failure', 'cancelled', 'skipped', '']
  for (const mode of ['all', 'related', 'none', '']) {
    for (const typecheck of results) for (const units of results) {
      const result = spawnSync('bash', ['-e', '-c', shell], { encoding: 'utf8', env: {
        ...process.env, CHANGES_RESULT: 'success', UNIT_MODE: mode, TYPECHECK_RESULT: typecheck, SHARDS_RESULT: units,
      } })
      const passes = typecheck === 'success' && ((mode === 'all' && units === 'success') || (mode === 'none' && units === 'skipped'))
      assert.equal(result.status, passes ? 0 : 1, `${mode}/${typecheck}/${units}: ${result.stdout} ${result.stderr}`)
    }
  }
  for (const changes of results.filter(result => result !== 'success')) {
    const result = spawnSync('bash', ['-e', '-c', shell], { env: { ...process.env,
      CHANGES_RESULT: changes, UNIT_MODE: 'none', TYPECHECK_RESULT: 'success', SHARDS_RESULT: 'skipped' } })
    assert.equal(result.status, 1)
  }
})

test('DOM rendering tests share a budget while pure Node tests retain the default', async () => {
  const { default: config } = await import('../packages/ui/vitest.config.ts')
  const projects = config.test.projects.map(project => project.test)
  assert.equal(projects.find(project => project.name === 'dom').testTimeout, 10_000)
  assert.equal(projects.find(project => project.name === 'node').testTimeout, undefined)
  const flow = readFileSync(join(root, 'packages/ui/src/components/FlowStart.test.tsx'), 'utf8')
  assert.doesNotMatch(flow, /},\s*10_000\)/, 'FlowStart uses the shared rendering budget')
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { browserPlan, ciTier, planChange, themeDiff, themeInputs } from './ci-changes.mjs'
import { specFiles } from './ci-browser-shards.mjs'
import { mergeRecords, readMap } from './ui-impact.mjs'

const script = fileURLToPath(new URL('./ci-changes.mjs', import.meta.url))
const cliPlan = (paths, event = 'pull_request', env = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  try {
    const list = join(directory, 'paths')
    if (paths !== null) writeFileSync(list, paths.length ? `${paths.join('\0')}\0` : '')
    const result = spawnSync(process.execPath, [script, list], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, UI_THEME_TOUCHED: '', UI_SYSTEM_MATRIX_REQUEST: '', UI_IMPACT_MAP: '', CI_HEAD_BRANCH: '', CI_REF_NAME: '', CI_LABELS: '', CI_PROVEN_BY: '', ...env },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    return output
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// check-push consumes the shared planner, independently of CI's tier policy.
const check = (paths, expected, event = 'pull_request', env = {}) => {
  const output = plan(paths, env, event)
  assert.equal(output.browser, expected[0])
  assert.equal(output.native, String(expected[1]))
  assert.deepEqual(JSON.parse(output.server_specs), ['e2e/ui-system/front-door-edit.spec.ts', 'e2e/ui-system/lead-hidden.spec.ts', 'e2e/ui-system/lead.spec.ts', 'e2e/ui-system/notices-inbox.spec.ts', 'e2e/ui-system/project-composer-terminal.spec.ts', 'e2e/ui-system/run-ending.spec.ts', 'e2e/ui-system/template-contest-journey.spec.ts', 'e2e/ui-system/template-journeys.spec.ts'])
  return output
}

for (const paths of [
  ['packages/ui/src/App.tsx'], ['packages/server/src/host.ts'],
  ['packages/desktop/electron/main.mjs'], ['e2e/ui-system/row-box.spec.ts'],
  ['package.json'], ['docs/a b.md'], ['docs/line\nbreak.md'], [], null,
]) {
  test(`bounded CI runs core only for ${JSON.stringify(paths)}`, () => {
    const run = cliPlan(paths)
    assert.deepEqual([run.browser, run.native, run.tier], ['none', 'false', 'bounded'])
    assert.deepEqual([run.browser_specs, run.shard_count, run.shards, run.record], ['[]', '0', '[1]', 'false'])
    assert.match(run.summary, /Browser suite and native smoke run in the full tier \(batch\/ or full-ci\)/)
    assert.match(run.summary, /Local check-push specs:/)
    assert.doesNotMatch(run.summary, /[\n\r]/)
  })
}

test('bounded CI lists the local reached specs without changing local selection', () => {
  const paths = ['e2e/ui-system/row-box.spec.ts', 'packages/server/src/host.ts']
  const local = plan(paths)
  const ci = cliPlan(paths)
  assert.equal(local.browser, 'all')
  assert.equal(local.native, 'true')
  const specs = JSON.parse(local.browser_specs)
  assert.ok(specs.includes('e2e/ui-system/row-box.spec.ts'))
  assert.ok(specs.includes('e2e/ui-system/front-door-edit.spec.ts'))
  assert.ok(ci.summary.endsWith(`Local check-push specs: ${specs.join(', ')}.`), ci.summary)
})

for (const path of [
  'packages/ui/src/App.tsx', 'packages/protocol/src/wire.ts',
  'packages/client/src/views/index.ts',
  'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.node-version',
  'tsconfig.base.json', '.github/workflows/ci.yml', 'script/ci-changes.mjs',
  'script/copy-fixtures.mjs', 'script/prune-dist.mjs', 'script/check-secrets.mjs',
  'script/shots/audit.mjs', 'assets/avatars/128/blue.png',
]) {
  test(`${path} runs both suites (shared build or loaded input)`, () => check([path], ['all', true]))
}
for (const path of ['docs/architecture.md', 'CONTRIBUTING.md', 'script/land-safe.mjs']) {
  test(`${path} skips both suites`, () => check([path], ['none', false]))
}
for (const path of ['e2e/ui-system/row-box.spec.ts', 'playwright.ui-system.config.ts', 'script/ci-browser-shards.mjs', 'script/ui-system-run.mjs', 'script/ui-system-run.test.mjs', 'script/ci-server-split.mjs', 'script/ci-server-split.test.mjs']) {
  test(`${path} runs the browser suite`, () => check([path], ['all', false]))
}
// The recorded times only change how specs are dealt; the plan's own tests check the deal.
for (const path of ['e2e/ui-system/durations.json', 'e2e/ui-system/durations.pr.json']) {
  test(`${path} opens no browser`, () => check([path], ['none', false]))
}
for (const path of ['packages/desktop/electron/main.mjs']) {
  test(`${path} runs native smoke`, () => check([path], ['none', true]))
}
test('the shot seed selects browser coverage and native smoke', () =>
  check(['script/shots/seed.mjs'], ['all', true]))
// It sits in the browser test directory but no browser spec imports it, so only the native job runs it.
test('the native smoke runner runs native smoke and no browser spec', () =>
  check(['e2e/ui-system/native-smoke.mjs'], ['none', true]))
test('empty input runs everything', () => check([], ['all', true]))
test('unreadable input runs everything', () => check(null, ['all', true]))
test('push to main runs everything even for docs', () => check(['docs/architecture.md'], ['all', true], 'push'))
test('NUL input preserves filenames with spaces', () =>
  check(['docs/a b.md', 'docs/b c.md'], ['none', false]))
// A name with a newline would write a second line into the step's outputs: it is not a name to plan from.
test('a filename with a control character runs everything', () => {
  check(['docs/line\nbreak.md', 'docs/a b.md'], ['all', true])
  check(['docs/tab\there.md'], ['all', true])
})
test('a mixed change runs each affected suite', () =>
  check(['docs/architecture.md', 'packages/desktop/electron/main.mjs', 'e2e/ui-system/row-box.spec.ts'], ['all', true]))

for (const path of ['packages/server/src/host.ts']) {
  test(`${path} runs server specs and native smoke`, () => check([path], ['server', true]))
}
test('UI inputs take precedence over server changes', () =>
  check(['packages/server/src/host.ts', 'packages/ui/src/App.tsx'], ['all', true]))

const fixture = async (run) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-imports-'))
  const put = (path, content) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  try {
    put('packages/ui/package.json', JSON.stringify({ name: '@harnessdesk/ui', dependencies: { '@harnessdesk/client': 'workspace:*' } }))
    put('packages/client/package.json', JSON.stringify({ name: '@harnessdesk/client', dependencies: { '@harnessdesk/protocol': 'workspace:*' } }))
    put('packages/protocol/package.json', JSON.stringify({ name: '@harnessdesk/protocol' }))
    put('packages/server/package.json', JSON.stringify({ name: '@harnessdesk/server' }))
    put('e2e/ui-system/ui.spec.ts', "import type { Wire } from '@harnessdesk/protocol'\n")
    await run(root, put)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('UI inputs follow transitive workspace manifest dependencies', async () => {
  const { uiPackages } = await import('./ci-changes.mjs')
  await fixture((root, put) => {
    put('packages/protocol/package.json', JSON.stringify({ name: '@harnessdesk/protocol', dependencies: { '@harnessdesk/extra': 'workspace:*' } }))
    put('packages/extra/package.json', JSON.stringify({ name: '@harnessdesk/extra' }))
    assert.deepEqual([...uiPackages(root)].sort(), ['client', 'extra', 'protocol', 'ui'])
  })
})

for (const [name, source] of [
  ['relative import', "import { rig } from '../../packages/server/dist/test/rig.js'"],
  ['workspace import', "import { rig } from '@harnessdesk/server/testing'"],
  ['dynamic import', "const rig = await import('../../packages/server/src/rig')"],
  ['helper import', "import { rig } from './helper'"],
]) {
  test(`import scan finds a fixture spec with a ${name}`, async () => {
    const { serverSpecs, uiPackages } = await import('./ci-changes.mjs')
    await fixture((root, put) => {
      put('e2e/ui-system/added.spec.ts', source)
      put('e2e/ui-system/helper.ts', "export { rig } from '../../packages/server/src/rig'")
      assert.deepEqual(serverSpecs(root, uiPackages(root)), ['e2e/ui-system/added.spec.ts'])
    })
  })
}

for (const [imported, helper] of [
  ['./helper.mts', 'helper.mts'], ['./helper.cts', 'helper.cts'],
  ['./helper.mjs', 'helper.mts'], ['./helper.cjs', 'helper.cts'],
  ['./helper', 'helper.mts'], ['./helper', 'helper.cts'],
  ['./helper', 'helper/index.mts'], ['./helper', 'helper/index.cts'],
  ['./helper.config', 'helper.config.ts'],
  ['./fixtures.shared', 'fixtures.shared.ts'],
  ['./frames.v2', 'frames.v2.ts'],
]) {
  test(`import scan follows ${imported} to ${helper}`, async () => {
    const { serverSpecs, uiPackages } = await import('./ci-changes.mjs')
    await fixture((root, put) => {
      put('e2e/ui-system/added.spec.ts', `import { rig } from '${imported}'`)
      put(`e2e/ui-system/${helper}`, "export { rig } from '@harnessdesk/server/testing'")
      assert.deepEqual(serverSpecs(root, uiPackages(root)), ['e2e/ui-system/added.spec.ts'])
    })
  })
}

for (const asset of ['fixture.json', 'frame.png', 'styles.css']) {
  test(`import scan skips the non-source asset ${asset} and keeps following helpers`, async () => {
    const { serverSpecs, uiPackages } = await import('./ci-changes.mjs')
    await fixture((root, put) => {
      put('e2e/ui-system/added.spec.ts', `import asset from './${asset}'\nimport { rig } from './helper'`)
      put('e2e/ui-system/ui.spec.ts', `import asset from './${asset}'`)
      put(`e2e/ui-system/${asset}`, 'fixture bytes')
      put('e2e/ui-system/helper.ts', "export { rig } from '@harnessdesk/server/testing'")
      assert.deepEqual(serverSpecs(root, uiPackages(root)), ['e2e/ui-system/added.spec.ts'])
    })
  })
}

test('import scan still refuses an unresolved source helper', async () => {
  const { serverSpecs, uiPackages } = await import('./ci-changes.mjs')
  await fixture((root, put) => {
    put('e2e/ui-system/added.spec.ts', "import { rig } from './missing.mts'")
    assert.throws(() => serverSpecs(root, uiPackages(root)), /Cannot resolve suite import/)
  })
})

// Local browser selection and sizing still use the shared plan unchanged.
const plan = (paths, env = {}, event = 'pull_request') => {
  const output = planChange(fileURLToPath(new URL('../', import.meta.url)), {
    event, paths, headBranch: env.CI_HEAD_BRANCH ?? '', refName: env.CI_REF_NAME ?? '', labels: JSON.parse(env.CI_LABELS || '[]'),
    map: env.UI_IMPACT_MAP ? readMap(env.UI_IMPACT_MAP) : null,
  })
  return Object.fromEntries(Object.entries(output).map(([key, value]) => [key, String(value)]))
}

test('a pull request without a map samples the suite in the PR matrix within four shards', () => {
  const run = plan(['packages/ui/src/App.tsx'])
  assert.equal(run.browser, 'all')
  assert.ok(JSON.parse(run.browser_specs).length < specFiles(real).length)
  assert.equal(run.matrix, 'pr')
  assert.ok(Number(run.shard_count) >= 1 && Number(run.shard_count) <= 4, run.shard_count)
  assert.deepEqual(JSON.parse(run.shards), Array.from({ length: Number(run.shard_count) }, (_, index) => index + 1))
})

test('the pull-request matrix never needs more shards than the whole of main', () => {
  const main = Number(plan(['docs/architecture.md'], {}, 'push').shard_count)
  assert.ok(Number(plan(['packages/ui/src/App.tsx']).shard_count) <= main)
})

test('a theme edit stays bounded until full CI is requested', () =>
  assert.equal(plan(['packages/ui/src/App.tsx'], { UI_THEME_TOUCHED: 'true' }).matrix, 'pr'))

for (const path of ['pnpm-lock.yaml', 'package.json', '.github/workflows/ci.yml', 'assets/avatars/128/blue.png', 'playwright.ui-system.config.ts', 'script/ci-browser-shards.mjs']) {
  test(`${path} uses the bounded PR matrix`, () => assert.equal(plan(['packages/ui/src/App.tsx', path]).matrix, 'pr'))
}

// A declaration added inside an existing `body[data-hd-dark-theme]` block says neither "dark" nor "theme" in its own line.
for (const path of ['packages/ui/src/design/foundation/tokens.css', 'packages/ui/src/styles/app.css', 'packages/ui/vite.config.ts', 'packages/ui/tsconfig.json', 'packages/ui/package.json']) {
  test(`${path} stays bounded until a full-tier trigger`, () => assert.equal(plan([path]).matrix, 'pr'))
}

test('a stylesheet that names a theme before or after the change reads both themes', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const popup = ['packages/ui/src/design/ui/popup.css'] // says neither word today
  assert.equal(themeInputs(root, popup, () => null), false, 'a stylesheet that is neither')
  assert.equal(themeInputs(root, popup, () => 'body[data-hd-dark-theme] { --x: 1 }'), true, 'it named a theme before the change and the change took the word out')
  assert.equal(themeInputs(root, ['packages/ui/src/components/Row.tsx'], () => 'dark'), false, 'only stylesheets are read for the word')
})

test('main and development full runs read both themes of every spec; elsewhere the full tier reads every spec in the PR matrix', () => {
  for (const [event, ref] of [['push', 'main'], ['workflow_dispatch', 'main'], ['workflow_dispatch', 'development']]) {
    const run = plan(['packages/ui/src/App.tsx'], { CI_REF_NAME: ref }, event)
    assert.deepEqual([run.browser, run.browser_specs, run.matrix], ['all', 'all', 'full'], `${event} ${ref}`)
    assert.ok(Number(run.shard_count) >= Number(plan(['packages/ui/src/App.tsx']).shard_count), event)
  }
  for (const [event, env] of [
    ['workflow_dispatch', { CI_REF_NAME: 'codex/feature' }],
    ['pull_request', { CI_HEAD_BRANCH: 'batch/reviewed', CI_REF_NAME: '12/merge' }],
    ['pull_request', { CI_LABELS: '["full-ci"]', CI_REF_NAME: '12/merge' }],
    ['pull_request', { CI_HEAD_BRANCH: 'development', CI_REF_NAME: '12/merge' }],
  ]) {
    const run = plan(['packages/ui/src/App.tsx'], env, event)
    assert.deepEqual([run.tier, run.browser, run.browser_specs, run.matrix, run.record], ['full', 'all', 'all', 'pr', 'false'], JSON.stringify(env))
  }
})

test('manual dispatch always runs full CI, and PRs cannot change tier with the obsolete matrix input', () => {
  assert.equal(plan(['packages/ui/src/App.tsx'], { UI_SYSTEM_MATRIX_REQUEST: 'pr', CI_REF_NAME: 'development' }, 'workflow_dispatch').matrix, 'full')
  assert.equal(plan(['packages/ui/src/App.tsx'], { UI_SYSTEM_MATRIX_REQUEST: 'bogus' }).matrix, 'pr')
})

test('an unreadable PR change list uses a bounded sample', () => {
  const run = check(null, ['all', true])
  assert.ok(JSON.parse(run.browser_specs).length > 0)
  assert.equal(run.matrix, 'pr')
})

test('a pull request that only edits one spec runs that spec in the PR matrix on one shard', () => {
  const run = plan(['e2e/ui-system/row-box.spec.ts'])
  assert.deepEqual([run.browser, run.browser_specs, run.matrix, run.shard_count, run.shards], ['all', '["e2e/ui-system/row-box.spec.ts"]', 'pr', '1', '[1]'])
})

test('a changed helper runs every spec that imports it, and only those', () => {
  const run = plan(['e2e/ui-system/frame-contract-split-setup.ts'])
  const specs = JSON.parse(run.browser_specs)
  assert.ok(specs.length > 5 && specs.length < 80, specs.length)
  assert.ok(specs.every(spec => /\.spec\.ts$/.test(spec)))
  assert.ok(specs.includes('e2e/ui-system/frame-contract-popup-menus.spec.ts'))
  assert.ok(!specs.includes('e2e/ui-system/row-box.spec.ts'))
})

test('a helper a spec loads by URL or by name, and not by an import, still runs that spec', () => {
  // `write-once.spec.ts` spawns a child that loads `write-once.ts` from `new URL('./write-once', import.meta.url)`.
  const run = plan(['e2e/ui-system/write-once.ts'])
  assert.ok(JSON.parse(run.browser_specs).includes('e2e/ui-system/write-once.spec.ts'), run.browser_specs)
})

test('a changed helper reaches the specs that import it through another helper', () => {
  const reached = path => {
    const run = planWith([path], null)
    return [...JSON.parse(run.specs), ...run.deferred]
  }
  const direct = reached('e2e/ui-system/frame-contract-helpers.ts')
  const wall = reached('e2e/ui-system/frame-wall-destinations.ts')
  assert.ok(wall.length >= direct.length, 'the destinations are imported by the helpers, so everything the helpers reach is reached')
  for (const spec of direct) assert.ok(wall.includes(spec), spec)
})

test('untraceable suite data and deleted helpers sample the whole suite within the cap', () => {
  for (const path of ['e2e/ui-system/untraceable-data.json', 'e2e/ui-system/a-helper-that-was-deleted.ts']) {
    const run = plan([path])
    assert.equal(run.browser, 'all')
    assert.equal(run.matrix, 'pr')
    assert.ok(JSON.parse(run.browser_specs).length > 0)
    assert.ok(Number(run.shard_count) <= 4)
  }
})

test('deleting a spec runs nothing', () =>
  assert.equal(plan(['e2e/ui-system/a-spec-that-was-deleted.spec.ts']).browser, 'none'))

test('a spec edit beside a host change also runs the server-facing specs', () => {
  const run = plan(['e2e/ui-system/row-box.spec.ts', 'packages/server/src/host.ts'])
  assert.deepEqual(JSON.parse(run.browser_specs), [
    'e2e/ui-system/front-door-edit.spec.ts', 'e2e/ui-system/lead-hidden.spec.ts', 'e2e/ui-system/lead.spec.ts', 'e2e/ui-system/notices-inbox.spec.ts', 'e2e/ui-system/project-composer-terminal.spec.ts', 'e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/run-ending.spec.ts',
    'e2e/ui-system/template-contest-journey.spec.ts', 'e2e/ui-system/template-journeys.spec.ts',
  ])
})

test('the outputs are well formed on a run that skips the browser job', () => {
  const run = plan(['docs/architecture.md'])
  assert.deepEqual([run.browser, run.shard_count, run.shards], ['none', '0', '[1]'])
})

// A map of the real repository, made up: every spec ran the button, and `row-box.spec.ts` alone ran BringHome.
const real = fileURLToPath(new URL('../', import.meta.url))
const impactMap = (narrow = '/src/components/BringHome.tsx') => {
  const records = specFiles(real).map(spec => ({
    [`e2e/ui-system/${spec}`]: {
      tests: 1, unclean: 0,
      loaded: ['/src/design/ui/button.tsx', narrow],
      ran: spec === 'row-box.spec.ts' ? ['/src/design/ui/button.tsx', narrow] : ['/src/design/ui/button.tsx'],
    },
  }))
  const map = mergeRecords(real, records, { commit: 'abcdef1234567' })
  // App.tsx is no longer in this checkout. Supply its historical record explicitly
  // when exercising that path, without creating a production source file.
  if (narrow === '/src/App.tsx') map.files['packages/ui/src/App.tsx'] = { blob: 'a'.repeat(40), loaded: 'all', ran: [map.specs.indexOf('row-box.spec.ts')] }
  return map
}
const planWith = (inputs, impact, over = {}) => browserPlan(real, {
  browser: 'all', inputs, serverInputs: false, event: 'pull_request', themeTouched: false, request: '', baseText: () => null, impact, ...over,
})
const current = map => ({ map, baseFiles: () => Object.fromEntries(Object.entries(map.files).map(([path, entry]) => [path, entry.blob])), baseEnvironment: () => map.environment })

test('a change to the UI runs the specs in which that source ran, in the light theme', () => {
  const map = impactMap()
  const run = planWith(['packages/ui/src/components/BringHome.tsx'], current(map))
  assert.deepEqual(JSON.parse(run.specs), ['e2e/ui-system/row-box.spec.ts'])
  assert.deepEqual([run.browser, run.matrix, run.count], ['all', 'pr', 1])
  assert.match(run.summary, /1 of \d+ specs.*Selected by the specs that ran the changed UI source \(map of abcdef123\)/)
})

test('broad impact selections and a missing map are both capped', () => {
  const map = impactMap()
  const all = JSON.parse(planWith(['packages/ui/src/design/ui/button.tsx'], current(map)).specs)
  assert.ok(all.length < specFiles(real).length)
  assert.ok(all.length > 0)
  const unmapped = planWith(['packages/ui/src/components/BringHome.tsx'], null)
  assert.ok(unmapped.deferred.length > 0)
  assert.equal(unmapped.matrix, 'pr')
})

test('a file that has moved on since the map was recorded runs every spec, and the summary says why', () => {
  const map = impactMap()
  const base = current(map).baseFiles()
  base['packages/ui/src/components/BringHome.tsx'] = 'f'.repeat(40)
  const run = planWith(['packages/ui/src/components/BringHome.tsx'], { ...current(map), baseFiles: () => base })
  assert.ok(run.deferred.length > 0)
  assert.match(run.summary, /Not narrowed: .*BringHome\.tsx has changed on the base branch since the map was recorded/)
})

test('an input the map cannot speak for falls back to a capped suite sample', () => {
  const map = impactMap()
  for (const beside of ['package.json', 'packages/ui/vite.config.ts', 'packages/protocol/src/index.ts']) {
    assert.ok(planWith(['packages/ui/src/components/BringHome.tsx', beside], current(map)).deferred.length > 0, beside)
  }
})

test('a change to the UI beside a spec edit runs both selections in the PR matrix', () => {
  const map = impactMap()
  const run = planWith(['packages/ui/src/components/BringHome.tsx', 'e2e/ui-system/rules.spec.ts'], current(map))
  assert.deepEqual(JSON.parse(run.specs), ['e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/rules.spec.ts'])
  assert.equal(run.matrix, 'pr')
})

test('a change that reaches no spec opens no browser', () => {
  const map = impactMap()
  const run = planWith(['packages/ui/src/components/BringHome.test.tsx'], current(map))
  assert.deepEqual([run.browser, run.count], ['none', 0])
})

test('a spec the map has not seen run runs, whatever else changed', () => {
  const map = impactMap()
  map.specs.shift()
  map.hashes.shift()
  for (const entry of Object.values(map.files)) {
    for (const kind of ['loaded', 'ran']) if (Array.isArray(entry[kind])) entry[kind] = entry[kind].filter(index => index > 0).map(index => index - 1)
  }
  const unseen = specFiles(real).find(spec => !map.specs.includes(spec))
  const run = planWith(['packages/ui/src/components/BringHome.tsx'], current(map))
  assert.ok(JSON.parse(run.specs).includes(`e2e/ui-system/${unseen}`), unseen)
})

test('only a run of the whole suite in both themes records what each spec ran', () => {
  const ui = ['packages/ui/src/App.tsx']
  for (const event of ['push', 'workflow_dispatch']) assert.equal(plan(ui, { CI_REF_NAME: 'main' }, event).record, 'true', event)
  assert.equal(plan(ui, { CI_REF_NAME: 'codex/feature' }, 'workflow_dispatch').record, 'false', 'a map made off main and development would never be saved')
  assert.equal(plan(ui, { UI_THEME_TOUCHED: 'true' }).record, 'false', 'a theme diff is still bounded')
  assert.equal(plan(ui).record, 'false', 'a pull request that reads one theme')
  assert.equal(plan(ui, { UI_SYSTEM_MATRIX_REQUEST: 'pr', CI_REF_NAME: 'development' }, 'workflow_dispatch').record, 'true', 'manual runs of development always record the full tier')
  assert.equal(plan(['e2e/ui-system/row-box.spec.ts']).record, 'false', 'a part of the suite')
  assert.equal(plan(['docs/architecture.md']).record, 'false', 'no browser at all')
})

test('a map that cannot be read changes nothing about what a pull request runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-map-'))
  try {
    for (const [name, text] of Object.entries({ missing: null, empty: '', garbage: '{"version":' })) {
      const file = join(directory, `${name}.json`)
      if (text !== null) writeFileSync(file, text)
      const run = plan(['packages/ui/src/components/BringHome.tsx'], { UI_IMPACT_MAP: file })
      assert.equal(run.browser, 'all', name)
      assert.equal(run.matrix, 'pr', name)
      assert.ok(JSON.parse(run.browser_specs).length > 0)
      assert.ok(Number(run.shard_count) <= 4)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a summary never carries a newline into the outputs, whatever a path is called', () => {
  const map = impactMap()
  const run = planWith(['packages/ui/src/components/BringHome.tsx'], { ...current(map), baseFiles: () => ({ ...current(map).baseFiles(), 'packages/ui/src/new\nbrowser=none.ts': 'a'.repeat(40) }) })
  assert.ok(run.deferred.length > 0)
  assert.doesNotMatch(run.summary, /[\n\r]/)
  assert.match(run.summary, /new browser=none\.ts was added to the base branch/)
})

test('a file outside the UI that its source imports is a browser input, and one only its tests import is not', () => {
  const run = (paths) => plan(paths)
  // `packages/ui/src/design/frame.ts` is the UI's; the shared constants it imports from other packages are theirs.
  assert.equal(run(['docs/architecture.md']).browser, 'none')
  assert.equal(run(['packages/desktop/electron/main.mjs']).browser, 'none', 'imported by a unit test of the UI and by no source of it')
})

test('suite-only selection reads the source behind compiled package imports on an unbuilt checkout', async () => {
  await fixture((root, put) => {
    put('packages/server/test/rig.ts', 'export const rig = {}')
    put('e2e/ui-system/server.spec.ts', "import { rig } from '../../packages/server/dist/test/rig.js'")
    put('e2e/ui-system/durations.json', '{}')
    const output = planChange(root, { event: 'pull_request', paths: ['e2e/ui-system/ui.spec.ts'] })
    assert.deepEqual(JSON.parse(output.browser_specs), ['e2e/ui-system/ui.spec.ts'])
  })
})

test('the shared change plan and CI CLI keep the same output contract', () => {
  const real = fileURLToPath(new URL('../', import.meta.url))
  const paths = ['docs/architecture.md']
  const output = cliPlan(paths)
  const shared = planChange(real, { event: 'pull_request', paths })
  assert.deepEqual(Object.keys(shared), Object.keys(output))
  for (const key of ['server_specs', 'matrix', 'tier']) assert.equal(String(shared[key]), output[key], key)
})

test('theme diff selection matches the unchanged CI grep pipeline', () => {
  const real = fileURLToPath(new URL('../', import.meta.url))
  const workflow = readFileSync(join(real, '.github/workflows/ci.yml'), 'utf8')
  const pipeline = workflow.match(/git diff --no-renames -U0 "\$base" HEAD -- packages\/ui \| (grep[^;]+); then/)?.[1]
  assert.ok(pipeline, 'CI still exposes its theme pipeline')
  for (const diff of ['+++ b/theme.css\n--- a/dark.css', '+DARK colour', '-theme rule', ' context dark', '+colour: blue', '+--- theme', '\n+theme\n']) {
    const result = spawnSync('bash', ['-c', pipeline], { input: diff, encoding: 'utf8' })
    assert.equal(themeDiff(diff), result.status === 0, diff)
  }
})

test('a pull request that edits only a spec that imports build output plans on a checkout that has not built', async () => {
  const { browserPlan } = await import('./ci-changes.mjs')
  await fixture((root, put) => {
    // The suite as `changes` sees it: no `node_modules`, no `dist`, and a spec that imports build output.
    put('e2e/ui-system/row-box.spec.ts', "import { rig } from '../../packages/server/dist/test/fixtures/rig.js'\nrig()\n")
    put('e2e/ui-system/other.spec.ts', 'export {}\n')
    put('e2e/ui-system/durations.json', JSON.stringify({ 'row-box.spec.ts': 66, 'other.spec.ts': 10 }))
    put('e2e/ui-system/durations.pr.json', '{}')
    const run = browserPlan(root, { browser: 'all', inputs: ['e2e/ui-system/row-box.spec.ts'], serverInputs: false, event: 'pull_request', themeTouched: false, request: '', baseText: () => null })
    assert.deepEqual([run.browser, run.specs, run.count, run.matrix], ['all', JSON.stringify(['e2e/ui-system/row-box.spec.ts']), 1, 'pr'])
    assert.match(run.summary, /1 of 3 specs, pull-request theme matrix, 1 shard/) // the fixture's own ui.spec.ts is the third
  })
})

// Two-tier policy: bounded work on ordinary PRs, complete evidence before landing.
test('a widely rendered stylesheet is capped at four PR shards and names deferred specs', () => {
  const run = planWith(['packages/ui/src/styles/app.css'], null)
  const specs = JSON.parse(run.specs)
  assert.equal(run.tier, 'bounded')
  assert.equal(run.matrix, 'pr')
  assert.ok(run.count > 0 && run.count <= 4)
  assert.ok(specs.length > 0 && specs.length < specFiles(real).length)
  assert.deepEqual([...specs, ...run.deferred].sort(), specFiles(real).map(spec => `e2e/ui-system/${spec}`))
  assert.match(run.summary, /CI tier: bounded/)
  for (const spec of run.deferred) assert.ok(run.summary.includes(spec), spec)
})

test('edited and newly added specs always survive the cap, even when they exceed its time budget', () => {
  const all = specFiles(real).map(spec => `e2e/ui-system/${spec}`)
  const run = planWith(['package.json', ...all], null)
  assert.deepEqual(run.specs === 'all' ? all : JSON.parse(run.specs), all)
  assert.ok(run.count <= 4)
  assert.deepEqual(run.deferred, [])
  assert.match(run.summary, /edited or reader specs exceed/)
})

test('a narrow source selection wins over a widely rendered input when both change', () => {
  const map = impactMap()
  const run = planWith(['packages/ui/src/design/ui/button.tsx', 'packages/ui/src/components/BringHome.tsx'], current(map))
  assert.ok(JSON.parse(run.specs).includes('e2e/ui-system/row-box.spec.ts'))
  assert.ok(run.deferred.length > 0)
})

for (const [options, thorough] of [
  [{ event: 'push', refName: 'main' }, true], [{ event: 'workflow_dispatch', request: 'pr', refName: 'development' }, true],
  [{ event: 'workflow_dispatch', refName: 'codex/feature' }, false],
  [{ event: 'pull_request', headBranch: 'batch/reviewed' }, false],
  [{ event: 'pull_request', labels: ['full-ci'] }, false],
]) {
  test(`full tier runs everything for ${JSON.stringify(options)}, even for docs`, () => {
    const run = planChange(real, { paths: ['docs/architecture.md'], ...options })
    assert.equal(run.tier, 'full')
    assert.equal(run.browser, 'all')
    assert.equal(run.native, true)
    assert.equal(run.browser_specs, 'all')
    assert.equal(run.matrix, thorough ? 'full' : 'pr')
    assert.equal(run.record, thorough)
    assert.match(run.summary, /CI tier: full/)
  })
}

test('CLI reads full-tier branch and label metadata without evaluating branch text', () => {
  for (const env of [{ CI_HEAD_BRANCH: 'batch/reviewed' }, { CI_LABELS: '["full-ci"]' }]) {
    const run = cliPlan(['packages/ui/src/App.tsx'], 'pull_request', env)
    assert.deepEqual([run.tier, run.browser, run.native, run.matrix, run.browser_specs, run.record], ['full', 'all', 'true', 'pr', 'all', 'false'])
    assert.equal(run.summary, plan(['packages/ui/src/App.tsx'], env).summary)
  }
})

for (const event of ['push', 'workflow_dispatch']) {
  test(`CLI keeps full CI for ${event}`, () => {
    const run = cliPlan(['docs/architecture.md'], event, { CI_REF_NAME: 'main' })
    assert.deepEqual([run.tier, run.browser, run.native, run.matrix, run.browser_specs], ['full', 'all', 'true', 'full', 'all'])
  })
}

test('an added spec absent from duration tables is mandatory beside a broad change', async () => {
  await fixture((root, put) => {
    const times = {}
    for (let index = 0; index < 12; index++) {
      const name = `old-${index}.spec.ts`
      put(`e2e/ui-system/${name}`, 'export {}')
      times[name] = 900
    }
    put('e2e/ui-system/added.spec.ts', 'export {}')
    put('e2e/ui-system/durations.json', JSON.stringify(times))
    const run = planChange(root, { event: 'pull_request', paths: ['package.json', 'e2e/ui-system/added.spec.ts'] })
    const specs = JSON.parse(run.browser_specs)
    assert.ok(specs.includes('e2e/ui-system/added.spec.ts'))
    assert.ok(specs.length < 14)
    assert.ok(run.shard_count <= 4)
  })
})

test('development pushes select the bounded tier, independently of PR metadata', () => {
  assert.equal(ciTier({ event: 'push', refName: 'development' }), 'bounded')
  assert.equal(ciTier({ event: 'push', refName: 'main', headBranch: 'development' }), 'full')
  assert.equal(ciTier({ event: 'push', refName: 'development/topic' }), 'full')
  assert.equal(plan(['package.json'], { CI_REF_NAME: 'development' }, 'push').tier, 'bounded')
})

test('a development push runs reached UI specs against the before revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-development-map-'))
  try {
    const map = join(directory, 'map.json')
    writeFileSync(map, JSON.stringify(impactMap()))
    const run = cliPlan(['packages/ui/src/components/BringHome.tsx'], 'push', {
      CI_REF_NAME: 'development', CI_BEFORE: 'HEAD', UI_IMPACT_MAP: map,
    })
    assert.deepEqual([run.tier, run.browser, run.native, run.matrix, run.record], ['bounded', 'all', 'false', 'pr', 'false'])
    assert.deepEqual(JSON.parse(run.browser_specs), ['e2e/ui-system/row-box.spec.ts'])
    assert.match(run.summary, /Development push/)
    assert.match(run.summary, /Selected by the specs that ran the changed UI source/)
    assert.match(run.summary, /Native smoke.*full tier/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a development push touching only docs selects no browser or native job', () => {
  const run = cliPlan(['docs/architecture.md'], 'push', { CI_REF_NAME: 'development' })
  assert.deepEqual([run.tier, run.browser, run.native, run.shard_count, run.shards, run.record], ['bounded', 'none', 'false', '0', '[1]', 'false'])
  assert.match(run.summary, /not needed for this change/)
})

test('a development push keeps edited specs and server-facing coverage in the bounded matrix', () => {
  const paths = ['e2e/ui-system/row-box.spec.ts', 'packages/server/src/host.ts']
  const run = cliPlan(paths, 'push', { CI_REF_NAME: 'development' })
  assert.deepEqual(JSON.parse(run.browser_specs), JSON.parse(plan(paths).browser_specs))
  assert.equal(run.native, 'false')
  assert.equal(run.matrix, 'pr')
  assert.ok(Number(run.shard_count) <= 4)
  const server = cliPlan(['packages/server/src/host.ts'], 'push', { CI_REF_NAME: 'development' })
  assert.equal(server.browser, 'server')
  assert.equal(server.native, 'false')
})

for (const before of ['', '0'.repeat(40), 'f'.repeat(40)]) {
  test(`an unreadable development push range runs every browser spec: ${before || 'missing before'}`, () => {
    // The workflow removes the path list when before is missing, zero or unavailable.
    const run = cliPlan(null, 'push', { CI_REF_NAME: 'development', CI_BEFORE: before })
    assert.deepEqual([run.tier, run.browser, run.native, run.browser_specs, run.matrix, run.record], ['bounded', 'all', 'false', 'all', 'pr', 'false'])
    assert.match(run.summary, /change range unavailable.*every browser spec/)
  })
}

for (const event of ['pull_request', 'workflow_dispatch']) {
  test(`development runs the full tier on ${event}`, () => {
    const env = { CI_REF_NAME: 'development', CI_HEAD_BRANCH: event === 'pull_request' ? 'development' : '' }
    const run = cliPlan(['docs/architecture.md'], event, env)
    // The release pull request reads every spec; development's own full run reads both themes and records.
    const thorough = event === 'workflow_dispatch'
    assert.deepEqual([run.tier, run.browser, run.native, run.matrix, run.browser_specs, run.record], ['full', 'all', 'true', thorough ? 'full' : 'pr', 'all', String(thorough)])
    assert.equal(plan(['docs/architecture.md'], env, event).tier, 'full')
  })
}

test('only the exact development PR head selects the release tier', () => {
  assert.equal(ciTier({ event: 'pull_request', headBranch: 'development/topic' }), 'bounded')
  assert.equal(ciTier({ event: 'pull_request', refName: 'development' }), 'bounded')
})

for (const path of [
  'packages/ui/src/App.tsx',
  'e2e/ui-system/untraceable-data.json', 'e2e/ui-system/a-deleted-helper.ts',
]) {
  test(`a development push runs every spec when the plan cannot narrow ${path}`, () => {
    const run = cliPlan([path], 'push', { CI_REF_NAME: 'development' })
    assert.equal(run.browser_specs, 'all')
    assert.ok(Number(run.shard_count) > 4, run.shard_count)
    assert.doesNotMatch(run.summary, /Deferred to full tier/)
  })
}

test('a stale source map ranks a capped conservative development selection', () => {
  const map = impactMap()
  const base = current(map).baseFiles()
  base['packages/ui/src/components/BringHome.tsx'] = 'f'.repeat(40)
  const run = planWith(['packages/ui/src/components/BringHome.tsx'], { ...current(map), baseFiles: () => base }, { event: 'push', refName: 'development' })
  assert.ok(JSON.parse(run.specs).includes('e2e/ui-system/row-box.spec.ts'))
  assert.ok(run.deferred.length > 0)
  assert.ok(run.count <= 4)
  assert.match(run.summary, /Not narrowed: .*has changed on the base branch/)
})

test('a development push still caps a successfully narrowed impact plan', () => {
  const run = planWith(['packages/ui/src/design/ui/button.tsx'], current(impactMap()), { event: 'push', refName: 'development' })
  assert.ok(run.deferred.length > 0)
  assert.ok(run.count <= 4)
})

test('an unreadable input graph runs every browser spec on a development push', async () => {
  await fixture((root, put) => {
    put('e2e/ui-system/durations.json', '{}')
    // The source walk encounters an unreadable file while building uiExternalImports.
    put('packages/ui/src/placeholder.ts', '')
    symlinkSync('missing.ts', join(root, 'packages/ui/src/unreadable.ts'))
    const run = planChange(root, { event: 'push', refName: 'development', paths: ['docs/architecture.md'] })
    assert.equal(run.browser, 'all')
    assert.equal(run.browser_specs, 'all')
    assert.match(run.summary, /input graph unavailable.*every browser spec/)
  })
})

for (const [path, spec] of [
  ['docs/interface.md', 'team-board-widths.spec.ts'],
  ['script/shots/shoot.mjs', 'header-status-group.spec.ts'],
  ['script/shots/template-rig.mjs', 'front-door-edit.spec.ts'],
  ['script/shots/templates.mjs', 'template-journeys.spec.ts'],
]) {
  test(`a development push touching ${path} covers ${spec}`, () => {
    const run = cliPlan([path], 'push', { CI_REF_NAME: 'development' })
    assert.equal(run.browser, 'all')
    assert.ok(run.browser_specs === 'all' || JSON.parse(run.browser_specs).includes(`e2e/ui-system/${spec}`))
    assert.equal(run.native, 'false')
  })
}

for (const event of ['push', 'pull_request']) {
  test(`UI source beside a repository read keeps both narrow selections on ${event}`, () => {
    const map = impactMap('/src/App.tsx')
    const run = planWith(['packages/ui/src/App.tsx', 'docs/interface.md'], current(map), { event, refName: 'development' })
    assert.deepEqual(JSON.parse(run.specs), ['e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/team-board-widths.spec.ts'])
    assert.equal(run.count, 1)
    assert.deepEqual(run.deferred, [])
  })
}

for (const [name, source] of [
  ['direct read', "readFileSync('docs/new-contract.md', 'utf8')"],
  ['helper URL', "import './helper'"],
  ['package read', "readFileSync('packages/cli/package.json', 'utf8')"],
]) {
  test(`repository readers are selected for a ${name}`, async () => {
    await fixture((root, put) => {
      put('docs/new-contract.md', 'contract')
      put('packages/cli/package.json', JSON.stringify({ name: '@harnessdesk/cli' }))
      put('e2e/ui-system/row-box.spec.ts', source)
      put('e2e/ui-system/helper.ts', "readFileSync(new URL('../../docs/new-contract.md', import.meta.url), 'utf8')")
      put('e2e/ui-system/durations.json', '{}')
      const run = planChange(root, { event: 'push', refName: 'development', paths: [name === 'package read' ? 'packages/cli/package.json' : 'docs/new-contract.md'] })
      assert.equal(run.browser, 'all')
      assert.deepEqual(JSON.parse(run.browser_specs), ['e2e/ui-system/row-box.spec.ts'])
    })
  })
}

test('environment changes keep the cap and rank recorded reach before the remaining specs', async () => {
  await fixture((root, put) => {
    put('packages/ui/src/App.tsx', 'export const App = () => null')
    const times = {}
    for (const name of [...Array.from({ length: 8 }, (_, i) => `a${i}.spec.ts`), 'z-reached.spec.ts']) {
      put(`e2e/ui-system/${name}`, 'export {}')
      times[name] = 900
    }
    put('e2e/ui-system/durations.json', JSON.stringify(times))
    // Mark all specs as recorded without giving the unrelated specs App's reach.
    const complete = mergeRecords(root, Object.keys(times).map(name => ({ [`e2e/ui-system/${name}`]: { tests: 1, unclean: 0, loaded: ['/src/App.tsx'], ran: name === 'z-reached.spec.ts' ? ['/src/App.tsx'] : [] } })), { environment: { 'packages/protocol': 'old' } })
    const impact = { ...current(complete), baseEnvironment: () => ({ 'packages/protocol': 'new' }) }
    for (const inputs of [['packages/ui/src/App.tsx'], ['packages/ui/src/App.tsx', 'packages/protocol/src/wire.ts']]) {
      const run = browserPlan(root, { browser: 'all', inputs, serverInputs: false, event: 'push', refName: 'development', impact })
      assert.ok(run.count <= 4)
      assert.ok(run.deferred.length > 0)
      assert.ok(JSON.parse(run.specs).includes('e2e/ui-system/z-reached.spec.ts'))
      assert.match(run.summary, /map.*environment differs/i)
      for (const spec of run.deferred) assert.ok(run.summary.includes(spec), spec)
    }
  })
})

for (const path of ['script/lib/temporary-directory.mjs', 'packages/plugins/src/index.ts', 'packages/adapter-codex/test/fixtures/fake-codex.mjs']) {
  test(`${path} selects its browser readers and native smoke`, () => check([path], ['all', true]))
}

test('a literal suite data read selects only its reader', () => {
  const run = plan(['e2e/ui-system/composer-slot-record.json'])
  assert.deepEqual(JSON.parse(run.browser_specs), ['e2e/ui-system/composer-slots.spec.ts'])
})

for (const literal of ["'docs/deleted-contract.md'", "new URL('../../docs/deleted-contract.md', import.meta.url)"]) {
  test(`a deleted literal read still selects its reader: ${literal}`, async () => {
    await fixture((root, put) => {
      put('e2e/ui-system/row-box.spec.ts', `readFileSync(${literal}, 'utf8')`)
      put('e2e/ui-system/durations.json', '{}')
      const run = planChange(root, { event: 'push', refName: 'development', paths: ['docs/deleted-contract.md'] })
      assert.equal(run.browser, 'all')
      assert.deepEqual(JSON.parse(run.browser_specs), ['e2e/ui-system/row-box.spec.ts'])
    })
  })
}

for (const path of ['packages/ui/package.json', 'packages/protocol/src/ids.ts', 'docs/shared.json']) {
  for (const withMap of [false, true]) {
    test(`a reader never narrows the whole-UI input ${path}, map=${withMap}`, async () => {
      await fixture((root, put) => {
        put('packages/ui/src/App.tsx', "import '../../../docs/shared.json'")
        put('docs/shared.json', '{}')
        put('packages/protocol/src/ids.ts', 'export {}')
        const times = {}
        for (const name of [...Array.from({ length: 9 }, (_, i) => `a${i}.spec.ts`), 'z-reader.spec.ts']) {
          put(`e2e/ui-system/${name}`, name.startsWith('z-') ? `readFileSync('${path}', 'utf8')` : 'export {}')
          times[name] = 900
        }
        put('e2e/ui-system/durations.json', JSON.stringify(times))
        const map = withMap ? mergeRecords(root, Object.keys(times).map(name => ({
          [`e2e/ui-system/${name}`]: { tests: 1, unclean: 0, loaded: [], ran: [] },
        }))) : null
        for (const event of ['push', 'pull_request']) {
          const run = planChange(root, { event, refName: 'development', paths: [path], map })
          const selected = run.browser_specs === 'all' ? specFiles(root).map(spec => `e2e/ui-system/${spec}`) : JSON.parse(run.browser_specs)
          assert.ok(selected.length > 1, 'the reader is mandatory, not the complete impact')
          assert.ok(selected.includes('e2e/ui-system/z-reader.spec.ts'))
        }
      })
    })
  }
}

for (const path of ['package.json', 'pnpm-lock.yaml', 'packages/ui/vite.config.ts', 'packages/protocol/src/wire.ts', 'assets/example.svg']) {
  test(`a global input keeps the cap and names its reason: ${path}`, () => {
    for (const impact of [null, current(impactMap())]) {
      const run = planWith([path], impact, { event: 'push', refName: 'development', sha: 'a'.repeat(40) })
      assert.equal(run.count, 4)
      assert.ok(run.deferred.length > 0)
      assert.ok(run.summary.includes(`Not narrowed: global input ${path}`), run.summary)
    }
  })
}

test('global capped coverage rotates by push sha and falls back to before', () => {
  const impact = current(impactMap())
  const select = options => planWith(['pnpm-lock.yaml'], impact, { event: 'push', refName: 'development', ...options }).specs
  const first = select({ sha: 'a'.repeat(40), before: 'c'.repeat(40) })
  const second = select({ sha: 'b'.repeat(40), before: 'c'.repeat(40) })
  assert.notEqual(first, second)
  assert.equal(first, select({ sha: 'a'.repeat(40), before: 'd'.repeat(40) }))
  assert.equal(first, select({ before: 'a'.repeat(40) }))
  const alphabetical = specFiles(real).slice(0, JSON.parse(first).length).map(spec => `e2e/ui-system/${spec}`)
  assert.notDeepEqual(JSON.parse(first), alphabetical)
})

test('the development CLI keys global rotation by the pushed sha', () => {
  const first = cliPlan(['pnpm-lock.yaml'], 'push', { CI_REF_NAME: 'development', GITHUB_SHA: 'a'.repeat(40) })
  const second = cliPlan(['pnpm-lock.yaml'], 'push', { CI_REF_NAME: 'development', GITHUB_SHA: 'b'.repeat(40) })
  assert.equal(first.shard_count, '4')
  assert.equal(second.shard_count, '4')
  assert.notEqual(first.browser_specs, second.browser_specs)
})

for (const path of ['.github/workflows/ci.yml', 'playwright.ui-system.config.ts']) {
  test(`a suite execution configuration change runs everything uncapped: ${path}`, () => {
    const run = planWith([path], current(impactMap()), { event: 'push', refName: 'development' })
    assert.equal(run.specs, 'all')
    assert.ok(run.count > 4)
    assert.deepEqual(run.deferred, [])
  })
}

test('an unread shot README selects no browser specs', () => {
  const run = planChange(real, { event: 'push', refName: 'development', paths: ['script/shots/README.md'] })
  assert.equal(run.browser, 'none')
  assert.equal(run.shard_count, 0)
})

test('an unread shot README preserves a narrow UI selection', () => {
  const run = planWith(['packages/ui/src/App.tsx', 'script/shots/README.md'], current(impactMap('/src/App.tsx')), { event: 'push', refName: 'development' })
  assert.deepEqual(JSON.parse(run.specs), ['e2e/ui-system/row-box.spec.ts'])
  assert.equal(run.count, 1)
  assert.deepEqual(run.deferred, [])
})

for (const path of ['packages/ui/src/components/BringHome.tsx', 'e2e/ui-system/a-deleted-helper.ts']) {
  test(`a global input cannot hide an unresolved development input: ${path}`, () => {
    const run = cliPlan(['pnpm-lock.yaml', path], 'push', { CI_REF_NAME: 'development' })
    assert.equal(run.browser_specs, 'all')
    assert.doesNotMatch(run.summary, /Deferred to full tier/)
    assert.match(run.summary, /global input pnpm-lock.yaml/)
    assert.match(run.summary, path.startsWith('packages/') ? /no impact map/ : /unresolved suite input/)
    assert.match(run.summary, /running every browser spec/)
  })
}

test('a push of a tree a full run already passed runs core CI only', () => {
  for (const env of [{ CI_REF_NAME: 'development' }, { CI_REF_NAME: 'main' }]) {
    const run = cliPlan(['packages/ui/src/App.tsx'], 'push', { ...env, CI_PROVEN_BY: '41119214274' })
    assert.deepEqual([run.browser, run.native, run.browser_specs, run.shard_count, run.record], ['none', 'false', '[]', '0', 'false'], env.CI_REF_NAME)
    assert.match(run.summary, /Full run 41119214274 passed this exact tree/)
  }
  // Only a push reads a proof, and only a run id stands for one.
  assert.equal(cliPlan(['packages/ui/src/App.tsx'], 'workflow_dispatch', { CI_REF_NAME: 'development', CI_PROVEN_BY: '41119214274' }).browser, 'all', 'the nightly run never skips')
  assert.equal(cliPlan(['packages/ui/src/App.tsx'], 'pull_request', { CI_HEAD_BRANCH: 'batch/x', CI_PROVEN_BY: '41119214274' }).browser, 'all')
  for (const proof of ['', '0', 'yes', '12 34', '$(id)']) {
    assert.equal(cliPlan(['packages/ui/src/App.tsx'], 'push', { CI_REF_NAME: 'main', CI_PROVEN_BY: proof }).browser, 'all', JSON.stringify(proof))
  }
})

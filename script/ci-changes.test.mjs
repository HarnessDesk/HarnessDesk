import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { browserPlan, planChange, themeDiff, themeInputs } from './ci-changes.mjs'
import { specFiles } from './ci-browser-shards.mjs'
import { mergeRecords } from './ui-impact.mjs'

const script = fileURLToPath(new URL('./ci-changes.mjs', import.meta.url))
const check = (paths, expected, event = 'pull_request', env = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  try {
    const list = join(directory, 'paths')
    if (paths !== null) writeFileSync(list, paths.length ? `${paths.join('\0')}\0` : '')
    const result = spawnSync(process.execPath, [script, list], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, UI_THEME_TOUCHED: '', UI_SYSTEM_MATRIX_REQUEST: '', UI_IMPACT_MAP: '', ...env },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    assert.equal(output.browser, expected[0])
    assert.equal(output.native, String(expected[1]))
    assert.deepEqual(JSON.parse(output.server_specs), ['e2e/ui-system/notices-inbox.spec.ts', 'e2e/ui-system/run-ending.spec.ts', 'e2e/ui-system/template-contest-journey.spec.ts', 'e2e/ui-system/template-journeys.spec.ts'])
    return output
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

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
for (const path of ['packages/desktop/electron/main.mjs', 'script/shots/seed.mjs', 'script/lib/temporary-directory.mjs']) {
  test(`${path} runs native smoke`, () => check([path], ['none', true]))
}
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

for (const path of ['packages/server/src/host.ts', 'packages/plugins/src/index.ts', 'packages/adapter-codex/test/fixtures/fake-codex.mjs']) {
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

// What the browser job runs, and how it is sized (the plan of `browserPlan`).
const plan = (paths, env = {}, event = 'pull_request') => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-plan-'))
  try {
    const list = join(directory, 'paths')
    writeFileSync(list, paths.length ? `${paths.join('\0')}\0` : '')
    const result = spawnSync(process.execPath, [script, list], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, UI_THEME_TOUCHED: '', UI_SYSTEM_MATRIX_REQUEST: '', ...env },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    return output
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a pull request that touches the UI runs every spec in the pull-request matrix, on as many shards as the work needs', () => {
  const run = plan(['packages/ui/src/App.tsx'])
  assert.equal(run.browser, 'all')
  assert.equal(run.browser_specs, 'all')
  assert.equal(run.matrix, 'pr')
  assert.ok(Number(run.shard_count) >= 2 && Number(run.shard_count) <= 16, run.shard_count)
  assert.deepEqual(JSON.parse(run.shards), Array.from({ length: Number(run.shard_count) }, (_, index) => index + 1))
})

test('the pull-request matrix never needs more shards than the whole of main', () => {
  const main = Number(plan(['docs/architecture.md'], {}, 'push').shard_count)
  assert.ok(Number(plan(['packages/ui/src/App.tsx']).shard_count) <= main)
})

test('a diff that names a theme reads both themes', () =>
  assert.equal(plan(['packages/ui/src/App.tsx'], { UI_THEME_TOUCHED: 'true' }).matrix, 'full'))

for (const path of ['pnpm-lock.yaml', 'package.json', '.github/workflows/ci.yml', 'assets/avatars/128/blue.png', 'playwright.ui-system.config.ts', 'script/ci-browser-shards.mjs']) {
  test(`${path} reads both themes`, () => assert.equal(plan(['packages/ui/src/App.tsx', path]).matrix, 'full'))
}

// A declaration added inside an existing `body[data-hd-dark-theme]` block says neither "dark" nor "theme" in its own line.
for (const path of ['packages/ui/src/design/foundation/tokens.css', 'packages/ui/src/styles/app.css', 'packages/ui/vite.config.ts', 'packages/ui/tsconfig.json', 'packages/ui/package.json']) {
  test(`${path} reads both themes, whatever the lines of the diff say`, () => assert.equal(plan([path]).matrix, 'full'))
}

test('a stylesheet that names a theme before or after the change reads both themes', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const popup = ['packages/ui/src/design/ui/popup.css'] // says neither word today
  assert.equal(themeInputs(root, popup, () => null), false, 'a stylesheet that is neither')
  assert.equal(themeInputs(root, popup, () => 'body[data-hd-dark-theme] { --x: 1 }'), true, 'it named a theme before the change and the change took the word out')
  assert.equal(themeInputs(root, ['packages/ui/src/components/Row.tsx'], () => 'dark'), false, 'only stylesheets are read for the word')
})

test('main and a run on demand read both themes of every spec', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const run = plan(['packages/ui/src/App.tsx'], {}, event)
    assert.deepEqual([run.browser, run.browser_specs, run.matrix], ['all', 'all', 'full'], event)
    assert.ok(Number(run.shard_count) >= Number(plan(['packages/ui/src/App.tsx']).shard_count), event)
  }
})

test('a run on demand can ask for the pull-request matrix, and a pull request for nothing else', () => {
  assert.equal(plan(['packages/ui/src/App.tsx'], { UI_SYSTEM_MATRIX_REQUEST: 'pr' }, 'workflow_dispatch').matrix, 'pr')
  assert.equal(plan(['packages/ui/src/App.tsx'], { UI_SYSTEM_MATRIX_REQUEST: 'bogus' }).matrix, 'pr')
})

test('an unreadable change list reads both themes of every spec', () => {
  const run = check(null, ['all', true])
  assert.deepEqual([run.browser_specs, run.matrix], ['all', 'full'])
})

test('a pull request that only edits one spec runs that spec, in both themes, on one shard', () => {
  const run = plan(['e2e/ui-system/row-box.spec.ts'])
  assert.deepEqual([run.browser, run.browser_specs, run.matrix, run.shard_count, run.shards], ['all', '["e2e/ui-system/row-box.spec.ts"]', 'full', '1', '[1]'])
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
  const direct = JSON.parse(plan(['e2e/ui-system/frame-contract-helpers.ts']).browser_specs)
  const wall = JSON.parse(plan(['e2e/ui-system/frame-wall-destinations.ts']).browser_specs)
  assert.ok(wall.length >= direct.length, 'the destinations are imported by the helpers, so everything the helpers reach is reached')
  for (const spec of direct) assert.ok(wall.includes(spec), spec)
})

test('data a spec might read at run time, or a deleted helper, cannot be traced and runs every spec', () => {
  for (const path of ['e2e/ui-system/composer-slot-record.json', 'e2e/ui-system/a-helper-that-was-deleted.ts']) {
    const run = plan([path])
    assert.deepEqual([run.browser, run.browser_specs, run.matrix], ['all', 'all', 'full'], path)
  }
})

test('deleting a spec runs nothing', () =>
  assert.equal(plan(['e2e/ui-system/a-spec-that-was-deleted.spec.ts']).browser, 'none'))

test('a spec edit beside a host change also runs the server-facing specs', () => {
  const run = plan(['e2e/ui-system/row-box.spec.ts', 'packages/server/src/host.ts'])
  assert.deepEqual(JSON.parse(run.browser_specs), [
    'e2e/ui-system/notices-inbox.spec.ts', 'e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/run-ending.spec.ts',
    'e2e/ui-system/template-contest-journey.spec.ts', 'e2e/ui-system/template-journeys.spec.ts',
  ])
})

test('the outputs are well formed on a run that skips the browser job', () => {
  const run = plan(['docs/architecture.md'])
  assert.deepEqual([run.browser, run.shard_count, run.shards], ['none', '0', '[1]'])
})

// A map of the real repository, made up: every spec ran the button, and `row-box.spec.ts` alone ran BringHome.
const real = fileURLToPath(new URL('../', import.meta.url))
const impactMap = () => {
  const records = specFiles(real).map(spec => ({
    [`e2e/ui-system/${spec}`]: {
      tests: 1, unclean: 0,
      loaded: ['/src/design/ui/button.tsx', '/src/components/BringHome.tsx'],
      ran: spec === 'row-box.spec.ts' ? ['/src/design/ui/button.tsx', '/src/components/BringHome.tsx'] : ['/src/design/ui/button.tsx'],
    },
  }))
  return mergeRecords(real, records, { commit: 'abcdef1234567' })
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

test('a change to something every spec ran, and a change without a map, run every spec', () => {
  const map = impactMap()
  const all = JSON.parse(planWith(['packages/ui/src/design/ui/button.tsx'], current(map)).specs)
  assert.equal(all.length, specFiles(real).length)
  const unmapped = planWith(['packages/ui/src/components/BringHome.tsx'], null)
  assert.deepEqual([unmapped.specs, unmapped.matrix], ['all', 'pr'])
})

test('a file that has moved on since the map was recorded runs every spec, and the summary says why', () => {
  const map = impactMap()
  const base = current(map).baseFiles()
  base['packages/ui/src/components/BringHome.tsx'] = 'f'.repeat(40)
  const run = planWith(['packages/ui/src/components/BringHome.tsx'], { ...current(map), baseFiles: () => base })
  assert.equal(run.specs, 'all')
  assert.match(run.summary, /Not narrowed: .*BringHome\.tsx has changed on the base branch since the map was recorded/)
})

test('a change to the UI beside something the map cannot speak for runs every spec', () => {
  const map = impactMap()
  for (const beside of ['package.json', 'packages/ui/vite.config.ts', 'packages/protocol/src/index.ts']) {
    assert.equal(planWith(['packages/ui/src/components/BringHome.tsx', beside], current(map)).specs, 'all', beside)
  }
})

test('a change to the UI beside an edit to the suite runs both selections, in both themes', () => {
  const map = impactMap()
  const run = planWith(['packages/ui/src/components/BringHome.tsx', 'e2e/ui-system/rules.spec.ts'], current(map))
  assert.deepEqual(JSON.parse(run.specs), ['e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/rules.spec.ts'])
  assert.equal(run.matrix, 'full')
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
  for (const event of ['push', 'workflow_dispatch']) assert.equal(plan(ui, {}, event).record, 'true', event)
  assert.equal(plan(ui, { UI_THEME_TOUCHED: 'true' }).record, 'true', 'a pull request that reads both themes of every spec')
  assert.equal(plan(ui).record, 'false', 'a pull request that reads one theme')
  assert.equal(plan(ui, { UI_SYSTEM_MATRIX_REQUEST: 'pr' }, 'workflow_dispatch').record, 'false', 'a run on demand for the pull-request matrix')
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
      assert.deepEqual([run.browser, run.browser_specs, run.matrix], ['all', 'all', 'pr'], name)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a summary never carries a newline into the outputs, whatever a path is called', () => {
  const map = impactMap()
  const run = planWith(['packages/ui/src/components/BringHome.tsx'], { ...current(map), baseFiles: () => ({ ...current(map).baseFiles(), 'packages/ui/src/new\nbrowser=none.ts': 'a'.repeat(40) }) })
  assert.equal(run.specs, 'all')
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

test('the shared change plan prints the same fields, in the same order, as the CI CLI', () => {
  const real = fileURLToPath(new URL('../', import.meta.url))
  const paths = ['docs/architecture.md']
  const output = check(paths, ['none', false])
  const shared = planChange(real, { event: 'pull_request', paths })
  assert.deepEqual(Object.fromEntries(Object.entries(shared).map(([key, value]) => [key, String(value)])), output)
  assert.deepEqual(Object.keys(shared), Object.keys(output))
})

test('theme diff selection matches the unchanged CI grep pipeline', () => {
  const real = fileURLToPath(new URL('../', import.meta.url))
  const workflow = readFileSync(join(real, '.github/workflows/ci.yml'), 'utf8')
  const pipeline = workflow.match(/git diff --no-renames -U0 HEAD\^1 HEAD -- packages\/ui \| (grep[^;]+); then/)?.[1]
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
    assert.deepEqual([run.browser, run.specs, run.count, run.matrix], ['all', JSON.stringify(['e2e/ui-system/row-box.spec.ts']), 1, 'full'])
    assert.match(run.summary, /1 of 3 specs, full theme matrix, 1 shard/) // the fixture's own ui.spec.ts is the third
  })
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./ci-changes.mjs', import.meta.url))
const check = (paths, expected, event = 'pull_request') => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  try {
    const list = join(directory, 'paths')
    if (paths !== null) writeFileSync(list, paths.length ? `${paths.join('\0')}\0` : '')
    const result = spawnSync(process.execPath, [script, list], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    assert.equal(output.browser, expected[0])
    assert.equal(output.native, String(expected[1]))
    assert.deepEqual(JSON.parse(output.server_specs), ['e2e/ui-system/notices-inbox.spec.ts', 'e2e/ui-system/run-ending.spec.ts'])
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
for (const path of ['e2e/ui-system/layout.spec.ts', 'e2e/ui-system/durations.json', 'playwright.ui-system.config.ts', 'script/ci-browser-shards.mjs']) {
  test(`${path} runs the browser suite`, () => check([path], ['all', false]))
}
for (const path of ['packages/desktop/electron/main.mjs', 'script/shots/seed.mjs', 'script/lib/temporary-directory.mjs']) {
  test(`${path} runs native smoke`, () => check([path], ['none', true]))
}
test('native smoke runner runs both suites because it is also in the browser test directory', () =>
  check(['e2e/ui-system/native-smoke.mjs'], ['all', true]))
test('empty input runs everything', () => check([], ['all', true]))
test('unreadable input runs everything', () => check(null, ['all', true]))
test('push to main runs everything even for docs', () => check(['docs/architecture.md'], ['all', true], 'push'))
test('NUL input preserves filenames with spaces and newlines', () =>
  check(['docs/line\nbreak.md', 'docs/a b.md'], ['none', false]))
test('a mixed change runs each affected suite', () =>
  check(['docs/architecture.md', 'packages/desktop/electron/main.mjs', 'e2e/ui-system/layout.spec.ts'], ['all', true]))

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

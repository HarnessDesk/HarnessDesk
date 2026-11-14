import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as planner from './ci-changes.mjs'
import { specFiles } from './ci-browser-shards.mjs'
import { environmentAt, mergeRecords } from './ui-impact.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const ci = (paths, options = {}) => (planner.planCIChange ?? planner.planChange)(root, {
  event: 'pull_request', baseBranch: 'development', paths, ...options,
})

for (const paths of [['docs/architecture.md'], ['script/land-safe.test.mjs'], ['packages/server/test/lane-fixture.test.ts'], ['packages/ui/src/state/store.test.ts']]) {
  test(`a complete low-risk selection earns scoped proof: ${paths}`, () => {
    const run = ci(paths)
    assert.equal(run.tier, 'scoped')
    assert.equal(run.native, false)
    assert.equal(run.record, false)
    assert.equal(run.browser, 'none', 'unread test code is covered by the core test suites')
    assert.match(run.summary, /complete affected selection/i)
  })
}

test('edited browser specs run immediately instead of waiting for a second full run', () => {
  const run = ci(['e2e/ui-system/row-box.spec.ts'])
  assert.equal(run.tier, 'scoped')
  assert.equal(run.browser, 'all')
  assert.deepEqual(JSON.parse(run.browser_specs), ['e2e/ui-system/row-box.spec.ts'])
})

for (const path of [
  'packages/server/src/host.ts', 'packages/protocol/src/wire.ts',
  'packages/crypto/src/e2ee.ts', 'packages/phone-link/src/server.ts',
  'packages/adapter-codex/src/runtime.ts', 'packages/ui/src/state/workbench.ts',
  'packages/ui/src/lib/sanitize.ts', 'packages/ui/src/components/Approvals.tsx',
  'packages/ui/src/design/ui/button.tsx', '.github/workflows/ci.yml',
  'script/ci-changes.test.mjs', 'script/ci-browser-shards.mjs', 'script/ui-system-run.test.mjs',
  'pnpm-lock.yaml', 'package.json', 'unknown/input.txt',
]) {
  test(`a high-risk or unclassified input starts full CI: ${path}`, () => {
    const run = ci(['docs/architecture.md', path])
    assert.equal(run.tier, 'full')
    assert.equal(run.browser_specs, 'all')
    assert.equal(run.native, true)
  })
}

for (const paths of [null, [], ['docs/../package.json'], ['docs/a\nb.md'], ['docs//a.md'], ['/docs/a.md']]) {
  test(`an unknown or malformed range starts full CI: ${JSON.stringify(paths)}`, () => {
    assert.equal(ci(paths).tier, 'full')
  })
}

for (const options of [
  { labels: ['full-ci'] }, { headBranch: 'development' }, { headBranch: 'batch/reviewed' },
  { event: 'workflow_dispatch' }, { event: 'push', refName: 'main' },
  { baseBranch: 'main' }, { baseBranch: '' },
]) {
  test(`explicit full and release validation cannot be scoped: ${JSON.stringify(options)}`, () => {
    const run = ci(['docs/architecture.md'], options)
    assert.equal(run.tier, 'full')
    assert.equal(run.browser_specs, 'all')
    assert.equal(run.native, true)
  })
}

test('a local UI change without trustworthy impact evidence starts full CI', () => {
  const run = ci(['packages/ui/src/components/BringHome.tsx'])
  assert.equal(run.tier, 'full')
  assert.equal(run.browser_specs, 'all')
})

test('a fresh impact map can authorize a complete local component selection', () => {
  const map = mergeRecords(root, specFiles(root).map(spec => ({ [`e2e/ui-system/${spec}`]: {
    tests: 1, unclean: 0, loaded: ['/src/components/BringHome.tsx'],
    ran: spec === 'row-box.spec.ts' ? ['/src/components/BringHome.tsx'] : [],
  } })), { environment: environmentAt(root, 'HEAD') })
  const run = ci(['packages/ui/src/components/BringHome.tsx'], { map, baseRevision: 'HEAD' })
  assert.equal(run.tier, 'scoped')
  assert.ok(JSON.parse(run.browser_specs).includes('e2e/ui-system/row-box.spec.ts'))
  assert.equal(run.native, false)
  const stale = structuredClone(map)
  stale.environment['package.json'] = '0'.repeat(40)
  assert.equal(ci(['packages/ui/src/components/BringHome.tsx'], { map: stale, baseRevision: 'HEAD' }).tier, 'full')
})

for (const path of ['components/Icons.tsx', 'components/BrandIcons.tsx', 'components/glyphs/loader-circle.tsx',
  'components/Markdown.module.css', 'panels/mount.tsx', 'panels/top-bar.tsx', 'panels/destination-page.tsx']) {
  test(`shared UI infrastructure requires full proof even with a fresh map: ${path}`, () => {
    const map = mergeRecords(root, specFiles(root).map(spec => ({ [`e2e/ui-system/${spec}`]: {
      tests: 1, unclean: 0, loaded: [`/src/${path}`], ran: spec === 'row-box.spec.ts' ? [`/src/${path}`] : [],
    } })), { environment: environmentAt(root, 'HEAD') })
    assert.equal(ci([`packages/ui/src/${path}`], { map, baseRevision: 'HEAD' }).tier, 'full')
  })
}

test('complete selection never drops specs to satisfy the local four-shard budget', () => {
  const all = specFiles(root).map(spec => `e2e/ui-system/${spec}`)
  const run = planner.browserPlan(root, {
    browser: 'all', inputs: all, event: 'pull_request', completeSelection: true,
  })
  assert.deepEqual(JSON.parse(run.specs), all)
  assert.deepEqual(run.deferred, [])
  assert.ok(run.count > 4, 'the complete selection gets the runners it needs')
})

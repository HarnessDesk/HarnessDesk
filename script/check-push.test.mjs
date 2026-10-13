import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as changes from './ci-changes.mjs'
import { unitPlan } from './ci-unit-tests.mjs'
import { ciCommands } from './check-verify-drift.mjs'
import { environmentAt, mergeRecords, readMap } from './ui-impact.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = join(root, 'script/check-push.mjs')
const api = async () => {
  assert.ok(existsSync(script), 'the public check:push runner exists')
  return import('./check-push.mjs')
}
const fixture = async run => {
  const directory = mkdtempSync(join(tmpdir(), 'check-push-'))
  const put = (path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '-q', '-b', 'main')
    put('packages/ui/package.json', JSON.stringify({ name: '@harnessdesk/ui', dependencies: { '@harnessdesk/protocol': 'workspace:*' } }))
    put('packages/protocol/package.json', JSON.stringify({ name: '@harnessdesk/protocol' }))
    put('packages/server/package.json', JSON.stringify({ name: '@harnessdesk/server', dependencies: { '@harnessdesk/protocol': 'workspace:*' } }))
    put('packages/ui/src/components/BringHome.tsx', 'export const BringHome = () => null\n')
    put('packages/protocol/src/index.ts', 'export const value = 1\n')
    put('packages/protocol/tsconfig.json', '{"compilerOptions":{"outDir":"dist"}}')
    put('packages/protocol/test/wire.test.ts', '')
    put('packages/server/src/index.ts', 'export const value = 1\n')
    put('packages/server/tsconfig.json', '{"compilerOptions":{"outDir":"dist"}}')
    put('packages/server/test/host.test.ts', '')
    put('packages/server/test/intake-host.test.ts', '')
    put('packages/server/test/flow-host-evidence-review.test.ts', '')
    put('e2e/ui-system/row-box.spec.ts', 'export {}\n')
    put('e2e/ui-system/server.spec.ts', "import { value } from '../../packages/server/dist/src/index.js'\n")
    put('e2e/ui-system/durations.json', '{"row-box.spec.ts":20,"server.spec.ts":30}')
    put('.github/workflows/ci.yml', 'jobs:\n  gates:\n    steps:\n      - run: node script/check-secrets.mjs\n  node-e2e:\n    steps:\n      - run: node --test --test-timeout=600000 "packages/server/dist/test/intake-*.test.js"\n      - run: node --test --test-timeout=600000 "packages/server/dist/test/flow-host-evidence-*.test.js"\n')
    put('docs/guide.md', 'Guide\n')
    put('script/check-secrets.mjs', '')
    put('script/check-doc-paths.mjs', '')
    git('add', '.')
    git('commit', '-qm', 'Fixture base')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    await run(directory, put, git)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const cli = (cwd, args = []) => spawnSync(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, UI_IMPACT_MAP: '', UI_SYSTEM_MATRIX_REQUEST: '' },
})

for (const paths of [
  ['packages/ui/src/components/BringHome.tsx'],
  ['e2e/ui-system/row-box.spec.ts'],
  ['script/check-doc-paths.mjs'],
  ['docs/architecture.md'],
  ['packages/server/src/host.ts'],
  ['.github/workflows/ci.yml'], ['package.json'], ['pnpm-lock.yaml'], [],
]) {
  test(`local selection shares CI's planners for ${paths.join(', ') || 'an empty change'}`, async () => {
    const { createPlan } = await api()
    const options = { paths, event: 'pull_request', themeTouched: false, request: '', map: null }
    assert.equal(typeof changes.planChange, 'function')
    const plan = createPlan(root, { ...options, chromium: true })
    assert.deepEqual(plan.ci.change, changes.planChange(root, options))
    assert.deepEqual(plan.ci.unit, unitPlan(root, options))
    for (const step of plan.steps.filter(step => step.status === 'run')) {
      assert.ok(!(step.command === 'node' && step.args.includes('script/ui-system-run.mjs')) || step.args.some(arg => arg.endsWith('.spec.ts')), 'a browser command always names specs')
      assert.ok(!step.args.includes('vitest') || step.args.includes('related'), 'only related UI unit tests run')
      assert.notDeepEqual(step.args, ['--filter', '@harnessdesk/ui', 'run', 'test'])
    }
  })
}

test('every command in CI Gates has a table entry or a reasoned omission', async () => {
  const { GATES, LEFT_TO_CI, workflowJob } = await api()
  const yaml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
  const commands = ciCommands(workflowJob(yaml, 'gates'))
  assert.ok(commands.length >= 19, 'the entire Gates job was read')
  for (const { command, args } of commands) {
    const line = [command, ...args].join(' ')
    assert.ok(GATES.some(gate => [gate.command, ...gate.args].join(' ') === line) || LEFT_TO_CI[line], `unmapped CI gate: ${line}`)
  }
  for (const reason of Object.values(LEFT_TO_CI)) assert.ok(reason.length > 20)
})

test('suite-only planning needs neither dependencies nor a build', async () => {
  await fixture(async directory => {
    const { createPlan } = await api()
    const plan = createPlan(directory, { paths: ['e2e/ui-system/row-box.spec.ts'], chromium: true })
    assert.deepEqual(JSON.parse(plan.ci.change.browser_specs), ['e2e/ui-system/row-box.spec.ts'])
    assert.equal(plan.ci.unit.mode, 'none')
    assert.equal(plan.ci.change.matrix, 'full')
    const run = plan.steps.filter(step => step.status === 'run')
    assert.ok(run.some(step => step.args.includes('script/ui-system-run.mjs')))
    // Planning needs no build; running the specs does, because they import compiled host fixtures and CI builds first.
    assert.ok(run.every(step => !step.args.some(arg => /typecheck|dist\//.test(arg))))
    assert.deepEqual(run.find(step => step.args.includes('script/ui-system-run.mjs')).needs, ['Node build'])
    assert.ok(run.some(step => step.name === 'Node build'))
    assert.ok(run.filter(step => step.command === 'node').every(step => /(?:check-(?:secrets|doc-paths)|ui-system-run)\.mjs/.test(step.args[0])))
    assert.equal(existsSync(join(directory, 'node_modules')), false)
    assert.equal(existsSync(join(directory, 'packages/server/dist')), false)
  })
})

test('the suite-only --plan CLI starts from a script-only copy without dependencies', async () => {
  await fixture(async (directory, put) => {
    const scripts = mkdtempSync(join(tmpdir(), 'check-push-scripts-'))
    try {
      cpSync(join(root, 'script'), join(scripts, 'script'), { recursive: true })
      put('e2e/ui-system/row-box.spec.ts', 'export const changed = true\n')
      const result = spawnSync(process.execPath, [realpathSync(join(scripts, 'script/check-push.mjs')), '--plan'], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, UI_IMPACT_MAP: '', UI_SYSTEM_MATRIX_REQUEST: '' },
      })
      assert.equal(result.status, 0, result.stderr)
      const plan = JSON.parse(result.stdout)
      assert.deepEqual(Object.keys(plan).sort(), ['base', 'ci', 'mergeBase', 'notes', 'paths', 'steps'])
      assert.deepEqual(JSON.parse(plan.ci.change.browser_specs), ['e2e/ui-system/row-box.spec.ts'])
      assert.equal(plan.ci.unit.mode, 'none')
      assert.equal(existsSync(join(scripts, 'node_modules')), false)
      assert.equal(existsSync(join(directory, 'node_modules')), false)
      assert.equal(existsSync(join(directory, 'packages/server/dist')), false)
    } finally {
      rmSync(scripts, { recursive: true, force: true })
    }
  })
})

test('a shared input still gets the cheap checks that read it, and the notes say what only CI does', async () => {
  const { createPlan } = await api()
  for (const path of ['package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml']) {
    const plan = createPlan(root, { paths: [path], chromium: true })
    assert.match(plan.notes.join(' '), /Shared inputs changed .*CI installs and exercises the full graph/)
    const run = plan.steps.filter(step => step.status === 'run')
    assert.ok(run.some(step => step.args[0] === 'script/check-secrets.mjs'), path)
    assert.ok(run.some(step => step.args[0] === 'script/check-doc-paths.mjs'), path)
    assert.ok(run.every(step => !step.args.some(arg => /vitest|typecheck|test:ui-system/.test(arg))), 'nothing heavy runs for a shared input')
  }
  // The workflow is read by the planner tests and by the drift gate.
  const workflow = createPlan(root, { paths: ['.github/workflows/ci.yml'], chromium: true })
  assert.ok(workflow.steps.some(step => step.status === 'run' && step.args[0] === 'script/check-verify-drift.mjs'))
  const tests = workflow.steps.find(step => step.name === 'Script tests')
  assert.equal(tests.status, 'run')
  for (const name of ['ci-browser-shards', 'ci-changes', 'ci-browser-plan']) assert.ok(tests.args.includes(`script/${name}.test.mjs`), name)
})

test('an empty change runs nothing and says so', async () => {
  const { createPlan } = await api()
  const plan = createPlan(root, { paths: [], chromium: true })
  assert.ok(plan.steps.every(step => step.status === 'skipped' && /No changed files/.test(step.reason)))
})

test('merge-base selection includes committed, staged, unstaged, untracked and both rename paths', async () => {
  await fixture(async (directory, put, git) => {
    const { readChange } = await api()
    const base = git('rev-parse', 'HEAD')
    put('docs/committed.md', 'Committed\n')
    git('add', '.')
    git('commit', '-qm', 'Fixture branch change')
    // Main moves independently; the branch still answers to the common ancestor.
    git('checkout', '-qb', 'other', base)
    put('docs/main.md', 'Main\n')
    git('add', '.')
    git('commit', '-qm', 'Fixture main change')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('checkout', '-q', 'main')
    git('mv', 'docs/guide.md', 'docs/moved guide.md')
    put('docs/staged.md', 'Staged\n')
    git('add', 'docs/staged.md')
    put('packages/protocol/src/index.ts', 'export const value = 2\n')
    put('docs/untracked.md', 'Untracked\n')
    const change = readChange(directory)
    assert.equal(change.mergeBase, base)
    assert.deepEqual(change.paths, ['docs/committed.md', 'docs/guide.md', 'docs/moved guide.md', 'docs/staged.md', 'docs/untracked.md', 'packages/protocol/src/index.ts'])
    assert.equal(readChange(directory, 'HEAD').paths.includes('docs/committed.md'), false)
    // The base moved by one commit, and four paths are not committed: the result says both.
    assert.equal(change.behind, 1)
    assert.deepEqual(change.dirty.sort(), ['docs/moved guide.md', 'docs/staged.md', 'docs/untracked.md', 'docs/guide.md', 'packages/protocol/src/index.ts'].sort())
  })
})

test('the notes say what the answer is about: the files, not the commit, and the merge base, not the merge', async () => {
  const { createPlan } = await api()
  const quiet = createPlan(root, { paths: ['docs/guide.md'], chromium: true })
  assert.deepEqual(quiet.notes, ['Checked against the merge base. CI checks your branch merged into the base as it is then.'])
  const dirty = createPlan(root, { paths: ['docs/guide.md'], chromium: true, behind: 3, dirty: ['docs/guide.md', 'a.md', 'b.md', 'c.md'], base: 'origin/main' })
  assert.match(dirty.notes[0], /4 paths are not committed \(docs\/guide\.md, a\.md, b\.md, …\): these checks read your files, which are not what a push sends/)
  assert.match(dirty.notes[1], /origin\/main has 3 newer commits\. CI checks your branch merged into the base as it is then: merge it in to see the same tree\./)
  const spec = createPlan(root, { paths: ['e2e/ui-system/row-box.spec.ts'], chromium: true })
  assert.ok(spec.notes.some(note => /one worker at a time here; CI runs two in parallel/.test(note)))
})

test('--plan and --dry-run return the documented JSON without running checks', async () => {
  await fixture(async (directory, put) => {
    await api()
    put('script/check-secrets.mjs', 'throw new Error("must not run")\n')
    for (const flag of ['--plan', '--dry-run']) {
      const result = cli(directory, [flag])
      assert.equal(result.status, 0, result.stderr)
      const plan = JSON.parse(result.stdout)
      assert.deepEqual(Object.keys(plan).sort(), ['base', 'ci', 'mergeBase', 'notes', 'paths', 'steps'])
      assert.equal(plan.base, 'origin/main')
      assert.match(plan.mergeBase, /^[a-f0-9]{40}$/)
      for (const step of plan.steps) {
        assert.equal(typeof step.name, 'string')
        assert.ok(['run', 'skipped'].includes(step.status))
        assert.ok(step.status === 'skipped' ? typeof step.reason === 'string' : Array.isArray(step.args))
      }
    }
  })
})

test('usage errors and an unreadable base exit 2 with a clear message', async () => {
  await fixture(async directory => {
    await api()
    for (const args of [['--unknown'], ['--base'], ['--map']]) {
      const result = cli(directory, args)
      assert.equal(result.status, 2, result.stderr)
      assert.match(result.stderr, /usage|requires/i)
    }
    const result = cli(directory, ['--plan', '--base', 'missing-ref'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /missing-ref.*cannot|cannot.*missing-ref|unreadable.*missing-ref/i)
    assert.doesNotMatch(result.stderr, /fetching|https?:\/\//)
  })
})

test('execution exits 0 for passing steps and 1 for failures, reporting elapsed time', async () => {
  await fixture(async (directory, put) => {
    await api()
    put('docs/guide.md', 'Updated\n')
    const pass = cli(directory, ['--fast'])
    assert.equal(pass.status, 0, pass.stderr)
    assert.match(pass.stdout, /seconds/)
    put('script/sample.mjs', '')
    put('script/sample.test.mjs', "import { test } from 'node:test'\ntest('failure', () => { throw new Error('fixture failure') })\n")
    const fail = cli(directory, ['--fast'])
    assert.equal(fail.status, 1, fail.stderr)
    assert.match(fail.stdout, /failed/)
    assert.match(fail.stdout, /node --test .*script\/sample\.test\.mjs/)
  })
})

test('a UI component selects the exact related-unit command and transitive inputs select typecheck', async () => {
  await fixture(async directory => {
    const { createPlan } = await api()
    const paths = ['packages/ui/src/components/BringHome.tsx']
    const plan = createPlan(directory, { paths, chromium: true })
    assert.deepEqual(plan.steps.find(step => step.name === 'UI unit tests').args,
      ['--filter', '@harnessdesk/ui', 'exec', 'vitest', 'related', '--run', ...unitPlan(directory, { event: 'pull_request', paths }).files])
    assert.equal(plan.steps.find(step => step.name === 'UI typecheck').status, 'run')
    assert.equal(plan.ci.change.browser_specs, 'all', 'UI changes without a map remain broad')
    assert.equal(plan.steps.find(step => step.name === 'Browser specs').status, 'skipped')
    const dependency = createPlan(directory, { paths: ['packages/protocol/src/index.ts'], chromium: true })
    assert.equal(dependency.steps.find(step => step.name === 'UI typecheck').status, 'run')
    assert.equal(dependency.ci.unit.mode, 'all')
    assert.match(dependency.steps.find(step => step.name === 'UI unit tests').reason, /CI will run.*full unit suite/)
  })
})

test('Node package selection excludes CI end-to-end files and runs dependants only within 60 total tests', async () => {
  await fixture(async (directory, put) => {
    const { createPlan } = await api()
    const source = createPlan(directory, { paths: ['packages/server/src/index.ts'], chromium: true })
    const tests = source.steps.find(step => step.name === 'Node tests: server')
    assert.equal(source.steps.find(step => step.name === 'Node build').status, 'run')
    assert.deepEqual(tests.args, ['--test', '--test-timeout=120000', 'packages/server/dist/test/host.test.js'])
    assert.deepEqual(tests.needs, ['Node build'])
    const small = createPlan(directory, { paths: ['packages/protocol/src/index.ts'], chromium: true })
    assert.equal(small.steps.find(step => step.name === 'Node tests: server').status, 'run')
    for (let index = 0; index < 60; index++) put(`packages/server/test/added-${index}.test.ts`, '')
    const large = createPlan(directory, { paths: ['packages/protocol/src/index.ts'], chromium: true })
    assert.equal(large.steps.find(step => step.name === 'Node tests: protocol').status, 'run')
    assert.match(large.steps.find(step => step.name === 'Node tests: server').reason, /62 test files across changed packages and dependants/)
    assert.equal(createPlan(directory, { paths: ['docs/guide.md'] }).steps.find(step => step.name === 'Node build').status, 'skipped')
  })
})

test('browser selection observes both limits and always retains directly edited specs', async () => {
  await fixture(async (directory, put) => {
    const { createPlan } = await api()
    put('e2e/ui-system/helper.ts', 'export const value = 1\n')
    put('e2e/ui-system/row-box.spec.ts', "import { value } from './helper'\n")
    put('e2e/ui-system/second.spec.ts', "import { value } from './helper'\n")
    put('e2e/ui-system/durations.json', '{"row-box.spec.ts":300,"second.spec.ts":300}')
    const select = paths => createPlan(directory, { paths, chromium: true })
    const bounded = select(['e2e/ui-system/helper.ts'])
    assert.deepEqual(bounded.steps.find(step => step.name === 'Browser specs').args, ['script/ui-system-run.mjs', 'e2e/ui-system/row-box.spec.ts', 'e2e/ui-system/second.spec.ts'])
    assert.deepEqual(bounded.steps.find(step => step.name === 'Browser specs').env, { UI_SYSTEM_MATRIX: 'full', PLAYWRIGHT_UI_SYSTEM_WORKERS: '1' })
    put('e2e/ui-system/durations.json', '{"row-box.spec.ts":300,"second.spec.ts":301}')
    const costly = select(['e2e/ui-system/helper.ts', 'e2e/ui-system/row-box.spec.ts'])
    assert.deepEqual(costly.steps.find(step => step.name === 'Browser specs').args, ['script/ui-system-run.mjs', 'e2e/ui-system/row-box.spec.ts'])
    assert.match(costly.steps.find(step => step.name === 'Remaining browser specs').reason, /601 recorded seconds/)
    const seconds = { 'row-box.spec.ts': 1, 'second.spec.ts': 1 }
    for (let index = 0; index < 5; index++) {
      put(`e2e/ui-system/added-${index}.spec.ts`, "import { value } from './helper'\n")
      seconds[`added-${index}.spec.ts`] = 1
    }
    put('e2e/ui-system/durations.json', JSON.stringify(seconds))
    const many = select(['e2e/ui-system/helper.ts', 'e2e/ui-system/row-box.spec.ts'])
    assert.deepEqual(many.steps.find(step => step.name === 'Browser specs').args, ['script/ui-system-run.mjs', 'e2e/ui-system/row-box.spec.ts'])
    assert.match(many.steps.find(step => step.name === 'Remaining browser specs').reason, /7 reached specs/)
    const missing = createPlan(directory, { paths: ['e2e/ui-system/row-box.spec.ts'], chromium: false })
    assert.match(missing.steps.find(step => step.name === 'Browser specs').reason, /Chromium is not installed/)
  })
})

test('impact-map planning shares CI selection and uses the merge base for freshness', async () => {
  await fixture(async (directory, put, git) => {
    const { createPlan } = await api()
    const base = git('rev-parse', 'HEAD')
    const component = 'packages/ui/src/components/BringHome.tsx'
    const record = spec => ({ [spec]: { tests: 1, unclean: 0, loaded: ['/src/components/BringHome.tsx'], ran: spec === 'row-box.spec.ts' ? ['/src/components/BringHome.tsx'] : [] } })
    const map = mergeRecords(directory, [record('row-box.spec.ts'), record('server.spec.ts')], {
      commit: base, expected: { 'row-box.spec.ts': 1, 'server.spec.ts': 1 }, environment: environmentAt(directory, base),
    })
    put('impact-map.json', JSON.stringify(map))
    put(component, 'export const BringHome = () => 1\n')
    git('add', component)
    git('commit', '-qm', 'Fixture first UI change')
    put('docs/guide.md', 'A second commit\n')
    git('add', 'docs/guide.md')
    git('commit', '-qm', 'Fixture second change')
    const plan = createPlan(directory, { paths: [component], mergeBase: base, map: readMap(join(directory, 'impact-map.json')), chromium: true })
    assert.deepEqual(plan.ci.change, changes.planChange(directory, { event: 'pull_request', paths: [component], baseRevision: base, map }))
    assert.deepEqual(plan.steps.find(step => step.name === 'Browser specs').args, ['script/ui-system-run.mjs', 'e2e/ui-system/row-box.spec.ts'])
    assert.equal(plan.ci.change.matrix, 'pr')
    assert.equal(changes.planChange(directory, { event: 'pull_request', paths: [component], map }).browser_specs, 'all', 'HEAD^1 is deliberately not the merge base')
    const flag = cli(directory, ['--plan', '--map', 'impact-map.json'])
    assert.equal(flag.status, 0, flag.stderr)
    assert.deepEqual(JSON.parse(flag.stdout).ci.change, plan.ci.change)
    const env = spawnSync(process.execPath, [script, '--plan'], { cwd: directory, encoding: 'utf8', env: { ...process.env, UI_IMPACT_MAP: 'impact-map.json' } })
    assert.equal(env.status, 0, env.stderr)
    assert.deepEqual(JSON.parse(env.stdout).ci.change, plan.ci.change)
  })
})

test('--fast skips only Node-package tests and browser specs from the ordinary selection', async () => {
  await fixture(async directory => {
    const { createPlan } = await api()
    const plan = createPlan(directory, { paths: ['packages/protocol/src/index.ts', 'e2e/ui-system/row-box.spec.ts'], fast: true, chromium: true })
    assert.equal(plan.steps.find(step => step.name === 'UI typecheck').status, 'run')
    assert.equal(plan.steps.find(step => step.name === 'Node build').status, 'run', 'the typecheck reads the build, so --fast keeps it')
    assert.match(plan.steps.find(step => step.name === 'Node tests: protocol').reason, /--fast/)
    assert.match(plan.steps.find(step => step.name === 'Browser specs').reason, /--fast/)
  })
})

test('planner dependencies select planner tests, alongside changed scripts and their own tests', async () => {
  const { createPlan } = await api()
  const plan = createPlan(root, { paths: ['script/ci-browser-shards.mjs', 'script/check-push.test.mjs', 'script/check-layering.mjs'], fast: true })
  assert.deepEqual(plan.steps.find(step => step.name === 'Script tests').args, ['--test',
    'script/check-layering.test.mjs', 'script/check-push.test.mjs', 'script/ci-browser-plan.test.mjs',
    'script/ci-browser-shards.test.mjs', 'script/ci-changes.test.mjs', 'script/ci-imports.test.mjs', 'script/ci-planners.test.mjs', 'script/ci-unit-tests.test.mjs', 'script/gates.test.mjs', 'script/ui-impact.test.mjs'])
})

test('gates see untracked additions without changing the real index', async () => {
  await fixture(async (directory, put) => {
    await api()
    const before = readFileSync(join(directory, '.git/index'))
    put('docs/untracked.md', 'New guide\n')
    put('script/check-doc-paths.mjs', "import { execFileSync } from 'node:child_process'\nif (!execFileSync('git', ['ls-files'], { encoding: 'utf8' }).includes('docs/untracked.md')) process.exit(1)\n")
    const result = cli(directory, ['--fast'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(join(directory, '.git/index')), before)
  })
})

test('Chromium detection checks the installed version without loading the browser runtime', async () => {
  await fixture(async (directory, put) => {
    const { chromiumInstalled } = await api()
    assert.equal(chromiumInstalled(directory), false)
    put('package.json', '{}')
    put('node_modules/@playwright/test/package.json', '{}')
    put('node_modules/playwright/package.json', '{}')
    put('node_modules/playwright-core/package.json', '{}')
    put('node_modules/playwright-core/browsers.json', '{"browsers":[{"name":"chromium","revision":"100"},{"name":"chromium-headless-shell","revision":"200"}]}')
    const env = { PLAYWRIGHT_BROWSERS_PATH: 'browser-cache' }
    put('browser-cache/chromium-99/chrome', '')
    assert.equal(chromiumInstalled(directory, env), false)
    put('browser-cache/chromium-100/Browser for Testing.app/Contents/MacOS/Browser for Testing', '')
    put('browser-cache/chromium_headless_shell-200/headless_shell', '')
    assert.equal(chromiumInstalled(directory, env), true)
  })
})

const executePlan = (directory, plan) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { runPlan } from ${JSON.stringify(new URL('./check-push.mjs', import.meta.url).href)}\nprocess.exitCode = await runPlan(process.cwd(), ${JSON.stringify(plan)})`,
], { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } })

test('independent gates run concurrently with at most four active processes', async () => {
  await fixture(async (directory, put) => {
    await api()
    put('script/wait.mjs', "import { appendFileSync } from 'node:fs'\nappendFileSync('events.jsonl', JSON.stringify({ event: 'start' }) + '\\n')\nsetTimeout(() => appendFileSync('events.jsonl', JSON.stringify({ event: 'end' }) + '\\n'), 150)\n")
    const steps = Array.from({ length: 6 }, (_, index) => ({ name: `gate ${index}`, command: 'node', args: ['script/wait.mjs'], status: 'run', group: 'gate' }))
    const result = executePlan(directory, { steps })
    assert.equal(result.status, 0, result.stderr)
    let active = 0
    let most = 0
    for (const line of readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n')) {
      active += JSON.parse(line).event === 'start' ? 1 : -1
      most = Math.max(most, active)
    }
    assert.equal(active, 0)
    assert.ok(most > 1 && most <= 4, `observed ${most} concurrent gates`)
  })
})

test('a failed build prevents consumers from reading old output, and other steps still run', async () => {
  await fixture(async (directory, put) => {
    await api()
    put('script/build.mjs', 'process.exit(1)\n')
    put('script/consumer.mjs', "import { writeFileSync } from 'node:fs'\nwriteFileSync('consumer-ran', '')\n")
    put('script/independent.mjs', "import { writeFileSync } from 'node:fs'\nwriteFileSync('independent-ran', '')\n")
    const result = executePlan(directory, { steps: [
      { name: 'Node build', command: 'node', args: ['script/build.mjs'], status: 'run' },
      { name: 'Node tests', command: 'node', args: ['script/consumer.mjs'], status: 'run', needs: ['Node build'] },
      { name: 'Independent check', command: 'node', args: ['script/independent.mjs'], status: 'run' },
    ] })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(existsSync(join(directory, 'consumer-ran')), false)
    assert.equal(existsSync(join(directory, 'independent-ran')), true)
    assert.match(result.stdout, /output cannot be trusted/)
  })
})

test('a missing command fails the step rather than silently succeeding', async () => {
  await fixture(async directory => {
    await api()
    const result = executePlan(directory, { steps: [{ name: 'Missing command', command: 'no-such-check-push-command', args: [], status: 'run' }] })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /failed/)
    assert.match(result.stderr, /ENOENT/)
  })
})

test('the UI typecheck and the related unit tests read workspace build output, so they run after the build', async () => {
  const { createPlan } = await api()
  const plan = createPlan(root, { paths: ['packages/ui/src/components/BringHome.tsx'], chromium: true })
  const step = name => plan.steps.find(step => step.name === name)
  assert.equal(step('UI typecheck').status, 'run')
  assert.deepEqual(step('UI typecheck').needs, ['Node build'])
  assert.equal(step('Node build').status, 'run')
  assert.deepEqual(step('UI unit tests').needs, ['Node build'])
  assert.equal(plan.ci.unit.mode, 'related')
})

test('a test that names a changed input is run with it, even when it is not the changed script\'s own', async () => {
  const { createPlan } = await api()
  const tests = paths => createPlan(root, { paths, chromium: true }).steps.find(step => step.name === 'Script tests')
  // `gates.test.mjs` holds the tests of the gate library and of the parsers of several gates.
  assert.ok(tests(['script/lib/steps.mjs']).args.includes('script/gates.test.mjs'))
  assert.ok(tests(['script/check-reachable.mjs']).args.includes('script/gates.test.mjs'))
  assert.ok(tests(['package.json']).args.includes('script/gates.test.mjs'))
  // The workflow is read by the check's own table-of-gates test as well as the planner tests.
  assert.ok(tests(['.github/workflows/ci.yml']).args.includes('script/check-push.test.mjs'))
  assert.equal(tests(['docs/architecture.md']).status, 'skipped')
})

test('a gate row names every data file its script reads from the repository', async () => {
  const { GATES } = await api()
  const missing = []
  for (const row of GATES) {
    const text = [row.args[0], ...[...readFileSync(join(root, row.args[0]), 'utf8').matchAll(/['"`](script\/[\w.-]+\.mjs)['"`]/g)].map(match => match[1])]
      .map(file => readFileSync(join(root, file), 'utf8')).join('\n')
    for (const [, file] of text.matchAll(/['"`]((?:packages|script|e2e|licenses)\/[\w./-]+\.(?:json|css|txt))['"`]/g)) {
      if (/\$\{/.test(file) || !existsSync(join(root, file))) continue
      if (!row.paths.some(pattern => pattern.test(file))) missing.push(`${row.name}: ${file}`)
    }
  }
  assert.deepEqual(missing, [], 'a data file a gate reads must be a path that makes it run')
})

test('gates read working files, never bytes from the temporary index', async () => {
  const { GATES } = await api()
  const seen = new Set()
  const visit = file => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    // ls-files --cached enumerates names; other cached commands read index content.
    assert.doesNotMatch(text.replace(/['"]ls-files['"]\s*,\s*['"]--cached['"]/g, ''), /['"](?:cat-file|--cached)['"]|['"]show['"]\s*,\s*['"]:/, file)
    for (const [, specifier] of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"\n]+\.mjs)['"]/g)) visit(join(dirname(file), specifier))
  }
  for (const row of GATES) visit(join(root, row.args[0]))
})

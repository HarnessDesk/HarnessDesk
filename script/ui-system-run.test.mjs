import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const api = () => import('./ui-system-run.mjs')
const fixture = async run => {
  const root = mkdtempSync(join(tmpdir(), 'ui-system-run-'))
  const put = (path, content = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  try {
    put('e2e/ui-system/plain.spec.ts', "await page.goto('/preview.html')")
    put('e2e/ui-system/dev.spec.ts', "await import('/src/helper.ts')")
    await run(root, put)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const specs = ['e2e/ui-system/dev.spec.ts', 'e2e/ui-system/plain.spec.ts']

test('plans static first, then dev, forwarding arguments and preserving both reports', async () => {
  const { planRun } = await api()
  await fixture(root => {
    const plan = planRun(root, { specs, args: ['--grep', 'one title'], hasBuild: true, env: { UI_SYSTEM_PAGES: 'prebuilt' } })
    assert.deepEqual(plan.groups.map(group => [group.server, group.args]), [
      ['static', ['test:ui-system', specs[1], '--pass-with-no-tests', '--grep', 'one title']],
      ['dev', ['test:ui-system', specs[0], '--pass-with-no-tests', '--grep', 'one title']],
    ])
    assert.deepEqual(plan.groups.map(group => group.env), [
      { UI_SYSTEM_SERVER: 'static', UI_SYSTEM_REPORT_GROUP: 'static' },
      { UI_SYSTEM_SERVER: 'dev', UI_SYSTEM_REPORT_GROUP: 'dev' },
    ])
    assert.deepEqual(plan.build, [])
  })
})

test('only an explicit prebuilt signal trusts an artifact; local runs and CI emulation rebuild', async () => {
  const { hasE2EBuild, planRun, runPlan } = await api()
  await fixture(async (root, put) => {
    const plan = planRun(root, { specs, env: {} })
    assert.deepEqual(plan.build, [['run', 'build:node'], ['run', 'build:e2e']])
    assert.equal(plan.error, null)
    // A build that is already there is not trusted locally: it may predate the edit under test.
    assert.deepEqual(planRun(root, { specs, hasBuild: true, env: {} }).build, plan.build)
    assert.deepEqual(planRun(root, { specs, hasBuild: true, env: { CI: 'true' } }).build, plan.build)
    assert.deepEqual(planRun(root, { specs: [specs[0]], env: {} }).build, [], 'a dev-only run builds nothing')
    assert.match(planRun(root, { specs, env: { UI_SYSTEM_PAGES: 'prebuilt' } }).error, /artifact.*build:e2e/)
    const calls = []
    assert.equal(await runPlan(root, plan, {
      execute: async (args, _env, options) => {
        if (options?.capture) return { code: 0, stdout: 'Total: 1 test in 1 file' }
        calls.push(args)
        return 0
      },
      log() {},
    }), 0)
    assert.deepEqual(calls.slice(0, 2), plan.build)
    assert.deepEqual(calls.slice(2), plan.groups.map(group => group.args))
    put('packages/ui/dist-e2e/preview.html')
    assert.equal(hasE2EBuild(root), false, 'a partial artifact is not a build')
    put('packages/ui/dist-e2e/design.html')
    put('packages/ui/dist-e2e/narrow-overlay.html')
    assert.equal(hasE2EBuild(root), false, 'the embedded Seat page is required too')
    put('packages/ui/dist-e2e/src/preview/tile-page.html')
    assert.equal(hasE2EBuild(root), true)
    const ci = planRun(root, { specs, env: { UI_SYSTEM_PAGES: 'prebuilt' } })
    assert.deepEqual(ci.build, [], 'CI never builds in a shard')
    assert.equal(ci.error, null)
  })
})

test('dev-only and recording each stay one dev run without a static build', async () => {
  const { planRun } = await api()
  await fixture(root => {
    for (const options of [{ devOnly: true }, { env: { RECORD: 'true' } }, { env: { UI_IMPACT_DIR: 'output/ui-impact' } }, { args: ['--tsconfig', 'script/ui-impact/tsconfig.json'] }]) {
      const plan = planRun(root, { specs, env: {}, ...options })
      assert.deepEqual(plan.build, [])
      assert.equal(plan.groups.length, 1)
      assert.equal(plan.groups[0].server, 'dev')
      assert.ok(specs.every(spec => plan.groups[0].args.includes(spec)))
      if (options.env) assert.deepEqual(plan.groups[0].args.slice(-2), ['--tsconfig', 'script/ui-impact/tsconfig.json'])
    }
  })
})

test('the runner lists commands without executing or building anything', async () => {
  const cli = fileURLToPath(new URL('./ui-system-run.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, '--list', 'conversation-map.spec.ts', 'detail-head.spec.ts', '--grep', 'title'], {
    encoding: 'utf8', env: { ...process.env, CI: '', RECORD: '', UI_IMPACT_DIR: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.deepEqual(plan.groups.map(group => group.server), ['static', 'dev'])
  assert.ok(plan.groups.every(group => group.args.slice(-2).join(' ') === '--grep title'))
  const grep = spawnSync(process.execPath, [cli, '--list', 'conversation-map.spec.ts', '--grep', 'detail-head.spec.ts'], {
    encoding: 'utf8', env: { ...process.env, CI: '', RECORD: '', UI_IMPACT_DIR: '' },
  })
  assert.equal(grep.status, 0, grep.stderr)
  const filtered = JSON.parse(grep.stdout)
  assert.deepEqual(filtered.split, { static: ['conversation-map.spec.ts'], dev: [] })
  assert.deepEqual(filtered.groups[0].args.slice(-2), ['--grep', 'detail-head.spec.ts'])
})

test('both groups run after a failure, with a combined nonzero status and timings', async () => {
  const { planRun, runPlan } = await api()
  await fixture(async root => {
    for (const failures of [[1, 0], [0, 1], [0, 0]]) {
      const calls = [], logs = []
      const plan = planRun(root, { specs, hasBuild: true, env: { UI_SYSTEM_PAGES: 'prebuilt' } })
      const code = await runPlan(root, plan, {
        execute: async (args, env, options) => {
          if (options?.capture) return { code: 0, stdout: 'Total: 1 test in 1 file' }
          calls.push({ args, env })
          return failures[calls.length - 1]
        },
        log: message => logs.push(message),
      })
      assert.equal(code, failures.some(Boolean) ? 1 : 0)
      assert.equal(calls.length, 2)
      assert.match(logs[0], /1 static, 1 dev/)
      for (const server of ['static', 'dev']) assert.ok(logs.some(line => new RegExp(`${server}: .*s`).test(line)))
    }
  })
})

test('failed builds and missing CI artifacts fail static in the open but still run dev', async () => {
  const { planRun, runPlan } = await api()
  await fixture(async root => {
    for (const env of [{}, { UI_SYSTEM_PAGES: 'prebuilt' }]) {
      const calls = []
      const code = await runPlan(root, planRun(root, { specs, env }), {
        execute: async (args, env, options) => {
          if (options?.capture) return { code: 0, stdout: 'Total: 1 test in 1 file' }
          calls.push({ args, env })
          return args[0] === 'run' ? 1 : 0
        },
        log() {},
      })
      assert.equal(code, 1)
      assert.equal(calls.filter(call => call.args[0] === 'test:ui-system').length, 1)
      assert.equal(calls.at(-1).env.UI_SYSTEM_SERVER, 'dev')
    }
  })
})

test('the browser config keeps dev as the default and serves the build only when requested', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const load = env => spawnSync(process.execPath, ['--input-type=module', '-e',
    "import config from './playwright.ui-system.config.ts'; console.log(JSON.stringify({ webServer: config.webServer, outputDir: config.outputDir, reporter: config.reporter }))",
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, UI_SYSTEM_SERVER: '', UI_SYSTEM_REPORT_GROUP: '', ...env } })
  const dev = load({ PLAYWRIGHT_UI_SYSTEM_PORT: '5899' })
  assert.equal(dev.status, 0, dev.stderr)
  assert.match(JSON.parse(dev.stdout).webServer.command, /exec vite --host 127.0.0.1 --port 5899$/)
  const built = load({ UI_SYSTEM_SERVER: 'static', UI_SYSTEM_REPORT_GROUP: 'static', PLAYWRIGHT_UI_SYSTEM_PORT: '5899' })
  // A clean checkout must fail clearly; after a build the same config must use preview.
  if (built.status !== 0) assert.match(built.stderr, /pnpm run build:node.*pnpm run build:e2e/)
  else {
    const config = JSON.parse(built.stdout)
    assert.match(config.webServer.command, /vite preview --outDir dist-e2e --host 127.0.0.1 --port 5899 --strictPort$/)
    assert.equal(config.webServer.url, 'http://127.0.0.1:5899/design.html?view=propagation')
    assert.match(config.outputDir, /static\/results$/)
    assert.match(config.reporter[1][1].outputFolder, /static\/report$/)
  }
  const vite = readFileSync(join(root, 'packages/ui/vite.e2e.config.ts'), 'utf8')
  assert.match(vite, /import .* from '.\/vite.config.ts'/)
  assert.match(vite, /process\.env\.NODE_ENV\s*=\s*'development'/)
  assert.match(vite, /^ {2}mode: 'development',$/m, 'Vite mode is separate from NODE_ENV: import.meta.env.MODE follows it')
  assert.match(vite, /E2E_PAGES/)
  assert.match(vite, /outDir: 'dist-e2e'/)
})


for (const [title, files, counts, exits, expected] of [
  ['one group keeps failing when its filter matches nothing', [specs[1]], [0], [1], 1],
  ['two groups allow a filter that matches only the static group', specs, [1, 0], [0, 0], 0],
  ['two groups allow a filter that matches only the dev group', specs, [0, 1], [0, 0], 0],
  ['two groups still fail when no test matches anywhere', specs, [0, 0], [0, 0], 1],
]) {
  test(title, async () => {
    const { planRun, runPlan } = await api()
    await fixture(async root => {
      const plan = planRun(root, { specs: files, args: ['--grep', 'only one title'], env: { UI_SYSTEM_PAGES: 'prebuilt' }, hasBuild: true })
      const calls = [], listings = []
      const code = await runPlan(root, plan, {
        execute: async (args, env, options) => {
          if (options?.capture) {
            listings.push({ args, env })
            return { code: 0, stdout: `Total: ${counts[listings.length - 1]} tests in 1 file` }
          }
          calls.push({ args, env })
          return exits[calls.length - 1]
        },
        log() {},
      })
      assert.equal(code, expected)
      assert.equal(calls.length, files.length === 1 ? 1 : 2)
      assert.equal(listings.length, files.length === 1 ? 1 : 2)
      for (const call of calls) assert.equal(call.args.includes('--pass-with-no-tests'), files.length > 1)
      for (const listing of listings) {
        assert.ok(listing.args.includes('--list'))
        assert.ok(listing.args.includes('--reporter=list'))
        assert.ok(listing.args.includes('--grep'))
      }
    })
  })
}

test('selection is listed per group so independent shards cannot both run no tests', async () => {
  const { planRun, runPlan } = await api()
  await fixture(async root => {
    const plan = planRun(root, { specs, args: ['--shard=2/2'], env: { UI_SYSTEM_PAGES: 'prebuilt' }, hasBuild: true })
    const listed = []
    assert.equal(await runPlan(root, plan, {
      execute: async (args, env, options) => {
        if (options?.capture) {
          listed.push(env.UI_SYSTEM_SERVER)
          assert.equal(args.filter(arg => arg.endsWith('.spec.ts')).length, 1)
          assert.ok(args.includes('--shard=2/2'))
          return { code: 0, stdout: 'Total: 0 tests in 0 files' }
        }
        return 0
      },
      log() {},
    }), 1)
    assert.deepEqual(listed, ['static', 'dev'])
  })
})

test('single-group shard and file filters still fail when the underlying command allows zero tests', async () => {
  const { planRun, runPlan } = await api()
  await fixture(async root => {
    for (const args of [['--shard=2/2'], ['--only-changed'], ['--test-list', 'tests.txt'], ['--test-list-invert', 'tests.txt'], ['--last-failed'], ['-G', 'every title']]) {
      const plan = planRun(root, { specs: [specs[1]], args, env: { UI_SYSTEM_PAGES: 'prebuilt' }, hasBuild: true })
      assert.equal(plan.groups[0].args.includes('--pass-with-no-tests'), false)
      assert.equal(await runPlan(root, plan, {
        execute: async (_args, _env, options) => options?.capture ? { code: 0, stdout: 'Total: 0 tests in 0 files' } : 0,
        log() {},
      }), 1)
    }
  })
})

test('failed or unreadable listings cannot turn an empty run green', async () => {
  const { planRun, runPlan } = await api()
  await fixture(async root => {
    for (const listing of [{ code: 1, stdout: '' }, { code: 0, stdout: 'unexpected output' }, { code: 0, stdout: 'Total: 99 tests in 1 file\nTotal: 0 tests in 0 files' }]) {
      assert.equal(await runPlan(root, planRun(root, { specs, env: { UI_SYSTEM_PAGES: 'prebuilt' }, hasBuild: true }), {
        execute: async (_args, _env, options) => options?.capture ? listing : 0,
        log() {},
      }), 1)
    }
  })
})

test('a spec narrowed to units runs as its file, with the units handed to it', async () => {
  const { narrowedSpecs, planRun } = await api()
  assert.deepEqual(narrowedSpecs(['e2e/ui-system/dev.spec.ts#a,b', 'e2e/ui-system/plain.spec.ts']),
    { files: ['e2e/ui-system/dev.spec.ts', 'e2e/ui-system/plain.spec.ts'], units: { 'dev.spec.ts': ['a', 'b'] } })
  assert.deepEqual(narrowedSpecs(['e2e/ui-system/dev.spec.ts#a', 'e2e/ui-system/dev.spec.ts']).units, {}, 'named whole, it runs whole')
  await fixture(async root => {
    const plan = planRun(root, { specs: ['e2e/ui-system/dev.spec.ts#a,b'], devOnly: true, env: {} })
    assert.deepEqual(plan.groups.map(group => [group.args.slice(0, 2), JSON.parse(group.env.UI_SYSTEM_UNITS)]),
      [[['test:ui-system', 'e2e/ui-system/dev.spec.ts'], { 'dev.spec.ts': ['a', 'b'] }]])
    assert.equal(planRun(root, { specs, devOnly: true, env: {} }).groups[0].env.UI_SYSTEM_UNITS, undefined)
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { tempDir } from './scratch.js'

import { CodexRuntime } from '@harnessdesk/adapter-codex'
import type { AgentRuntime, RuntimeId, RuntimeInfo, WireNotification } from '@harnessdesk/protocol'

import { Host, Logger, StateStore } from '../src/index.js'
import { UpdateChecker, isNewer, upgradeCommand } from '../src/updates.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * The update advisory: a registry dist-tag read, cached for a day, compared
 * against the running version, and never in the way.
 */

const info = (overrides: Partial<RuntimeInfo> & { version: string | null; pkg?: string }): RuntimeInfo =>
  ({
    id: 'codex',
    name: 'Codex',
    version: overrides.version,
    capabilities: {} as RuntimeInfo['capabilities'],
    presentation: {
      name: 'Codex',
      install: {
        command: 'brew install codex',
        ...(overrides.pkg ? { package: overrides.pkg } : {}),
      },
    },
  }) as RuntimeInfo

const registry = (latest: string) => {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return { ok: true, json: async () => ({ latest }) }
  }
  return { fetch, calls }
}

test('isNewer compares release triples and never trusts what it cannot parse', () => {
  assert.equal(isNewer('0.149.0', '0.135.0'), true)
  assert.equal(isNewer('0.149.0', 'codex-cli 0.135.0'), true)
  assert.equal(isNewer('0.135.0', '0.135.0'), false)
  assert.equal(isNewer('0.135.0', '0.149.0'), false)
  assert.equal(isNewer('latest', '0.1.0'), false)
  assert.equal(isNewer('1.0.0', null), false)
})

test('upgradeCommand rephrases an install as an upgrade where the tool distinguishes them', () => {
  assert.equal(upgradeCommand('brew install codex'), 'brew upgrade codex')
  assert.equal(upgradeCommand('npm i -g @openai/codex'), 'npm i -g @openai/codex@latest')
  assert.equal(upgradeCommand('npm install -g @agentclientprotocol/claude-agent-acp'), 'npm install -g @agentclientprotocol/claude-agent-acp@latest')
  assert.equal(upgradeCommand('npm i -g thing@2'), 'npm i -g thing@2')
  assert.equal(upgradeCommand('curl -fsSL https://x | sh'), 'curl -fsSL https://x | sh')
})

test('a runtime behind its package gets an advisory; one without a package gets nothing', async () => {
  const dir = tempDir('hd-updates-')
  const npm = registry('0.149.0')
  const checker = new UpdateChecker({ cachePath: join(dir, 'cache.json'), fetch: npm.fetch })

  assert.equal(await checker.updateFor(info({ version: '0.135.0' })), null)
  assert.equal(npm.calls.length, 0)

  const update = await checker.updateFor(info({ version: 'codex-cli 0.135.0', pkg: '@openai/codex' }))
  assert.equal(update?.version, '0.149.0')
  assert.equal(update?.command, 'brew upgrade codex')
  assert.equal(update?.url, undefined)
  assert.equal(npm.calls[0], 'https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags')

  // Up to date: no advisory, and the answer came from the cache.
  assert.equal(await checker.updateFor(info({ version: '0.149.0', pkg: '@openai/codex' })), null)
  assert.equal(npm.calls.length, 1)
  const cached = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8')) as Record<string, { latest: string }>
  assert.equal(cached['@openai/codex']?.latest, '0.149.0')
})

test('the cache is honoured within its ttl and refreshed after it', async () => {
  const dir = tempDir('hd-updates-')
  let clock = 1_000
  const npm = registry('0.150.0')
  const make = () =>
    new UpdateChecker({ cachePath: join(dir, 'cache.json'), fetch: npm.fetch, now: () => clock, ttlMs: 100 })
  assert.equal((await make().updateFor(info({ version: '0.1.0', pkg: 'x' })))?.version, '0.150.0')
  clock += 50
  await make().updateFor(info({ version: '0.1.0', pkg: 'x' })) // a fresh checker reads the file
  assert.equal(npm.calls.length, 1)
  clock += 100
  await make().updateFor(info({ version: '0.1.0', pkg: 'x' }))
  assert.equal(npm.calls.length, 2)
})

test('an unreachable registry is a null, not an error, and keeps the last answer', async () => {
  const dir = tempDir('hd-updates-')
  let clock = 0
  let online = true
  const fetch = async (url: string) => {
    if (!online) throw new Error(`offline: ${url}`)
    return { ok: true, json: async () => ({ latest: '2.0.0' }) }
  }
  const checker = new UpdateChecker({ cachePath: join(dir, 'cache.json'), fetch, now: () => clock, ttlMs: 10 })
  assert.equal((await checker.updateFor(info({ version: '1.0.0', pkg: 'x' })))?.version, '2.0.0')
  online = false
  clock = 100
  assert.equal((await checker.updateFor(info({ version: '1.0.0', pkg: 'x' })))?.version, '2.0.0')
  const fresh = new UpdateChecker({ cachePath: join(dir, 'nothing.json'), fetch })
  assert.equal(await fresh.updateFor(info({ version: '1.0.0', pkg: 'x' })), null)
})

/*
  The host's half: the notice shown beside a runtime is measured against the
  build that runtime is on now. "Refresh models" can move a runtime onto an
  upgrade — `checkInstallation` restarts an idle one onto the build it finds
  on disk — and a notice measured before that move is about a build that has
  gone. Seen on 2026-09-18: "Codex 0.155.0", and under it, "Codex 0.155.0 is
  available".
*/

const LATEST = '0.155.0'
const silent = new Logger('test', { level: 'error', console: false })

/** A Codex-shaped fake whose build on disk can change under it, as an upgrade does. */
const upgradable = (running: string) => {
  const runtime = new FakeRuntime({ id: 'codex' as RuntimeId, name: 'Codex' })
  const runOn = (version: string): void => {
    ;(runtime as { info: RuntimeInfo }).info = {
      ...runtime.info,
      version,
      presentation: {
        ...runtime.info.presentation,
        name: 'Codex',
        install: { command: 'npm i -g @openai/codex', package: '@openai/codex' },
      },
    }
  }
  runOn(running)
  let onDisk = running
  Object.assign(runtime, {
    // As `CodexRuntime.checkInstallation`: an idle runtime restarts onto the build it finds.
    checkInstallation: async () => {
      const from = runtime.info.version
      if (onDisk === from) return { changed: false }
      runOn(onDisk)
      return { changed: true, from, to: onDisk, restarted: true }
    },
  })
  return {
    runtime,
    install: (version: string): void => {
      onDisk = version
    },
  }
}

const deskWith = async (
  t: { after: (fn: () => Promise<void>) => void },
  runtime: AgentRuntime,
  options: {
    /** What the install service chose for the agent, when a test needs one. */
    chosen?: string
    /** The registry, when a test needs to hold its answer. */
    fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>
  } = {},
) => {
  const dir = tempDir('hd-update-host-')
  const host = new Host({
    logger: silent,
    state: new StateStore(join(dir, 'state.json')),
    catalogRefreshMs: 0,
    updates: new UpdateChecker({ cachePath: join(dir, 'update-checks.json'), fetch: options.fetch ?? registry(LATEST).fetch }),
    ...(options.chosen ? { installs: { last: () => ({ chosen: { version: options.chosen } }) } as never } : {}),
  })
  t.after(() => host.dispose())
  const pushed: WireNotification[] = []
  host.addBroadcaster((notification) => pushed.push(notification))
  host.register(runtime)
  await host.start()
  const id = runtime.info.id
  return {
    host,
    refresh: () => host.call('runtime/refreshCatalog', { runtime: id }),
    /** What a window opening now is given. */
    shown: async (): Promise<RuntimeInfo> =>
      (await host.call('host/hello', { clientVersion: 'test' })).runtimes.find((info) => info.id === id)!,
    /** What a window already open was last told. */
    told: (): RuntimeInfo | undefined => {
      const told = pushed.filter(
        (notification) => notification.method === 'runtime/infoChanged' && notification.params.runtime === id,
      )
      const last = told.at(-1)
      return last?.method === 'runtime/infoChanged' ? last.params.info : undefined
    },
  }
}

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Long enough for any second look the host takes to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('an upgrade that "Refresh models" moves a runtime onto takes the notice about it away', async (t) => {
  const { runtime, install } = upgradable('0.149.0')
  const desk = await deskWith(t, runtime)
  await until(async () => (await desk.shown()).update?.version === LATEST, 'the notice for 0.149.0')

  install(LATEST)
  await desk.refresh()
  await settle()

  const shown = await desk.shown()
  assert.equal(shown.version, LATEST)
  assert.equal(shown.update, undefined, 'a window opening now is told the build it runs is behind itself')
  assert.equal(desk.told()?.version, LATEST)
  assert.equal(desk.told()?.update, undefined, 'the open window is told the build it runs is behind itself')
})

test('a runtime moved onto a build that is still behind is told so again, about the build it is on', async (t) => {
  const { runtime, install } = upgradable('0.149.0')
  const desk = await deskWith(t, runtime)
  await until(async () => (await desk.shown()).update?.version === LATEST, 'the notice for 0.149.0')

  install('0.152.0')
  await desk.refresh()

  // The same 0.155.0, measured against 0.152.0 now — and the open window hears it.
  await until(
    () => desk.told()?.version === '0.152.0' && desk.told()?.update?.version === LATEST,
    'the notice measured against 0.152.0',
  )
  assert.equal((await desk.shown()).update?.version, LATEST)
})

test('an agent shown with the version its install chose is measured against that version', async (t) => {
  // A direct agent that calls itself 0.0.0-dev is shown with the version the
  // install service chose (#354). Measured against the placeholder instead,
  // every release is newer than it.
  const { runtime } = upgradable('0.0.0-dev')
  const desk = await deskWith(t, runtime, { chosen: LATEST })
  await settle()

  const shown = await desk.shown()
  assert.equal(shown.version, LATEST)
  assert.equal(shown.update, undefined)
})

const CODEX_FAKE = fileURLToPath(new URL('../../../adapter-codex/dist/test/fixtures/fake-codex.mjs', import.meta.url))

test('over Codex: "Refresh models" onto the release it was offered takes the notice about it away', async (t) => {
  /* The real adapter over its fake, which is the path the bug took: an idle
     Codex restarts onto the build it finds on disk — `checkInstallation`,
     which "Refresh models" runs first — and its own `info.version` moves
     under a host that measured its notice a minute before. As in the
     adapter's own test, discovery probes `--version` in this process's
     environment, so setting the variable is upgrading the binary. */
  const saved = process.env['FAKE_CODEX_VERSION']
  process.env['FAKE_CODEX_VERSION'] = '0.149.0'
  t.after(async () => {
    if (saved === undefined) delete process.env['FAKE_CODEX_VERSION']
    else process.env['FAKE_CODEX_VERSION'] = saved
  })
  const desk = await deskWith(t, new CodexRuntime({ binaryPath: CODEX_FAKE, clientName: 'harnessdesk-test' }))
  await until(async () => (await desk.shown()).update?.version === LATEST, 'the notice for 0.149.0')
  assert.equal((await desk.shown()).version, 'codex-cli 0.149.0')

  process.env['FAKE_CODEX_VERSION'] = LATEST
  await desk.refresh()
  await settle()

  const shown = await desk.shown()
  assert.equal(shown.version, `codex-cli ${LATEST}`)
  assert.equal(shown.update, undefined, 'a window opening now is told the build it runs is behind itself')
  assert.equal(desk.told()?.version, `codex-cli ${LATEST}`)
  assert.equal(desk.told()?.update, undefined, 'the open window is told the build it runs is behind itself')
})

test('a runtime registered in the place of one being measured is measured on its own account', async (t) => {
  // The registry is held, so the first runtime's measurement is still in
  // flight when the second is registered under the same id and a window opens.
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetch = async () => {
    await held
    return { ok: true, json: async () => ({ latest: LATEST }) }
  }
  const desk = await deskWith(t, upgradable('0.149.0').runtime, { fetch })
  desk.host.register(upgradable('0.150.0').runtime)
  const opening = await desk.shown()
  assert.equal(opening.version, '0.150.0')
  assert.equal(opening.update, undefined, 'nothing is known until the registry answers')

  release()
  await until(() => desk.told()?.version === '0.150.0' && desk.told()?.update?.version === LATEST, 'the second runtime\'s notice')
})

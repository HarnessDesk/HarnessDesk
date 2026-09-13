import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { AgentRegistryStore } from '../../src/agent-registry.js'
import { InstallService } from '../../src/installs/service.js'

/**
 * Which copy answers, decided from the machine. What these hold to: the
 * person's newest usable copy runs over the row's own command; the row's
 * command is the fallback when nothing installed qualifies; a pin is
 * honoured and persisted; an agent's own checks block the start in its own
 * words; and a bridge is pointed at the chosen CLI.
 */

const HOME = '/Users/x'
const STATE = '/Users/x/.harnessdesk'

const tempStore = async (t: { after(fn: () => void): void }, entries: Record<string, unknown>[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-installs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  for (const entry of entries) store.add(entry as Record<string, unknown> & { id: string })
  return store
}

/** A machine: which paths exist and what each prints for its version. */
const machine = (files: Record<string, string | null>, links: Record<string, string> = {}) => ({
  env: { PATH: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin' },
  home: HOME,
  platform: 'darwin' as const,
  exists: (path: string) => path in files,
  realpath: (path: string) => links[path] ?? path,
  probe: async (path: string) => files[links[path] ?? path] ?? files[path] ?? null,
})

test('a row that extends the knowledge\'s arguments keeps its extension', async (t) => {
  /* The chosen copy used to run on `known.acp.args` alone, so any flag the
     person added to their own row was dropped on the floor. Some agents
     cannot work without one: an OpenClaw with several agents configured
     refuses every prompt whose session key names no owner, and `--session
     agent:<id>:<label>` is the only way to name one (measured against
     openclaw 2026.8.2 — the row carried the flag and the process never saw
     it). A row that disagrees about the base is still corrected, which is
     what keeps a stale `gemini --experimental-acp` from outliving its CLI. */
  const store = await tempStore(t, [
    { id: 'openclaw', name: 'OpenClaw', command: 'openclaw', args: ['acp', '--session', 'agent:main:harnessdesk'] },
    { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
  ])
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({
      '/opt/homebrew/bin/openclaw': 'OpenClaw 2026.8.2 (0965053)',
      '/opt/homebrew/bin/gemini': '0.59.0',
    }),
    // OpenClaw's own preflight and daemon probe are not what this test is
    // about, and shelling out to them would read this machine.
    check: async () => ({ ok: true, output: '' }),
  })
  const [openclaw, gemini] = store.configs()
  const extended = await service.launchFor(openclaw!)
  assert.ok(extended && 'args' in extended, 'OpenClaw was not blocked')
  assert.deepEqual(
    extended.args,
    ['acp', '--session', 'agent:main:harnessdesk'],
    'the flag only the person can know to pass survives',
  )
  const corrected = await service.launchFor(gemini!)
  assert.ok(corrected && 'args' in corrected, 'Gemini was not blocked')
  assert.deepEqual(corrected.args, ['--acp'], 'a row that disagrees about the base is still corrected')
})

test("the person's newest usable copy runs in place of the row's command", async (t) => {
  const store = await tempStore(t, [
    { id: 'opencode', name: 'OpenCode', command: `${STATE}/acp-agents/opencode/1.18.27/opencode`, args: ['acp'], registry: { id: 'opencode', version: '1.18.27' } },
  ])
  const service = new InstallService({
    stateDir: STATE,
    store,
    registryVersion: async () => '1.18.30',
    now: () => 1000,
    locate: machine(
      {
        '/opt/homebrew/bin/opencode': 'opencode 1.18.29',
        '/opt/homebrew/Cellar/opencode/1.18.29/bin/opencode': 'opencode 1.18.29',
        '/Users/x/.local/bin/opencode': '1.18.20',
        [`${STATE}/acp-agents/opencode/1.18.27/opencode`]: '1.18.27',
      },
      // A Homebrew bin entry is a link into the Cellar; that is how it is known.
      { '/opt/homebrew/bin/opencode': '/opt/homebrew/Cellar/opencode/1.18.29/bin/opencode' },
    ),
  })
  const config = store.configs()[0]!
  const launch = await service.launchFor(config)
  assert.deepEqual(launch, { command: '/opt/homebrew/bin/opencode', args: ['acp'], version: '1.18.29' })

  const info = await service.describe(config)
  assert.ok(info)
  assert.equal(info.chosen?.path, '/opt/homebrew/bin/opencode')
  assert.equal(info.chosen?.channelLabel, 'Homebrew')
  assert.deepEqual(
    info.copies.map((copy) => [copy.version, copy.standing, copy.managed]),
    [
      ['1.18.29', 'chosen', false],
      ['1.18.27', 'older', true],
      ['1.18.20', 'older', false],
    ],
  )
  assert.deepEqual(info.fallback, { command: `${STATE}/acp-agents/opencode/1.18.27/opencode`, version: '1.18.27', managed: true })
  assert.deepEqual(info.registryUpdate, { version: '1.18.30' })
  assert.equal(info.policy, 'newest')
  assert.equal(info.home?.path, '~/.local/share/opencode')
  assert.equal(info.signIn?.terminal, 'opencode auth login')
  assert.equal(service.last('opencode'), info)
})

test('a pin is persisted in the row and honoured over the newest copy', async (t) => {
  const store = await tempStore(t, [{ id: 'opencode', name: 'OpenCode', command: 'npx', args: ['-y', 'opencode-ai@1.18.27', 'acp'] }])
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({ '/opt/homebrew/bin/opencode': '1.18.29', '/Users/x/.local/bin/opencode': '1.18.20' }),
  })
  service.pin('opencode', '/Users/x/.local/bin/opencode')
  assert.deepEqual(store.entry('opencode')?.['install'], { pin: '/Users/x/.local/bin/opencode' })
  const launch = await service.launchFor(store.configs()[0]!)
  assert.equal(launch && 'command' in launch ? launch.command : null, '/Users/x/.local/bin/opencode')
  const info = await service.describe(store.configs()[0]!)
  assert.equal(info?.policy, 'pinned')
  assert.equal(info?.copies.find((copy) => copy.path === '/Users/x/.local/bin/opencode')?.standing, 'pinned')
  // A runner row is a managed fallback: the desk wrote its version and may rewrite it.
  assert.deepEqual(info?.fallback, { command: 'npx -y opencode-ai@1.18.27 acp', version: '1.18.27', managed: true })

  service.pin('opencode', null)
  assert.equal(store.entry('opencode')?.['install'], undefined)
})

test('with nothing installed the row runs as written, and with nothing at all the start is blocked', async (t) => {
  const store = await tempStore(t, [
    { id: 'gemini', name: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli@0.58.0', '--acp'], registry: { id: 'gemini', version: '0.58.0' } },
    { id: 'cline', name: 'Cline', command: '/gone/cline', args: ['--acp'] },
  ])
  const service = new InstallService({ stateDir: STATE, store, locate: machine({}) })
  const [gemini, cline] = store.configs()
  assert.equal(await service.launchFor(gemini!), null, 'a runner fetches its own copy')
  const blocked = await service.launchFor(cline!)
  assert.ok(blocked && 'blocked' in blocked)
  assert.equal(blocked.blocked.reason, 'notInstalled')
  assert.match(blocked.blocked.remediation ?? '', /npm install -g cline/)
})

test('a copy below the floor is listed, not run, and the block names the update', async (t) => {
  const store = await tempStore(t, [{ id: 'pi-acp', name: 'pi', command: 'npx', args: ['-y', 'pi-acp@0.0.33'] }, { id: 'gemini', name: 'Gemini CLI', command: '/gone', args: [] }])
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({ '/opt/homebrew/bin/gemini': '0.57.0' }, { '/opt/homebrew/bin/gemini': '/opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js' }),
  })
  const gemini = store.configs().find((config) => config.id === 'gemini')!
  const blocked = await service.launchFor(gemini)
  assert.ok(blocked && 'blocked' in blocked)
  assert.equal(blocked.blocked.reason, 'versionTooOld')
  assert.match(blocked.blocked.message, /0\.57\.0/)
  assert.match(blocked.blocked.remediation ?? '', /npm install -g @google\/gemini-cli@latest/)
  const info = await service.describe(gemini)
  assert.equal(info?.copies[0]?.standing, 'too-old')
  assert.equal(info?.chosen, null)
})

test("an agent's own checks block the start in its own words", async (t) => {
  const store = await tempStore(t, [{ id: 'openclaw', name: 'OpenClaw', template: 'openclaw' }])
  const checks: string[] = []
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({ '/opt/homebrew/bin/openclaw': 'OpenClaw 2026.8.2 (0965053)' }),
    check: async (spec) => {
      checks.push([spec.command, ...(spec.args ?? [])].join(' '))
      if (spec.args?.[0] === 'config') return { ok: false, output: 'OpenClaw config is invalid: ~/.openclaw/openclaw.json\n  × openclaw.json:533 — meta: Unrecognized key: "lastTouchedAt"\n' }
      return { ok: true, output: '' }
    },
  })
  const config = store.configs()[0]!
  const blocked = await service.launchFor(config)
  assert.ok(blocked && 'blocked' in blocked)
  assert.match(blocked.blocked.message, /Unrecognized key/)
  assert.match(blocked.blocked.remediation ?? '', /openclaw doctor --fix/)
  // The check ran the copy that was found, not a bare name.
  assert.equal(checks[0], '/opt/homebrew/bin/openclaw config validate')

  // With the config accepted, the Gateway check is next, and its failure is the reason.
  const down = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({ '/opt/homebrew/bin/openclaw': 'OpenClaw 2026.8.2 (0965053)' }),
    check: async (spec) => ({ ok: spec.args?.[0] !== 'gateway', output: '' }),
  })
  const gateway = await down.launchFor(config)
  assert.ok(gateway && 'blocked' in gateway)
  assert.match(gateway.blocked.message, /Gateway is not running/)
  assert.match(gateway.blocked.remediation ?? '', /openclaw daemon start/)

  // Everything up: the bridge runs with its stdout kept clean.
  const up = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({ '/opt/homebrew/bin/openclaw': 'OpenClaw 2026.8.2 (0965053)' }),
    check: async () => ({ ok: true, output: '' }),
  })
  const launch = await up.launchFor(config)
  assert.deepEqual(launch, {
    command: '/opt/homebrew/bin/openclaw',
    args: ['acp'],
    env: { OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' },
    version: '2026.8.2',
  })
})

test('a bridge is pointed at the chosen CLI, and a registry adapter row is told which variable', async (t) => {
  const store = await tempStore(t, [
    { id: 'claude-code', name: 'Claude', template: 'claude-code' },
    { id: 'pi-acp', name: 'pi', command: 'npx', args: ['-y', 'pi-acp@0.0.33'], registry: { id: 'pi-acp', version: '0.0.33' } },
  ])
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({
      '/Users/x/.local/bin/claude': '2.1.240 (Claude Code)',
      '/opt/homebrew/bin/claude': '2.1.100 (Claude Code)',
      '/opt/homebrew/bin/pi': '0.85.1',
    }),
  })
  const claude: AcpAgentConfig = { id: 'claude-code', name: 'Claude', command: 'node', executable: { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' } }
  assert.equal(await service.launchFor(claude), null, 'a bridge row is not replaced')
  const found = await service.executableFor(claude, claude.executable!)
  assert.deepEqual(found, { path: '/Users/x/.local/bin/claude', version: '2.1.240' })

  const pi = store.configs().find((config) => config.id === 'pi-acp')!
  assert.deepEqual(service.executableSpecFor(pi), { command: 'pi', env: 'PI_ACP_PI_COMMAND' })
  const piCli = await service.executableFor(pi, service.executableSpecFor(pi)!)
  assert.equal(piCli?.path, '/opt/homebrew/bin/pi')
})

test('knowledge is found by row field, registry provenance, template key, or the command itself', async (t) => {
  const store = await tempStore(t, [
    { id: 'my-grok', name: 'G', command: 'grok', args: ['agent', 'stdio'], agent: 'grok-build' },
    { id: 'kimi', name: 'K', command: '/x/kimi', args: ['acp'], registry: { id: 'kimi', version: '1.50.0' } },
    { id: 'hermes', name: 'H', template: 'hermes' },
    { id: 'custom', name: 'C', command: '/usr/local/bin/codebuddy', args: ['--acp'] },
    { id: 'dsh', name: 'D', command: 'node', args: ['x.js'] },
  ])
  const service = new InstallService({ stateDir: STATE, store, locate: machine({}) })
  const ids = store.configs().map((config) => [config.id, service.knowledgeFor(config)?.id ?? null])
  assert.deepEqual(ids, [
    ['my-grok', 'grok-build'],
    ['kimi', 'kimi'],
    ['hermes', 'hermes'],
    ['custom', 'codebuddy-code'],
    ['dsh', null],
  ])
})

test('a template row naming an absent CLI is blocked before any spawn', async (t) => {
  const store = await tempStore(t, [{ id: 'gemini', name: 'Gemini CLI', template: 'gemini' }])
  const service = new InstallService({ stateDir: STATE, store, locate: machine({}) })
  const blocked = await service.launchFor(store.configs()[0]!)
  assert.ok(blocked && 'blocked' in blocked)
  assert.equal(blocked.blocked.reason, 'notInstalled')
  assert.match(blocked.blocked.remediation ?? '', /npm install -g @google\/gemini-cli/)
})

test('one scan answers one decision, and the agent’s own checks run only on a start', async (t) => {
  const store = await tempStore(t, [{ id: 'openclaw', name: 'OpenClaw', template: 'openclaw' }])
  const probed: string[] = []
  const checked: string[] = []
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: {
      ...machine({ '/opt/homebrew/bin/openclaw': 'OpenClaw 2026.8.2' }),
      probe: async (path: string) => {
        probed.push(path)
        return 'OpenClaw 2026.8.2'
      },
    },
    check: async (spec) => {
      checked.push([spec.command, ...(spec.args ?? [])].join(' '))
      return { ok: true, output: '' }
    },
  })
  const config = store.configs()[0]!

  // A start describes the decision it just made rather than making it twice.
  // Each scan spawns one `--version` per copy on the machine; describing by
  // re-scanning doubled the cost of every agent start, and the second scan
  // raced the start it was describing.
  await service.launchFor(config, 'start')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(probed.length, 1, `one scan per start, not ${probed.length}`)
  assert.equal(checked.length, 2, 'the config check and the daemon check, once each')

  // A re-check asks only whether a different copy should answer now. The
  // agent is already up, so its config is not re-litigated on a timer — this
  // runs every thirty minutes and on every focus return.
  probed.length = 0
  checked.length = 0
  await service.launchFor(config, 'recheck')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(probed.length, 1)
  assert.deepEqual(checked, [], 'no shelling out on a re-check')
})

test("a bridge's own interpreter is not a copy of the agent it drives", async (t) => {
  const store = await tempStore(t, [
    { id: 'claude-code', name: 'Claude', command: '/Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk', args: ['/bridge/main.js'] },
  ])
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({
      '/Users/x/.local/bin/claude': '2.1.258 (Claude Code)',
      // The row's own command is the app binary the bridge runs under. It is
      // absolute and it exists, and it was being probed for a version and
      // listed as a copy of Claude.
      '/Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk': 'HarnessDesk 0.1.0',
    }),
  })
  const info = await service.describe(store.configs()[0]!)
  assert.deepEqual(
    info?.copies.map((copy) => copy.path),
    ['/Users/x/.local/bin/claude'],
  )
})

test('a row pointing straight at a copy below the floor is refused, not run', async (t) => {
  // The bypass this pins: `chosen` is null because the only copy is too old,
  // but the row's own command *is* that copy, so the fallback looked runnable
  // and the start went ahead on the very binary the floor exists to refuse.
  const store = await tempStore(t, [
    { id: 'gemini', name: 'Gemini CLI', command: '/usr/local/bin/gemini', args: ['--acp'] },
  ])
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({ '/usr/local/bin/gemini': '0.57.0' }),
  })
  const decision = await service.launchFor(store.configs()[0]!)
  assert.ok(decision && 'blocked' in decision, 'a copy below the floor must not start')
  assert.equal(decision.blocked.reason, 'versionTooOld')
  assert.match(decision.blocked.message, /0\.57\.0/)
  // The reason the table wrote is a sentence; it is not given a second period.
  assert.doesNotMatch(decision.blocked.message, /\.\.$/)
  // A copy someone put there by hand has no update verb of its own, so the
  // refusal offers the vendor's install line rather than no way forward.
  assert.match(decision.blocked.remediation ?? '', /npm install -g @google\/gemini-cli/)
})

test('a package runner still answers when the installed copy is too old', async (t) => {
  // The other side of the same rule: a runner fetches its own pinned version,
  // which is not the copy that was judged, so it remains a real fallback.
  const store = await tempStore(t, [
    { id: 'gemini', name: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli@0.58.0', '--acp'] },
  ])
  const service = new InstallService({
    stateDir: STATE,
    store,
    locate: machine({ '/opt/homebrew/bin/gemini': '0.57.0' }),
  })
  assert.equal(await service.launchFor(store.configs()[0]!), null)
  const info = await service.describe(store.configs()[0]!)
  assert.equal(info?.chosen, null)
  assert.equal(info?.copies[0]?.standing, 'too-old')
  assert.equal(info?.fallback?.version, '0.58.0')
})

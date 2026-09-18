import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { SEAT_PREFERENCE_LIMIT, type RuntimeId } from '@harnessdesk/protocol'

import { AgentDirectory, AgentRegistryStore } from '../src/agent-registry.js'
import { AGENT_FILE_LIMIT, AGENT_TEMP_PREFIX } from '../src/agents.js'
import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * Backup and restore, proven the only way that counts: everything one host
 * exports comes up on a second, fresh host — the agent registered, the
 * preferences applied, the transcript findable by its words. And restore is
 * additive: nothing local is deleted, nothing local is rolled backwards, and
 * running it twice changes nothing the second time.
 */

const silent = new Logger('test', { level: 'error', console: false })

const hostAt = async (stateDir: string, options: { logger?: Logger; builtinAgents?: string } = {}) => {
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  const directory = new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which: async () => null,
  })
  const host = new Host({
    logger: options.logger ?? silent,
    state: new StateStore(join(stateDir, 'state.json')),
    agents: directory,
    catalogRefreshMs: 0,
    ...(options.builtinAgents ? { builtinAgents: options.builtinAgents } : {}),
  })
  return { host, store }
}

/** A logger that keeps warnings across child scopes and can synchronously release a test fault. */
class Heard extends Logger {
  constructor(
    readonly said: string[] = [],
    readonly onWarn?: (message: string) => void,
  ) {
    super('test', { level: 'error', console: false })
  }

  override child(): Logger {
    return new Heard(this.said, this.onWarn)
  }

  override warn(message: string): void {
    this.said.push(message)
    this.onWarn?.(message)
  }
}

/** A stored transcript file, as the store writes them. */
const transcriptFile = (savedAt: number, text: string) =>
  JSON.stringify({
    version: 1,
    runtime: 'my-agent',
    id: 's1',
    savedAt,
    updatedAt: savedAt,
    title: 'A kept conversation',
    preview: text,
    cwd: '/repo',
    turns: [
      {
        id: 't1',
        status: 'completed',
        items: [{ id: 'a', type: 'assistantMessage', text }],
      },
    ],
  })

const backupWith = (agentFolders: unknown[], seating?: Readonly<Record<string, unknown>>) => ({
  kind: 'harnessdesk-backup' as const,
  version: 1 as const,
  exportedAt: 1,
  hostVersion: 'test',
  agents: [],
  preferences: {},
  transcripts: [],
  agentFolders,
  ...(seating ? { seating } : {}),
})

const restorePathCase = async (t: TestContext, path: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-path-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  const report = await host.call('backup/import', {
    backup: backupWith([{ id: 'scout', files: [{ path: 'AGENT.md', text: 'brief' }, { path, text: 'untrusted' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 0 }, 'one refused file does not refuse its folder')
  return dir
}

test('what one host exports, a fresh host restores — and can prove it has', async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), 'hd-backup-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'hd-backup-b-'))
  t.after(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  })

  const a = await hostAt(dirA)
  t.after(() => a.host.dispose())
  a.store.add({ id: 'my-agent', name: 'My Agent', command: 'my-agent' })
  await a.host.call('app/state/set', { patch: { theme: 'dark', draftValues: { 'my-agent': { model: 'large' } } } })
  await mkdir(join(dirA, 'transcripts', 'my-agent'), { recursive: true })
  await writeFile(
    join(dirA, 'transcripts', 'my-agent', 's1.json'),
    transcriptFile(1000, 'the sentence worth finding later'),
  )

  const backup = await a.host.call('backup/export', {})
  assert.equal(backup.kind, 'harnessdesk-backup')
  assert.equal(backup.agents.length, 1)
  assert.equal(backup.transcripts.length, 1)
  assert.equal(backup.preferences['theme'], 'dark')
  // Nothing credential-shaped travels: the file has exactly the three stores.
  assert.deepEqual(
    Object.keys(backup).sort(),
    ['agentFolders', 'agents', 'exportedAt', 'hostVersion', 'kind', 'preferences', 'seating', 'transcripts', 'version'],
  )
  assert.deepEqual(backup.agentFolders, [])
  assert.equal(backup.seating, null)

  const b = await hostAt(dirB, { builtinAgents: join(dirB, 'builtin') })
  t.after(() => b.host.dispose())
  const report = await b.host.call('backup/import', { backup })
  assert.deepEqual(report.agents, { restored: 1, skipped: 0 })
  assert.equal(report.preferences, 2)
  assert.deepEqual(report.transcripts, { restored: 1, skipped: 0 })
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 0 })
  assert.deepEqual(report.seating, { restored: 0, skipped: 0 })

  // The proof, on the fresh host's own wire: the agent is a runtime, the
  // preference reads back, and the transcript answers a content search.
  const hello = await b.host.call('host/hello', { clientVersion: 'test' })
  assert.ok(hello.runtimes.some((entry) => entry.id === 'my-agent'))
  const state = await b.host.call('app/state/get', {})
  assert.equal(state['theme'], 'dark')
  const hits = await b.host.call('transcripts/search', { query: 'worth finding' })
  assert.equal(hits.length, 1)
  assert.equal(String(hits[0]?.summary.id), 's1')

  // Restoring the same file again is a no-op, counted as such.
  const again = await b.host.call('backup/import', { backup })
  assert.deepEqual(again.agents, { restored: 0, skipped: 1 })
  assert.deepEqual(again.transcripts, { restored: 0, skipped: 1 })
})

test("a backup carries this machine's Agents and seats, and restore only adds what is missing", async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), 'hd-backup-agents-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'hd-backup-agents-b-'))
  t.after(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  })

  const a = await hostAt(dirA)
  t.after(() => a.host.dispose())
  const source = '---\nname: Scout\n---\nLook around — carefully.\n'
  await mkdir(join(dirA, 'agents', 'scout', 'skills'), { recursive: true })
  await writeFile(join(dirA, 'agents', 'scout', 'AGENT.md'), source)
  await writeFile(join(dirA, 'agents', 'scout', 'skills', 'look.md'), 'Look closely.')
  await writeFile(join(dirA, 'seating.json'), JSON.stringify({ scout: ['claude-code=opus-5/high'], judge: ['codex'] }))

  const backup = await a.host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders, [
    {
      id: 'scout',
      files: [
        { path: 'AGENT.md', text: source },
        { path: 'skills/look.md', text: 'Look closely.' },
      ],
    },
  ])
  assert.deepEqual(backup.seating, { scout: ['claude-code=opus-5/high'], judge: ['codex'] })

  await mkdir(join(dirB, 'agents', 'keeper'), { recursive: true })
  await writeFile(join(dirB, 'agents', 'keeper', 'AGENT.md'), 'local copy')
  await writeFile(join(dirB, 'seating.json'), JSON.stringify({ judge: ['cursor'] }))
  await mkdir(join(dirB, 'builtin'))
  const b = await hostAt(dirB)
  await b.host.start()
  t.after(() => b.host.dispose())
  const notices: unknown[] = []
  b.host.addBroadcaster((notice) => {
    if (notice.method === 'agent/changed') notices.push(notice)
  })

  const report = await b.host.call('backup/import', {
    backup: {
      ...backup,
      agentFolders: [...(backup.agentFolders ?? []), { id: 'keeper', files: [{ path: 'AGENT.md', text: 'backup copy' }] }],
    },
  })
  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 1 })
  assert.deepEqual(report.seating, { restored: 1, skipped: 1 })
  assert.equal(await readFile(join(dirB, 'agents', 'scout', 'AGENT.md'), 'utf8'), source)
  assert.equal(await readFile(join(dirB, 'agents', 'scout', 'skills', 'look.md'), 'utf8'), 'Look closely.')
  assert.equal(await readFile(join(dirB, 'agents', 'keeper', 'AGENT.md'), 'utf8'), 'local copy')
  assert.deepEqual(JSON.parse(await readFile(join(dirB, 'seating.json'), 'utf8')), {
    judge: ['cursor'],
    scout: ['claude-code=opus-5/high'],
  })
  assert.ok(notices.length >= 1, 'the explicit restore notice arrived; the watcher may add another')

  const again = await b.host.call('backup/import', { backup })
  assert.deepEqual(again.agentFolders, { restored: 0, skipped: 1 })
  assert.deepEqual(again.seating, { restored: 0, skipped: 2 })
  assert.deepEqual(await readdir(join(dirB, 'agents', 'scout')), ['AGENT.md', 'skills'])
})

test('export uses the roster ids, leaves links inside behind, and carries only bounded UTF-8 text', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-export-agents-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const agents = join(dir, 'agents')
  const real = join(agents, 'real')
  const linkedSource = join(dir, 'linked-source')
  await mkdir(real, { recursive: true })
  await mkdir(linkedSource)
  const brief = '---\nname: Real\n---\nCafé 🚀\n'
  await writeFile(join(real, 'AGENT.md'), brief)
  await writeFile(join(real, 'binary.bin'), Buffer.from([0xff, 0xfe, 0xfd]))
  await writeFile(join(real, 'too-large.md'), 'é'.repeat(AGENT_FILE_LIMIT))
  const chunk = 'x'.repeat(AGENT_FILE_LIMIT)
  for (const name of ['chunk-a.md', 'chunk-b.md', 'chunk-c.md', 'chunk-d.md']) {
    await writeFile(join(real, name), chunk)
  }
  await symlink(join(dir, 'outside'), join(real, 'inside-link'))
  await writeFile(join(dir, 'outside'), 'outside')
  await writeFile(join(linkedSource, 'AGENT.md'), '---\nname: Linked\n---\nLinked.\n')
  await symlink(linkedSource, join(agents, 'linked'))
  await mkdir(join(agents, `${AGENT_TEMP_PREFIX}ABCDEF`))
  await writeFile(join(agents, `${AGENT_TEMP_PREFIX}ABCDEF`, 'AGENT.md'), 'half written')

  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['linked', 'real'])
  const copy = backup.agentFolders?.find((one) => one.id === 'real')
  assert.equal(copy?.files.find((one) => one.path === 'AGENT.md')?.text, brief, 'the brief decodes without loss')
  assert.deepEqual(copy?.files.map((one) => one.path), ['AGENT.md', 'chunk-a.md', 'chunk-b.md', 'chunk-c.md'])
})

test("restore refuses '..' instead of writing above the Agent's temporary folder", async (t) => {
  const dir = await restorePathCase(t, '../escape.md')
  assert.deepEqual(await readdir(join(dir, 'agents', 'scout')), ['AGENT.md'])
  await assert.rejects(readFile(join(dir, 'agents', 'escape.md')), { code: 'ENOENT' })
})

test('restore refuses an absolute path rather than spelling it below the Agent folder', async (t) => {
  const dir = await restorePathCase(t, join(tmpdir(), 'absolute-from-backup.md'))
  assert.deepEqual(await readdir(join(dir, 'agents', 'scout')), ['AGENT.md'])

  const windowsDir = await restorePathCase(t, 'C:/absolute-from-backup.md')
  assert.deepEqual(await readdir(join(windowsDir, 'agents', 'scout')), ['AGENT.md'])
})

test('restore refuses a backslash path rather than making a platform-dependent filename', async (t) => {
  const dir = await restorePathCase(t, 'bad\\path.md')
  assert.deepEqual(await readdir(join(dir, 'agents', 'scout')), ['AGENT.md'])
})

test('restore refuses a NUL path without aborting the Agent folder', async (t) => {
  const dir = await restorePathCase(t, 'bad\0path.md')
  assert.deepEqual(await readdir(join(dir, 'agents', 'scout')), ['AGENT.md'])
})

test('restore admits only roster ids and never replaces an existing folder or writes through a link', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-agent-ids-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const agents = join(dir, 'agents')
  const outside = join(dir, 'outside')
  await mkdir(join(agents, 'existing'), { recursive: true })
  await writeFile(join(agents, 'existing', 'AGENT.md'), 'local folder')
  await mkdir(outside)
  await writeFile(join(outside, 'AGENT.md'), 'linked target')
  await symlink(outside, join(agents, 'linked'))
  const folder = (id: string, text = id) => ({ id, files: [{ path: 'AGENT.md', text }] })

  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  const report = await host.call('backup/import', {
    backup: backupWith([
      folder(`${AGENT_TEMP_PREFIX}abc`),
      folder('constructor'),
      folder('Upper'),
      folder('__proto__'),
      folder('existing', 'backup folder'),
      folder('linked', 'backup through link'),
      folder('valid-agent'),
    ]),
  })
  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 6 })
  assert.equal(await readFile(join(agents, 'existing', 'AGENT.md'), 'utf8'), 'local folder')
  assert.equal(await readFile(join(outside, 'AGENT.md'), 'utf8'), 'linked target')
  assert.deepEqual((await readdir(agents)).sort(), ['existing', 'linked', 'valid-agent'])
})

test('bad files and refused writes are isolated, bounded, and leave no half-written Agent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-isolation-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const seatingTemp = join(dir, `seating.json.${process.pid}.tmp`)
  await mkdir(seatingTemp)
  const heard = new Heard([], (message) => {
    if (message === 'a seating entry from a backup could not be restored') {
      rmSync(seatingTemp, { recursive: true, force: true })
    }
  })
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  const chunk = 'x'.repeat(AGENT_FILE_LIMIT)
  const mixed = {
    id: 'mixed',
    files: [
      { path: 'AGENT.md', text: 'kept brief' },
      { path: 'AGENT.md', text: 'duplicate brief' },
      { path: 'a', text: 'first file' },
      { path: 'a/b.md', text: 'file below a file' },
      { path: 'nest/good.md', text: 'nested file' },
      { path: 'nest', text: 'folder after its child' },
      { path: 'too-large.md', text: 'é'.repeat(AGENT_FILE_LIMIT) },
      { path: 'chunk-a.md', text: chunk },
      { path: 'chunk-b.md', text: chunk },
      { path: 'chunk-c.md', text: chunk },
      { path: 'chunk-d.md', text: chunk },
    ],
  }
  const failure = {
    id: 'failure',
    files: [
      { path: 'AGENT.md', text: 'never lands' },
      { path: `${'x'.repeat(300)}/bad.md`, text: 'cannot be written' },
    ],
  }
  const after = { id: 'after', files: [{ path: 'AGENT.md', text: 'still restored' }] }
  const tooMany = Array.from({ length: SEAT_PREFERENCE_LIMIT + 1 }, (_, index) => `claude-code=model-${index}`)

  const report = await host.call('backup/import', {
    backup: backupWith([mixed, failure, after], {
      blocked: ['claude-code'],
      later: ['codex'],
      'too-many': tooMany,
    }),
  })
  assert.deepEqual(report.agentFolders, { restored: 2, skipped: 1 })
  assert.deepEqual(report.seating, { restored: 1, skipped: 2 })
  assert.equal(await readFile(join(dir, 'agents', 'mixed', 'AGENT.md'), 'utf8'), 'kept brief')
  assert.equal(await readFile(join(dir, 'agents', 'mixed', 'a'), 'utf8'), 'first file')
  assert.equal(await readFile(join(dir, 'agents', 'mixed', 'nest', 'good.md'), 'utf8'), 'nested file')
  for (const path of ['too-large.md', 'chunk-d.md']) {
    await assert.rejects(readFile(join(dir, 'agents', 'mixed', path)), { code: 'ENOENT' })
  }
  assert.equal(await readFile(join(dir, 'agents', 'after', 'AGENT.md'), 'utf8'), 'still restored')
  assert.deepEqual((await readdir(join(dir, 'agents'))).sort(), ['after', 'mixed'], 'the failed transaction left no final or temp folder')
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'seating.json'), 'utf8')), { later: ['codex'] })
  assert.ok(heard.said.includes('an Agent folder from a backup could not be restored'))
  assert.ok(heard.said.includes('a seating entry from a backup could not be restored'))
})

test('an absent seating file is quiet, but an unreadable one is left out with a warning', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-seating-raw-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())

  const absent = await host.call('backup/export', {})
  assert.equal(absent.seating, null)
  assert.deepEqual(heard.said, [])

  await writeFile(join(dir, 'seating.json'), '{not json')
  const unreadable = await host.call('backup/export', {})
  assert.equal(unreadable.seating, null)
  assert.deepEqual(heard.said, ['seating.json was left out of the backup'])

  await rm(join(dir, 'seating.json'))
  await mkdir(join(dir, 'seating.json'))
  const notAFile = await host.call('backup/export', {})
  assert.equal(notAFile.seating, null)
  assert.deepEqual(heard.said, [
    'seating.json was left out of the backup',
    'seating.json was left out of the backup',
  ])
})

test('a restore never rolls a local transcript backwards', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-c-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())

  await mkdir(join(dir, 'transcripts', 'my-agent'), { recursive: true })
  await writeFile(join(dir, 'transcripts', 'my-agent', 's1.json'), transcriptFile(2000, 'the newer local copy'))

  const report = await host.call('backup/import', {
    backup: {
      kind: 'harnessdesk-backup',
      version: 1,
      exportedAt: 1,
      hostVersion: 'test',
      agents: [],
      preferences: {},
      transcripts: [{ runtime: 'my-agent', id: 's1', data: JSON.parse(transcriptFile(1000, 'the stale backup copy')) }],
    },
  })
  assert.deepEqual(report.transcripts, { restored: 0, skipped: 1 })
  const hits = await host.call('transcripts/search', { query: 'newer local copy' })
  assert.equal(hits.length, 1, 'the local transcript is untouched')
})

test('what is not a backup is refused whole', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-d-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  await assert.rejects(
    host.call('backup/import', { backup: { some: 'other json file' } }),
    /not a HarnessDesk backup/,
  )
})

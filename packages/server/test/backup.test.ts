import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { SEAT_PREFERENCE_LIMIT, type RuntimeId } from '@harnessdesk/protocol'

import { AgentDirectory, AgentRegistryStore } from '../src/agent-registry.js'
import { MachineSeatingFile } from '../src/agent-seating-file.js'
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

const hostAt = async (stateDir: string, options: { logger?: Logger } = {}) => {
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
  })
  return { host, store }
}

/** A logger that keeps warnings across child scopes and can synchronously release a test fault. */
class Heard extends Logger {
  constructor(
    readonly said: string[] = [],
    readonly onWarn?: (message: string) => void,
    readonly details: unknown[] = [],
  ) {
    super('test', { level: 'error', console: false })
  }

  override child(): Logger {
    return new Heard(this.said, this.onWarn, this.details)
  }

  override warn(message: string, details?: unknown): void {
    this.said.push(message)
    this.details.push(details)
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
  // Nothing credential-shaped travels: the file has exactly the stores a backup owns.
  assert.deepEqual(
    Object.keys(backup).sort(),
    ['agentFolders', 'agents', 'exportedAt', 'hostVersion', 'kind', 'preferences', 'seating', 'transcripts', 'version'],
  )
  assert.deepEqual(backup.agentFolders, [])
  assert.equal(backup.seating, null)

  const b = await hostAt(dirB)
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
  const b = await hostAt(dirB)
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
  await writeFile(join(real, '!too-large.md'), 'é'.repeat(AGENT_FILE_LIMIT))
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

test('export quietly skips a dangling Agent link and still carries the good Agent beside it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-dangling-agent-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'agents', 'good'), { recursive: true })
  await writeFile(join(dir, 'agents', 'good', 'AGENT.md'), 'good brief')
  await symlink(join(dir, 'gone'), join(dir, 'agents', 'dangling'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['good'])
  assert.deepEqual(heard.said, [], 'a missing top-level target is not an Agent and is quiet')
})

test('export quietly skips an Agent link to a file and still carries the good Agent beside it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-file-agent-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'agents', 'good'), { recursive: true })
  await writeFile(join(dir, 'agents', 'good', 'AGENT.md'), 'good brief')
  await writeFile(join(dir, 'not-a-folder'), 'plain file')
  await symlink(join(dir, 'not-a-folder'), join(dir, 'agents', 'file-link'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['good'])
  assert.deepEqual(heard.said, [], 'a top-level target that is not a directory is not an Agent and is quiet')
})

test('export leaves an unreadable subfolder out with a warning and carries both that Agent and its good neighbour', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-unreadable-subfolder-'))
  const locked = join(dir, 'agents', 'scout', 'locked')
  await mkdir(locked, { recursive: true })
  await mkdir(join(dir, 'agents', 'good'), { recursive: true })
  await writeFile(join(dir, 'agents', 'scout', 'AGENT.md'), 'scout brief')
  await writeFile(join(locked, 'secret.md'), 'not carried')
  await writeFile(join(dir, 'agents', 'good', 'AGENT.md'), 'good brief')
  await chmod(locked, 0o000)
  // One hook, in this order: `t.after` hooks run in the order they were
  // added, so a separate restore-then-remove pair of hooks would remove
  // first and restore second — `rm`'s own `force` forgives a path that is
  // already gone, not one it cannot list, so it would fail on the very
  // folder this test is proving is isolated, not the code under test.
  t.after(async () => {
    await chmod(locked, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  const readable = await readdir(locked).then(
    () => true,
    () => false,
  )
  if (readable) return t.skip('this user can read a folder with mode 000')
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['good', 'scout'])
  assert.deepEqual(backup.agentFolders?.find((one) => one.id === 'scout')?.files, [
    { path: 'AGENT.md', text: 'scout brief' },
  ])
  assert.ok(heard.said.includes('a file or folder was left out of an Agent backup'))
})

test('export takes AGENT.md first, then files in code-unit order, and warns when an Agent has no usable brief', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-priority-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const agents = join(dir, 'agents')
  await mkdir(join(agents, 'budget'), { recursive: true })
  await writeFile(join(agents, 'budget', 'AGENT.md'), 'brief')
  const chunk = 'x'.repeat(AGENT_FILE_LIMIT)
  // Named to sort before "AGENT.md" in code-unit order ("!" is 0x21, "A" is
  // 0x41), and sized to exhaust the folder's budget exactly once AGENT.md's
  // own few bytes are already spent: a folder that merely sorted its files,
  // rather than taking AGENT.md first, would let these starve it instead.
  for (const name of ['!a.md', '!b.md', '!c.md', '!d.md']) await writeFile(join(agents, 'budget', name), chunk)
  await mkdir(join(agents, 'ordered'))
  await writeFile(join(agents, 'ordered', 'AGENT.md'), 'ordered brief')
  await writeFile(join(agents, 'ordered', 'Z.md'), 'upper')
  await writeFile(join(agents, 'ordered', 'a.md'), 'lower')
  await mkdir(join(agents, 'linked-brief'))
  await writeFile(join(dir, 'outside-brief'), 'linked')
  await symlink(join(dir, 'outside-brief'), join(agents, 'linked-brief', 'AGENT.md'))
  await mkdir(join(agents, 'binary-brief'))
  await writeFile(join(agents, 'binary-brief', 'AGENT.md'), Buffer.from([0xff]))
  await mkdir(join(agents, 'oversized-brief'))
  await writeFile(join(agents, 'oversized-brief', 'AGENT.md'), 'x'.repeat(AGENT_FILE_LIMIT + 1))
  await mkdir(join(agents, 'absent-brief'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['budget', 'ordered'])
  assert.deepEqual(backup.agentFolders?.find((one) => one.id === 'budget')?.files.map((one) => one.path), [
    'AGENT.md',
    '!a.md',
    '!b.md',
    '!c.md',
  ])
  assert.deepEqual(backup.agentFolders?.find((one) => one.id === 'ordered')?.files.map((one) => one.path), [
    'AGENT.md',
    'Z.md',
    'a.md',
  ])
  assert.equal(heard.said.filter((message) => message === 'an Agent was left out of the backup').length, 4)
  // Each omission carries why, not just that it happened.
  const details = heard.details as { id?: unknown; error?: unknown }[]
  const reasonFor = (id: string) => details.find((one) => one.id === id)?.error
  assert.match(String(reasonFor('linked-brief')), /link/)
  assert.match(String(reasonFor('binary-brief')), /UTF-8/)
  assert.match(String(reasonFor('oversized-brief')), /larger than 256 KiB/)
  assert.match(String(reasonFor('absent-brief')), /no AGENT\.md/)
})

test('.git is left out at every depth on export and restore', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-git-metadata-'))
  const restored = await mkdtemp(join(tmpdir(), 'hd-backup-git-restored-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(restored, { recursive: true, force: true })
  })
  const agent = join(dir, 'agents', 'scout')
  await mkdir(join(agent, '.git'), { recursive: true })
  await mkdir(join(agent, 'skills', '.git'), { recursive: true })
  await writeFile(join(agent, 'AGENT.md'), 'brief')
  await writeFile(join(agent, '.git', 'config'), 'https://token@example.com/repo')
  await writeFile(join(agent, 'skills', '.git', 'config'), 'nested token')
  await writeFile(join(agent, 'skills', 'safe.md'), 'safe')
  const source = await hostAt(dir)
  t.after(() => source.host.dispose())

  const backup = await source.host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.[0]?.files.map((one) => one.path), ['AGENT.md', 'skills/safe.md'])

  const target = await hostAt(restored)
  t.after(() => target.host.dispose())
  const report = await target.host.call('backup/import', {
    backup: backupWith([
      {
        id: 'scout',
        files: [
          { path: 'AGENT.md', text: 'brief' },
          { path: '.git/config', text: 'top token' },
          { path: 'skills/.git/config', text: 'nested token' },
          { path: 'skills/safe.md', text: 'safe' },
        ],
      },
    ]),
  })
  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 0 })
  assert.deepEqual(await readdir(join(restored, 'agents', 'scout')), ['AGENT.md', 'skills'])
  assert.deepEqual(await readdir(join(restored, 'agents', 'scout', 'skills')), ['safe.md'])
})

test('.git is left out at every depth however its case is spelled — a case-insensitive volume reads .GIT as .git', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-git-case-'))
  const restored = await mkdtemp(join(tmpdir(), 'hd-backup-git-case-restored-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(restored, { recursive: true, force: true })
  })
  const agent = join(dir, 'agents', 'scout')
  await mkdir(join(agent, '.GIT'), { recursive: true })
  await mkdir(join(agent, 'skills', '.GiT'), { recursive: true })
  await writeFile(join(agent, 'AGENT.md'), 'brief')
  await writeFile(join(agent, '.GIT', 'config'), 'https://token@example.com/repo')
  await writeFile(join(agent, 'skills', '.GiT', 'config'), 'nested token')
  await writeFile(join(agent, 'skills', 'safe.md'), 'safe')
  const source = await hostAt(dir)
  t.after(() => source.host.dispose())

  const backup = await source.host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.[0]?.files.map((one) => one.path), ['AGENT.md', 'skills/safe.md'])

  const target = await hostAt(restored)
  t.after(() => target.host.dispose())
  const report = await target.host.call('backup/import', {
    backup: backupWith([
      {
        id: 'scout',
        files: [
          { path: 'AGENT.md', text: 'brief' },
          { path: '.GIT/config', text: 'top token' },
          { path: 'skills/.GiT/config', text: 'nested token' },
          { path: 'skills/safe.md', text: 'safe' },
        ],
      },
    ]),
  })
  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 0 })
  assert.deepEqual(await readdir(join(restored, 'agents', 'scout')), ['AGENT.md', 'skills'])
  assert.deepEqual(await readdir(join(restored, 'agents', 'scout', 'skills')), ['safe.md'])
})

test('export and restore preserve a UTF-8 byte-order mark byte for byte', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-bom-'))
  const restored = await mkdtemp(join(tmpdir(), 'hd-backup-bom-restored-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(restored, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'agents', 'scout'), { recursive: true })
  const source = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('brief')])
  await writeFile(join(dir, 'agents', 'scout', 'AGENT.md'), source)
  const a = await hostAt(dir)
  const b = await hostAt(restored)
  t.after(() => a.host.dispose())
  t.after(() => b.host.dispose())

  const backup = await a.host.call('backup/export', {})
  await b.host.call('backup/import', { backup })
  assert.deepEqual(await readFile(join(restored, 'agents', 'scout', 'AGENT.md')), source)
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

test("restore refuses a '.' path segment without aborting the Agent folder", async (t) => {
  const dir = await restorePathCase(t, 'notes/./bad.md')
  assert.deepEqual(await readdir(join(dir, 'agents', 'scout')), ['AGENT.md'])
})

test('restore drops case and Unicode aliases and overlong segments before writing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-path-aliases-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  const report = await host.call('backup/import', {
    backup: backupWith([
      {
        id: 'scout',
        files: [
          { path: 'AGENT.md', text: 'brief' },
          { path: 'Notes.md', text: 'first case spelling' },
          { path: 'notes.md', text: 'case alias' },
          { path: 'café.md', text: 'first Unicode spelling' },
          { path: 'café.md', text: 'Unicode alias' },
          { path: `${'é'.repeat(128)}.md`, text: 'longer than NAME_MAX in UTF-8' },
        ],
      },
    ]),
  })

  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 0 })
  assert.deepEqual((await readdir(join(dir, 'agents', 'scout'))).sort(), ['AGENT.md', 'Notes.md', 'café.md'])
  assert.equal(await readFile(join(dir, 'agents', 'scout', 'Notes.md'), 'utf8'), 'first case spelling')
  assert.equal(await readFile(join(dir, 'agents', 'scout', 'café.md'), 'utf8'), 'first Unicode spelling')
})

test('export and restore cap an Agent folder at 200 files even when the extras are empty', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'hd-backup-file-cap-source-'))
  const target = await mkdtemp(join(tmpdir(), 'hd-backup-file-cap-target-'))
  const imported = await mkdtemp(join(tmpdir(), 'hd-backup-file-cap-import-'))
  t.after(async () => {
    await rm(source, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
    await rm(imported, { recursive: true, force: true })
  })
  await mkdir(join(source, 'agents', 'scout'), { recursive: true })
  await writeFile(join(source, 'agents', 'scout', 'AGENT.md'), 'brief')
  for (let index = 0; index < 205; index += 1) {
    await writeFile(join(source, 'agents', 'scout', `file-${String(index).padStart(3, '0')}.md`), '')
  }
  const a = await hostAt(source)
  t.after(() => a.host.dispose())
  const exported = await a.host.call('backup/export', {})
  assert.equal(exported.agentFolders?.[0]?.files.length, 200)

  const b = await hostAt(target)
  t.after(() => b.host.dispose())
  const files = [
    { path: 'AGENT.md', text: 'brief' },
    ...Array.from({ length: 205 }, (_, index) => ({ path: `file-${String(index).padStart(3, '0')}.md`, text: '' })),
  ]
  const report = await b.host.call('backup/import', { backup: backupWith([{ id: 'scout', files }]) })
  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 0 })
  assert.equal((await readdir(join(target, 'agents', 'scout'))).length, 200)

  const c = await hostAt(imported)
  t.after(() => c.host.dispose())
  const missingBrief = await c.host.call('backup/import', {
    backup: backupWith([{ id: 'scout', files: [...files.slice(1), { path: 'AGENT.md', text: 'too late' }] }]),
  })
  assert.deepEqual(missingBrief.agentFolders, { restored: 0, skipped: 1 })
})

test('restore never examines past the 200th entry, even when every one of the first 200 is invalid', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-invalid-flood-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  // None of these 205 can ever be accepted — each climbs above the Agent
  // folder — so the old "cap accepted files" guard never triggered on them
  // at all, and a late AGENT.md right behind them was still read.
  const invalid = Array.from({ length: 205 }, (_, index) => ({ path: `../escape-${index}.md`, text: '' }))
  const report = await host.call('backup/import', {
    backup: backupWith([{ id: 'scout', files: [...invalid, { path: 'AGENT.md', text: 'too late' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 1 })
  await assert.rejects(readdir(join(dir, 'agents', 'scout')), { code: 'ENOENT' })
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

test('restore logs every refused Agent id with a reason and a quoted, capped id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-refused-id-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  const stranger = `stranger-${'x'.repeat(2_000)}`
  const report = await host.call('backup/import', {
    backup: backupWith(
      [
        { id: 'Reviewer', files: [{ path: 'AGENT.md', text: 'brief' }] },
        { id: stranger, files: [{ path: 'AGENT.md', text: 'brief' }] },
      ],
      { Reviewer: ['codex'] },
    ),
  })

  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 2 })
  assert.deepEqual(report.seating, { restored: 1, skipped: 0 }, 'a refused folder does not refuse its valid seat')
  assert.deepEqual(heard.said, [
    'an Agent folder from a backup was refused',
    'an Agent folder from a backup was refused',
  ])
  const details = heard.details as { id?: unknown; error?: unknown }[]
  assert.equal(details[0]?.id, '"Reviewer"')
  assert.match(String(details[0]?.error), /id/i)
  assert.equal(typeof details[1]?.id, 'string')
  assert.ok(String(details[1]?.id).length <= 160, 'the quoted id is capped before it reaches the log')
  assert.match(String(details[1]?.id), /^".*"$/s, 'the capped id remains a JSON-quoted string')
})

test('a control character in a backup id does not smuggle the logged id past its cap', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-control-char-id-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  // Each NUL escapes to six characters (U+0000 spelled out): 140 raw characters —
  // already at the cap before any escaping — read back as an 842-character
  // JSON string if the cap is taken before `JSON.stringify` rather than after.
  const nully = '\0'.repeat(140)
  const report = await host.call('backup/import', {
    backup: backupWith([{ id: nully, files: [{ path: 'AGENT.md', text: 'brief' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 1 })
  const details = heard.details as { id?: unknown }[]
  const logged = String(details[0]?.id)
  assert.ok(logged.length <= 140, `capped after escaping, not before: got ${logged.length} characters`)
  assert.match(logged, /^".*"$/s, 'still looks like a quoted string')
})

test('an existing Agent collision is a quiet skip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-quiet-collision-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'agents', 'scout'), { recursive: true })
  await writeFile(join(dir, 'agents', 'scout', 'AGENT.md'), 'local')
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())

  const report = await host.call('backup/import', {
    backup: backupWith([{ id: 'scout', files: [{ path: 'AGENT.md', text: 'backup' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 1 })
  assert.equal(await readFile(join(dir, 'agents', 'scout', 'AGENT.md'), 'utf8'), 'local')
  assert.deepEqual(heard.said, [])
})

test('a restored Agent folder is announced by its own explicit notice, proven on a host whose watcher was never started', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-no-watch-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  // `host.start()` is what makes an `AgentWatch` at all — never called here,
  // so this host's roster watch never exists. If a notice still arrives, the
  // explicit push inside `backup/import` sent it: proof that does not lean
  // on the watcher's own 150 ms settle (`SETTLE_MS`, agent-watch.ts) losing a
  // race it was never even entered into.
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  const notices: unknown[] = []
  host.addBroadcaster((notice) => {
    if (notice.method === 'agent/changed') notices.push(notice)
  })

  const report = await host.call('backup/import', {
    backup: backupWith([{ id: 'scout', files: [{ path: 'AGENT.md', text: 'brief' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 1, skipped: 0 })
  assert.deepEqual(notices, [{ method: 'agent/changed', params: { project: null } }])
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
  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    writeFile: (...args: unknown[]) => Promise<unknown>
  }
  const realWriteFile = fsp.writeFile
  fsp.writeFile = async (...args) => {
    if (String(args[0]).endsWith('/fault.md')) {
      throw Object.assign(new Error('injected Agent backup write failure'), { code: 'EIO' })
    }
    return realWriteFile(...args)
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.writeFile = realWriteFile
    syncBuiltinESMExports()
  })
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
      { path: 'fault.md', text: 'the injected write refuses this' },
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

  await writeFile(join(dir, 'seating.json'), '[]')
  const notAnObject = await host.call('backup/export', {})
  assert.equal(notAnObject.seating, null)
  assert.deepEqual(heard.said, [
    'seating.json was left out of the backup',
    'seating.json was left out of the backup',
  ])

  await rm(join(dir, 'seating.json'))
  await mkdir(join(dir, 'seating.json'))
  const notAFile = await host.call('backup/export', {})
  assert.equal(notAFile.seating, null)
  assert.deepEqual(heard.said, [
    'seating.json was left out of the backup',
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

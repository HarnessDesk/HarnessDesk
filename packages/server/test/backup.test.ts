import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { SEAT_PREFERENCE_LIMIT, type BackupReport, type EvidenceRecord, type GoalView, type Lane, type MachineSeating, type RuntimeId, type WrapPreview } from '@harnessdesk/protocol'

import { exportAgentFolders } from '../src/agent-files.js'
import { ATTACHMENT_TRUST_FILE } from '../src/attachments/trust.js'
import { AgentDirectory, AgentRegistryStore } from '../src/agent-registry.js'
import { MachineSeatingFile } from '../src/agent-seating-file.js'
import { AGENT_FILE_LIMIT, AGENT_TEMP_PREFIX } from '../src/agents.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { foldFindings, isResolved } from '../src/findings/model.js'
import { Host, Logger, StateStore } from '../src/index.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalStore, restoredLane, type GoalDocument } from '../src/goals/store.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { rig as triggerRig } from './fixtures/intake-consent.js'
import { goal } from './fixtures/goals.js'
import { Client, halt, start as startHarness } from './fixtures/harness.js'

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

/**
 * Whether `text` holds a UTF-16 surrogate half with no partner: a high one
 * not immediately followed by a low one, or a low one with no high one
 * before it. `String.prototype.isWellFormed` says the same thing, but is
 * newer than this project's `lib` target — this is the same check by hand.
 */
const hasLoneSurrogate = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      // `charCodeAt` past the end answers `NaN`, and every comparison with
      // `NaN` is false — so a high surrogate as the very last character, with
      // no partner to even ask about, must be caught by a positive range
      // check on `next`, never by negating two `<`/`>` comparisons against it.
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1 // the pair is one code point; do not re-examine its low half
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

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
    ['agentFolders', 'agents', 'evidence', 'exportedAt', 'goals', 'hostVersion', 'kind', 'memory', 'preferences', 'provenance', 'seating', 'transcripts', 'version'],
  )
  assert.deepEqual(backup.goals, { version: 1, documents: [], lanes: [] })
  assert.deepEqual(backup.memory, { version: 1, objects: [], indexes: [], attachments: [] })
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
  assert.deepEqual(report.memory, { restored: 0, alreadyHere: 0, refused: 0, failed: 0 })

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

test('the memory sidecar is optional and never carries trust, even under a hostile key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-memory-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())

  // A legacy backup, from before this sidecar existed, restores exactly as it always did.
  const legacyReport = await host.call('backup/import', { backup: backupWith([]) })
  assert.deepEqual(legacyReport.memory, { restored: 0, alreadyHere: 0, refused: 0, failed: 0 })

  // Nothing under `memory` this sidecar does not itself define — an
  // `attachmentTrust` key, most of all — can smuggle a load approval in.
  const hostile = {
    ...backupWith([]),
    memory: { version: 1, objects: [], indexes: [], attachments: [], attachmentTrust: [{ token: 'x', approvedAt: 1 }] },
  }
  const hostileReport = await host.call('backup/import', { backup: hostile })
  assert.deepEqual(hostileReport.memory, { restored: 0, alreadyHere: 0, refused: 0, failed: 0 })
  await assert.rejects(readFile(join(dir, ATTACHMENT_TRUST_FILE)))

  // Export round-trips the new key, and carries exactly its own four fields — no trust, no live gateway state.
  const exported = await host.call('backup/export', {})
  assert.deepEqual(Object.keys(exported.memory ?? {}).sort(), ['attachments', 'indexes', 'objects', 'version'])
  assert.deepEqual(exported.memory, { version: 1, objects: [], indexes: [], attachments: [] })
})

test('restored Goals are inert history and never acquire local lane authority', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'hd-backup-goal-source-'))
  const target = await mkdtemp(join(tmpdir(), 'hd-backup-goal-target-'))
  t.after(async () => {
    await rm(source, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  })
  await migrateDesk(source, async () => {})
  await migrateDesk(target, async () => {})
  const original: GoalDocument = {
    version: 1,
    goal: goal('portable-goal'),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
    citations: [], receipt: null, operation: null,
  }
  const from = new GoalStore(source)
  await from.load()
  await from.save(original, null)
  const into = new GoalStore(target)
  await into.load()
  assert.equal(await into.restore(from.read('portable-goal'), 1234), 'restored')
  assert.deepEqual(into.read('portable-goal').restored, { at: 1234 })
  assert.equal(into.read('portable-goal').operation, null)
  assert.equal(await into.restore(from.read('portable-goal'), 9999), 'duplicate')
  const changed = { ...original, goal: { ...original.goal, sentence: 'Different history' } }
  assert.equal(await into.restore(changed, 1234), 'conflict')

  const lane: Lane = {
    id: 'lane-history', goal: 'portable-goal', seat: 'seat-history', cwd: '/workspace/demo',
    branch: 'goal/demo', ports: { start: 62000, end: 62017 }, browserProfile: 'lane-11111111-1111-1111-1111-111111111111',
    state: 'active', createdAt: 1,
  }
  assert.deepEqual(restoredLane(lane), {
    ...lane, seat: null, browserProfile: null, state: 'released',
  })
})

test('a real backup restores wrapped Goals as readable history without replaying work', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'hd-backup-goal-work-'))
  const source = await startHarness()
  const target = await startHarness()
  const sourceClient = await Client.connect(source.server)
  const targetClient = await Client.connect(target.server)
  t.after(async () => {
    sourceClient.close()
    targetClient.close()
    await halt(source).catch(() => {})
    await halt(target).catch(() => {})
    await rm(source.stateDir, { recursive: true, force: true })
    await rm(target.stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })
  await sourceClient.call('workspace/open', { path: work })
  const created = await sourceClient.call('goal/create', { root: work, sentence: 'Keep the reviewed history' }) as GoalView
  const choices = { summary: 'Reviewed before export.', cards: [] }
  const preview = await sourceClient.call('goal/preview', { goal: created.goal.id, choices }) as WrapPreview
  await sourceClient.call('goal/wrap', { goal: created.goal.id, stamp: preview.stamp, choices })
  const backup = await sourceClient.call('backup/export', {})
  const report = await targetClient.call('backup/import', { backup }) as BackupReport
  assert.deepEqual(report.goals, {
    restored: 1, duplicate: 0, conflict: 0,
    lanesRestored: 0, lanesDuplicate: 0, lanesConflict: 0,
  })
  const restored = await targetClient.call('goal/read', { goal: created.goal.id }) as GoalView
  assert.equal(restored.goal.state, 'wrapped')
  assert.equal(restored.receipt?.summary, choices.summary)
  assert.match(restored.problem ?? '', /came from a backup/)
  await assert.rejects(
    targetClient.call('goal/update', { goal: created.goal.id, revision: restored.goal.revision, sentence: 'Revive it' }),
    /came from a backup|read-only/,
  )
  const again = await targetClient.call('backup/import', { backup }) as BackupReport
  assert.equal(again.goals?.duplicate, 1)
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
    $revision: 1,
    judge: ['cursor'],
    scout: ['claude-code=opus-5/high'],
  })
  assert.ok(
    notices.some(
      (notice) =>
        typeof notice === 'object' &&
        notice !== null &&
        'method' in notice &&
        notice.method === 'agent/changed' &&
        'params' in notice &&
        (notice.params as { revision?: unknown }).revision === 1,
    ),
    'the explicit restore notice carried the restored seating revision; the watcher may add another',
  )

  const again = await b.host.call('backup/import', { backup })
  assert.deepEqual(again.agentFolders, { restored: 0, skipped: 1 })
  assert.deepEqual(again.seating, { restored: 0, skipped: 2 })
  assert.deepEqual(await readdir(join(dirB, 'agents', 'scout')), ['AGENT.md', 'skills'])
})

test('backup export waits for a seating edit that was already queued', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-seating-queue-'))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
  await host.call('agent/seating/set', { id: 'judge', seats: [{ runtime: 'codex' }] })

  const path = join(dir, 'seating.json')
  const before = await readFile(path, 'utf8')
  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    readFile: (...args: unknown[]) => Promise<unknown>
    rename: (...args: unknown[]) => Promise<void>
  }
  const { readFile: realRead, rename: realRename } = fsp
  const realRaw = MachineSeatingFile.prototype.raw
  let releaseRename!: () => void
  const renameReleased = new Promise<void>((resolve) => {
    releaseRename = resolve
  })
  let enterRename!: () => void
  const renameEntered = new Promise<void>((resolve) => {
    enterRename = resolve
  })
  let enterRaw!: () => void
  const rawEntered = new Promise<void>((resolve) => {
    enterRaw = resolve
  })
  let writeHeld = false
  let crossedWrite = false
  fsp.readFile = async (...args) => {
    if (String(args[0]) === path && writeHeld) {
      crossedWrite = true
      return before
    }
    return realRead(...args)
  }
  fsp.rename = async (...args) => {
    if (String(args[1]) === path) {
      writeHeld = true
      enterRename()
      await renameReleased
      writeHeld = false
    }
    return realRename(...args)
  }
  MachineSeatingFile.prototype.raw = async function (...args) {
    enterRaw()
    return realRaw.apply(this, args)
  }
  syncBuiltinESMExports()
  t.after(() => {
    releaseRename()
    MachineSeatingFile.prototype.raw = realRaw
    fsp.readFile = realRead
    fsp.rename = realRename
    syncBuiltinESMExports()
  })

  const set = host.call('agent/seating/set', { id: 'reviewer', seats: [{ runtime: 'cursor' }] })
  await renameEntered
  const backup = host.call('backup/export', {})
  await rawEntered
  await new Promise((resolve) => setImmediate(resolve))
  if (crossedWrite) await backup
  releaseRename()

  const [exported] = await Promise.all([backup, set])
  assert.equal(crossedWrite, false, 'the export did not read seating.json across the in-flight local write')
  assert.deepEqual(exported.seating, {
    judge: ['codex'],
    reviewer: ['cursor'],
  })
})

test('restoring seating into a removed file advances beyond the revision an open client drew', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-seating-revision-'))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const first = (await host.call('agent/seating/set', { id: 'judge', seats: [{ runtime: 'codex' }] })) as MachineSeating
  const drawn = (await host.call('agent/seating/set', {
    id: 'reviewer',
    seats: [{ runtime: 'claude-code' }],
  })) as MachineSeating
  assert.equal(first.revision, 1, 'control: the first write ran')
  assert.equal(drawn.revision, 2, 'control: the open client drew revision 2')

  await rm(join(dir, 'seating.json'))
  const notices: unknown[] = []
  host.addBroadcaster((notice) => {
    if (notice.method === 'agent/changed') notices.push(notice)
  })
  const report = await host.call('backup/import', {
    backup: backupWith([], { scout: ['cursor'] }),
  })
  assert.deepEqual(report.seating, { restored: 1, skipped: 0 })

  const restored = (await host.call('agent/seating/read', {})) as MachineSeating
  assert.ok(restored.revision > drawn.revision, 'restore advances beyond the open client')
  const window = restored.revision >= drawn.revision ? restored : drawn
  assert.deepEqual(
    window.entries,
    [{ id: 'scout', seats: [{ runtime: 'cursor' }] }],
    'the already-open client accepts and draws the restored seats',
  )
  assert.ok(
    notices.some(
      (notice) =>
        typeof notice === 'object' &&
        notice !== null &&
        'method' in notice &&
        notice.method === 'agent/changed' &&
        'params' in notice &&
        (notice.params as { revision?: unknown }).revision === restored.revision,
    ),
    'the restore notification carries the same monotonic revision',
  )
})

test('export uses the roster ids, leaves links inside behind, and carries only bounded UTF-8 text', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-export-agents-'))
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
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['linked', 'real'])
  const copy = backup.agentFolders?.find((one) => one.id === 'real')
  assert.equal(copy?.files.find((one) => one.path === 'AGENT.md')?.text, brief, 'the brief decodes without loss')
  assert.deepEqual(copy?.files.map((one) => one.path), ['AGENT.md', 'chunk-a.md', 'chunk-b.md', 'chunk-c.md'])
})

/*
 * R2 (PR #814 round 1, agent-files.ts:479, regularEntries/take): a folder's
 * contents are classified with one `lstat`, then read again later, by path —
 * a folder swapped for a link out of the Agent folder in that gap has its
 * new target's contents read straight through the very next `readdir`, and
 * export's own `take()` already opens a file with `O_NOFOLLOW` (so a file
 * swapped for a *link* is already refused before this fix), but nothing
 * before this fix checks that a file opened clean is still the very file
 * `regularEntries` classified — a swap to a different regular file (here, a
 * hard link to one outside the Agent folder, sharing its inode) opens fine
 * and reads through, unnoticed.
 *
 * `lstat` is patched the same way `agent-seating-file.test.ts` already
 * patches this same module: the swap lands right after classification
 * captured the entry, answered with the real, pre-swap result every time, so
 * classification itself is never wrong.
 */
/*
 * These five tests match a swap target by the *relative* suffix of the path
 * a real `lstat`/`readdir` call names — `join('scout', 'nested')`, say —
 * never a pre-computed absolute path. `exportAgentFolders` now `realpath`s
 * each id's own top folder before walking it (round 2), so the absolute
 * path it later checks a nested entry against may not be byte-for-byte what
 * a test builds from the un-resolved `agents` root it created (on this Mac,
 * `/tmp` is itself a link to `/private/tmp`) — matching by suffix means
 * these patches fire correctly whichever form the code under test happens
 * to use, round 1's or round 2's, rather than silently never firing at all
 * and leaving a test "red" only because a file it expected absent shows up
 * with its own honest content, never because anything outside was read.
 */
test('export leaves a nested folder out, and carries nothing from outside, when it is swapped for a link out of the Agent folder right after it is classified', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-dir-swap-'))
  const agents = join(dir, 'agents')
  const nested = join(agents, 'scout', 'nested')
  const outside = join(dir, 'outside')
  await mkdir(nested, { recursive: true })
  await mkdir(join(agents, 'good'), { recursive: true })
  await writeFile(join(agents, 'scout', 'AGENT.md'), 'scout brief')
  await writeFile(join(nested, 'todo.txt'), 'inside, safe')
  await writeFile(join(agents, 'good', 'AGENT.md'), 'good brief')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'OUTSIDE SECRET')
  const suffix = join('scout', 'nested')

  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    lstat: (...args: unknown[]) => Promise<unknown>
  }
  const realLstat = fsp.lstat
  let swapped = false
  fsp.lstat = async (...args: unknown[]) => {
    const result = await realLstat(...args)
    const path = String(args[0])
    if (!swapped && path.endsWith(suffix)) {
      swapped = true
      await rm(path, { recursive: true, force: true })
      await symlink(outside, path)
    }
    return result
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.lstat = realLstat
    syncBuiltinESMExports()
  })

  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['good', 'scout'])
  const scout = backup.agentFolders?.find((one) => one.id === 'scout')
  assert.deepEqual(scout?.files, [{ path: 'AGENT.md', text: 'scout brief' }], 'the swapped folder carried nothing')
  assert.ok(heard.said.includes('a file or folder was left out of an Agent backup'))
})

test('export leaves a nested file out, and carries nothing from outside, when it is swapped for a hard link to a file outside the Agent folder right after it is classified', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-file-swap-'))
  const agents = join(dir, 'agents')
  const note = join(agents, 'scout', 'note.txt')
  const outside = join(dir, 'outside-secret.txt')
  await mkdir(join(agents, 'scout'), { recursive: true })
  await writeFile(join(agents, 'scout', 'AGENT.md'), 'scout brief')
  await writeFile(note, 'inside, safe')
  await writeFile(outside, 'OUTSIDE SECRET')
  const suffix = join('scout', 'note.txt')

  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    lstat: (...args: unknown[]) => Promise<unknown>
  }
  const realLstat = fsp.lstat
  let swapped = false
  fsp.lstat = async (...args: unknown[]) => {
    const result = await realLstat(...args)
    const path = String(args[0])
    if (!swapped && path.endsWith(suffix)) {
      swapped = true
      await unlink(path)
      await link(outside, path)
    }
    return result
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.lstat = realLstat
    syncBuiltinESMExports()
  })

  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const backup = await host.call('backup/export', {})
  const scout = backup.agentFolders?.find((one) => one.id === 'scout')
  assert.deepEqual(scout?.files, [{ path: 'AGENT.md', text: 'scout brief' }], 'the swapped file carried nothing')
  assert.ok(heard.said.includes('a file or folder was left out of an Agent backup'))
})

/*
 * PR #814 round 2: the two tests above swap a nested folder or file the
 * moment it is classified. Round 2's own review found a later gap:
 * `regularEntries`' own before/after checks on a nested directory run once,
 * at its own top, before the loop that looks at its children one by one — a
 * swap landing *after* those checks pass but *before* that loop's first
 * `lstat` rides the same ancestor through to whatever a link now answers
 * with, and neither the recursive pre-check nor the file `fstat` that
 * follows ever see anything but the identity that escape exposed. The fix
 * (`openNoFollow`, `NOFOLLOW_ANY` on macOS) checks every path component at
 * the moment of the actual open, so it closes this gap wherever it lands,
 * without `regularEntries` needing to re-check `dir` once per child.
 *
 * `lstat` is patched to count calls whose path ends with the one this test
 * cares about: call 1 classifies `nested` from its parent's own loop, call 2
 * is `nested`'s own before-check, call 3 is its own after-check — passed
 * legitimately, because `nested` really was still fine at that moment. Only
 * once that third call has already resolved does the swap land, strictly
 * after both checks and strictly before the loop below ever names one of
 * `nested`'s own children.
 */
test('export leaves a nested folder out, and carries nothing from outside, when it is swapped for a link right after its own before/after checks pass, before its first child is named', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-midloop-swap-'))
  const agents = join(dir, 'agents')
  await mkdir(join(agents, 'scout', 'nested'), { recursive: true })
  await mkdir(join(agents, 'good'), { recursive: true })
  await writeFile(join(agents, 'scout', 'AGENT.md'), 'scout brief')
  await writeFile(join(agents, 'scout', 'nested', 'note.txt'), 'inside, safe')
  await writeFile(join(agents, 'good', 'AGENT.md'), 'good brief')
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'note.txt'), 'OUTSIDE SECRET')
  const suffix = join('scout', 'nested')

  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    lstat: (...args: unknown[]) => Promise<unknown>
  }
  const realLstat = fsp.lstat
  let calls = 0
  fsp.lstat = async (...args: unknown[]) => {
    const result = await realLstat(...args)
    const path = String(args[0])
    if (path.endsWith(suffix)) {
      calls += 1
      if (calls === 3) {
        await rm(path, { recursive: true, force: true })
        await symlink(outside, path)
      }
    }
    return result
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.lstat = realLstat
    syncBuiltinESMExports()
  })

  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['good', 'scout'])
  const scout = backup.agentFolders?.find((one) => one.id === 'scout')
  assert.deepEqual(scout?.files, [{ path: 'AGENT.md', text: 'scout brief' }], 'the swapped folder carried nothing')
  assert.ok(heard.said.includes('a file or folder was left out of an Agent backup'))
})

/*
 * Round 2's own review also named the walk's own top folder: before round 2
 * `regularEntries` had no `expected` identity for it at all, so neither
 * before- nor after-check ever ran there, whatever swapped it. `readdir` is
 * patched to swap right after it returns — timing that means nothing on the
 * old code (no check to land inside of) but is caught immediately by the new
 * top-folder after-check, right where round 1's own gap for a nested folder
 * used to be.
 */
test("export leaves an Agent out whole, and carries nothing from outside, when its own top folder is swapped for a link right after its readdir, before any child is named", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-top-swap-'))
  const agents = join(dir, 'agents')
  await mkdir(join(agents, 'scout'), { recursive: true })
  await mkdir(join(agents, 'good'), { recursive: true })
  await writeFile(join(agents, 'scout', 'AGENT.md'), 'scout brief')
  await writeFile(join(agents, 'good', 'AGENT.md'), 'good brief')
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'AGENT.md'), 'OUTSIDE SECRET')
  const suffix = join('agents', 'scout')

  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    readdir: (...args: unknown[]) => Promise<unknown>
  }
  const realReaddir = fsp.readdir
  let swapped = false
  fsp.readdir = async (...args: unknown[]) => {
    const result = await realReaddir(...args)
    const path = String(args[0])
    if (!swapped && path.endsWith(suffix)) {
      swapped = true
      await rm(path, { recursive: true, force: true })
      await symlink(outside, path)
    }
    return result
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.readdir = realReaddir
    syncBuiltinESMExports()
  })

  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['good'], 'the swapped Agent carried nothing and was left out whole')
  assert.ok(!(backup.agentFolders ?? []).some((one) => one.files.some((file) => file.text.includes('OUTSIDE SECRET'))))
})

/*
 * A different shape of the same finding: the ancestor is swapped only long
 * enough for the child's own classification `lstat` to read through it, then
 * put back before anything opens it. `regularEntries`' before/after checks
 * cannot see this at all — by the time either runs, `nested` reads as
 * perfectly real again — so this is round 1's own `fstat`-against-
 * classification identity check to prove: the descriptor this opens is the
 * real, restored file, and its identity does not match the outside one the
 * classification recorded, because that was never a lie the ancestor being
 * live could paper back over once the ancestor is gone again.
 */
test('export leaves a nested file out, and carries nothing from outside, when its ancestor is swapped only for the classification and restored before the open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-swap-restore-'))
  const agents = join(dir, 'agents')
  const nested = join(agents, 'scout', 'nested')
  await mkdir(nested, { recursive: true })
  await writeFile(join(agents, 'scout', 'AGENT.md'), 'scout brief')
  await writeFile(join(nested, 'note.txt'), 'inside, safe')
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'note.txt'), 'OUTSIDE SECRET')
  const suffix = join('nested', 'note.txt')

  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    lstat: (...args: unknown[]) => Promise<unknown>
  }
  const realLstat = fsp.lstat
  let swapped = false
  fsp.lstat = async (...args: unknown[]) => {
    const path = String(args[0])
    if (swapped || !path.endsWith(suffix)) return realLstat(...args)
    swapped = true
    // `path` names `.../scout/nested/note.txt`; its own directory is
    // `nested`, dropped off the end of the classification path itself so
    // the swap-and-restore below works on whichever spelling — resolved or
    // not — this specific `lstat` call actually used.
    const ancestor = dirname(path)
    await rm(ancestor, { recursive: true, force: true })
    await symlink(outside, ancestor)
    // Resolves through the live symlink: `outside/note.txt`'s own identity.
    const result = await realLstat(...args)
    await rm(ancestor, { force: true })
    await mkdir(ancestor)
    await writeFile(join(ancestor, 'note.txt'), 'inside, safe')
    return result
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.lstat = realLstat
    syncBuiltinESMExports()
  })

  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const backup = await host.call('backup/export', {})
  const scout = backup.agentFolders?.find((one) => one.id === 'scout')
  assert.deepEqual(scout?.files, [{ path: 'AGENT.md', text: 'scout brief' }], 'the swapped-then-restored file carried nothing')
})

test('export quietly skips a dangling Agent link and still carries the good Agent beside it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-dangling-agent-'))
  await mkdir(join(dir, 'agents', 'good'), { recursive: true })
  await writeFile(join(dir, 'agents', 'good', 'AGENT.md'), 'good brief')
  await symlink(join(dir, 'gone'), join(dir, 'agents', 'dangling'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const backup = await host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders?.map((one) => one.id), ['good'])
  assert.deepEqual(heard.said, [], 'a missing top-level target is not an Agent and is quiet')
})

test('export quietly skips an Agent link to a file and still carries the good Agent beside it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-file-agent-'))
  await mkdir(join(dir, 'agents', 'good'), { recursive: true })
  await writeFile(join(dir, 'agents', 'good', 'AGENT.md'), 'good brief')
  await writeFile(join(dir, 'not-a-folder'), 'plain file')
  await symlink(join(dir, 'not-a-folder'), join(dir, 'agents', 'file-link'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

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
  t.after(async () => rm(dir, { recursive: true, force: true }))

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

/**
 * P4 (final Part A review): once a folder's 1 MiB budget is spent, every file
 * behind it in the walk was still opened and read, only to be discarded once
 * `take` compared the running total against the budget — 20,000 files behind
 * a spent budget cost 20,000 wasted opens. The walk now stops opening more
 * files the moment the budget is gone, the same way it already stops once
 * `MAX_BUNDLE_FILES` files have been examined.
 */
test('export stops opening files once an Agent folder’s byte budget is already spent, rather than opening every file behind it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-budget-cost-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const agents = join(dir, 'agents')
  await mkdir(join(agents, 'skilled', 'skills'), { recursive: true })
  await writeFile(join(agents, 'skilled', 'AGENT.md'), 'brief')
  const chunk = 'x'.repeat(AGENT_FILE_LIMIT)
  // Spends the whole 1 MiB folder budget, sorting before "skills" the same way the priority test above relies on.
  for (const name of ['!a.md', '!b.md', '!c.md', '!d.md']) await writeFile(join(agents, 'skilled', name), chunk)
  // Behind the now-spent budget: files a walk with no cap on examined-vs-opened would still open every one of.
  const extra = 50
  for (let index = 0; index < extra; index += 1) {
    await writeFile(join(agents, 'skilled', 'skills', `m${String(index).padStart(3, '0')}.js`), 'x')
  }

  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    open: (...args: unknown[]) => Promise<unknown>
  }
  const realOpen = fsp.open
  let opened = 0
  fsp.open = async (...args: unknown[]) => {
    opened += 1
    return realOpen(...args)
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.open = realOpen
    syncBuiltinESMExports()
  })

  const copies = await exportAgentFolders(agents)
  assert.deepEqual(copies[0]?.files.map((one) => one.path), ['AGENT.md', '!a.md', '!b.md', '!c.md'])
  // 1 (AGENT.md) + 4 (!a..!d — !d is opened, then rejected, since it is what spends the budget) — never
  // the 50 files sitting behind it in skills/, which the old walk opened and discarded one by one.
  assert.ok(opened <= 5, `${opened} files were opened past an Agent folder’s already-spent byte budget`)
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

// The top temporary folder stays unchanged: only a restore subdirectory is
// swapped, after mkdir returns and immediately before its file is written.
// A final identity check of the top folder cannot catch this outside write.
test('restore refuses without writing outside when a subdirectory is swapped for a link before its file is written', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-restore-swap-'))
  const outside = join(dir, 'outside')
  await mkdir(outside)
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    mkdtemp: (...args: unknown[]) => Promise<string>
    mkdir: (...args: unknown[]) => Promise<unknown>
  }
  const realMkdtemp = fsp.mkdtemp
  const realMkdir = fsp.mkdir
  let temporary: string | undefined
  let swapped = false
  fsp.mkdtemp = async (...args: unknown[]) => {
    temporary = await realMkdtemp(...args)
    return temporary
  }
  fsp.mkdir = async (...args: unknown[]) => {
    const result = await realMkdir(...args)
    const path = String(args[0])
    if (!swapped && temporary && path === join(temporary, 'nested')) {
      swapped = true
      await rm(path, { recursive: true, force: true })
      await symlink(outside, path)
    }
    return result
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.mkdtemp = realMkdtemp
    fsp.mkdir = realMkdir
    syncBuiltinESMExports()
  })

  const report = await host.call('backup/import', {
    backup: backupWith([{ id: 'scout', files: [
      { path: 'AGENT.md', text: 'restored brief' },
      { path: 'nested/note.txt', text: 'restored note' },
    ] }]),
  })
  assert.ok(swapped, 'the swap this test depends on actually fired')
  const escaped = await readFile(join(outside, 'note.txt'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  assert.equal(escaped, null, 'no restore bytes land outside the canonical Agent root')
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 1 })
  assert.deepEqual(await readdir(join(dir, 'agents')), [], 'the refused temporary folder was removed and nothing was renamed into place')
  assert.deepEqual(heard.said, ['an Agent folder from a backup could not be restored'])
  assert.match(String((heard.details[0] as { error?: unknown })?.error), /replaced.*nothing was written/)
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
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
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
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
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

/**
 * P2 (final Part A review — this pinned test edited, per its brief):
 * this test's own name said "roster ids" while its body still refused
 * `Upper`, which the roster (`idsIn`) has always listed — `agentIdOf`, the
 * *writer's* slug rule for a typed name, was standing in for the roster's
 * own, looser rule (a safe segment, at most 255 bytes, not `.git`, not the
 * temp prefix — `isAgentFolderName`, now shared with `idsIn`). `Upper`,
 * `constructor` and `__proto__` are now expected restored, not skipped:
 *
 * Decision, made once here: a reserved id (`constructor`, `__proto__`) is
 * restored rather than refused. The roster already seats a hand-placed
 * folder by either name — it keys every entry in a `Map`, where neither
 * string is special — so refusing to *restore* one made the backup path
 * stricter than the roster it is restoring into, and silently dropped a real
 * Agent. `seating.json`'s own reserved-id guard (`agent-seating-file.ts`) is
 * untouched: that file's keys are a plain JSON object's own properties,
 * where `__proto__` genuinely is dangerous, which is a fact about that file,
 * not about an Agent folder's name.
 */
test('restore admits every id the roster would list, and never replaces an existing folder or writes through a link', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-agent-ids-'))
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
  t.after(async () => rm(dir, { recursive: true, force: true }))
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
  assert.deepEqual(report.agentFolders, { restored: 4, skipped: 3 })
  assert.equal(await readFile(join(agents, 'existing', 'AGENT.md'), 'utf8'), 'local folder')
  assert.equal(await readFile(join(outside, 'AGENT.md'), 'utf8'), 'linked target')
  assert.deepEqual(
    (await readdir(agents)).sort(),
    ['Upper', '__proto__', 'constructor', 'existing', 'linked', 'valid-agent'],
  )
})

/**
 * P2 (final Part A review — this pinned test edited): `Reviewer` was this
 * test's example of a refused id, refused only because restore was reading
 * it through `agentIdOf` (the writer's slug rule) instead of the roster's own
 * rule — which admits `Reviewer` outright, per the fix above. `../climber`
 * replaces it: a genuine climb, refused under the shared rule for the same
 * reason (`its id is not a valid Agent id`), so this test still proves what
 * it always meant to — a refused folder does not refuse its own valid seat.
 */
test('restore logs every refused Agent id with a reason and a quoted, capped id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-refused-id-'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const stranger = `stranger-${'x'.repeat(2_000)}`
  const report = await host.call('backup/import', {
    backup: backupWith(
      [
        { id: '../climber', files: [{ path: 'AGENT.md', text: 'brief' }] },
        { id: stranger, files: [{ path: 'AGENT.md', text: 'brief' }] },
      ],
      { '../climber': ['codex'] },
    ),
  })

  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 2 })
  assert.deepEqual(report.seating, { restored: 1, skipped: 0 }, 'a refused folder does not refuse its valid seat')
  assert.deepEqual(heard.said, [
    'an Agent folder from a backup was refused',
    'an Agent folder from a backup was refused',
  ])
  const details = heard.details as { id?: unknown; error?: unknown }[]
  assert.equal(details[0]?.id, '"../climber"')
  assert.match(String(details[0]?.error), /id/i)
  assert.equal(typeof details[1]?.id, 'string')
  assert.ok(String(details[1]?.id).length <= 160, 'the quoted id is capped before it reaches the log')
  assert.match(String(details[1]?.id), /^".*"$/s, 'the capped id remains a JSON-quoted string')
})

test('a control character in a backup id does not smuggle the logged id past its cap', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-control-char-id-'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
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

/**
 * P9 (final Part A review, "10-m1"): capping the already-quoted text fixed
 * the cap being smuggled past (above), but slicing the *quoted* string by a
 * raw character position can itself land inside a six-character `\u0000`
 * escape, leaving a torn fragment like `\u00` right before the ellipsis. The
 * cap now truncates the *raw* id first — to a prefix whose own quoted form
 * plus the ellipsis still fits — and quotes only that, so an escape is
 * always either whole or entirely absent from what is kept.
 */
test('a logged id truncated past its cap never ends with a torn escape', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-log-torn-escape-'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
  // Every one of these escapes to six characters once quoted, so the cap
  // falls inside one of them wherever it lands unless the raw text, not the
  // quoted text, is what gets cut.
  const nully = '\0'.repeat(200)
  const report = await host.call('backup/import', {
    backup: backupWith([{ id: nully, files: [{ path: 'AGENT.md', text: 'brief' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 1 })
  const details = heard.details as { id?: unknown }[]
  const logged = String(details[0]?.id)
  assert.match(logged, /…"$/, 'a truncated id still ends in an ellipsis and a closing quote')
  // Put a closing quote back where the ellipsis was cut from, and the result
  // must still be one complete, valid JSON string — never `\u00` with the
  // rest of its own escape missing.
  const beforeEllipsis = logged.slice(0, -2)
  assert.doesNotThrow(() => JSON.parse(`${beforeEllipsis}"`), 'the escape immediately before the ellipsis was torn in half')
})

/**
 * P9 (final Part A review, "10-m1"): the same slice-the-quoted-text mistake
 * can land between the two UTF-16 halves of an astral character's surrogate
 * pair — JSON.stringify leaves one unescaped, so nothing marks where it is
 * safe to cut. Truncating the raw id by whole code points first means a pair
 * is always kept whole or dropped whole, never split.
 */
test('a logged id truncated past its cap never splits an astral character’s surrogate pair', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-log-surrogate-'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
  // U+1D306, a surrogate pair, repeated well past the cap.
  const astral = '\u{1d306}'.repeat(80)
  const report = await host.call('backup/import', {
    backup: backupWith([{ id: astral, files: [{ path: 'AGENT.md', text: 'brief' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 1 })
  const details = heard.details as { id?: unknown }[]
  const logged = String(details[0]?.id)
  assert.match(logged, /…"$/, 'a truncated id still ends in an ellipsis and a closing quote')
  const inner = logged.slice(1, -2) // drop the opening quote, then the ellipsis and closing quote
  assert.ok(
    !hasLoneSurrogate(inner),
    `a surrogate pair was split by the truncation: ${JSON.stringify(inner.slice(-4))}`,
  )
})

test('an existing Agent collision is a quiet skip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-quiet-collision-'))
  await mkdir(join(dir, 'agents', 'scout'), { recursive: true })
  await writeFile(join(dir, 'agents', 'scout', 'AGENT.md'), 'local')
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const report = await host.call('backup/import', {
    backup: backupWith([{ id: 'scout', files: [{ path: 'AGENT.md', text: 'backup' }] }]),
  })
  assert.deepEqual(report.agentFolders, { restored: 0, skipped: 1 })
  assert.equal(await readFile(join(dir, 'agents', 'scout', 'AGENT.md'), 'utf8'), 'local')
  assert.deepEqual(heard.said, [])
})

test('a restored Agent folder is announced by its own explicit notice, proven on a host whose watcher was never started', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-no-watch-'))
  // `host.start()` is what makes an `AgentWatch` at all — never called here,
  // so this host's roster watch never exists. If a notice still arrives, the
  // explicit push inside `backup/import` sent it: proof that does not lean
  // on the watcher's own 150 ms settle (`SETTLE_MS`, agent-watch.ts) losing a
  // race it was never even entered into.
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
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
  const seatingTemp = join(dir, `seating.json.${process.pid}.tmp`)
  await mkdir(seatingTemp)
  const heard = new Heard([], (message) => {
    if (message === 'a seating entry from a backup could not be restored') {
      rmSync(seatingTemp, { recursive: true, force: true })
    }
  })
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    open: (...args: unknown[]) => Promise<FileHandle>
  }
  const realOpen = fsp.open
  fsp.open = async (...args) => {
    const handle = await realOpen(...args)
    if (String(args[0]).endsWith('/fault.md')) {
      // Agent content is written through the opened descriptor. Fail that
      // write, preserving coverage of its finally-close and folder cleanup.
      handle.writeFile = async () => {
        throw Object.assign(new Error('injected Agent backup write failure'), { code: 'EIO' })
      }
    }
    return handle
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.open = realOpen
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
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'seating.json'), 'utf8')), { $revision: 1, later: ['codex'] })
  assert.ok(heard.said.includes('an Agent folder from a backup could not be restored'))
  assert.ok(heard.said.includes('a seating entry from a backup could not be restored'))
})

test('an absent seating file is quiet, but an unreadable one is left out with a warning', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-seating-raw-'))
  const heard = new Heard()
  const { host } = await hostAt(dir, { logger: heard })
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

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
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))

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
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  t.after(async () => rm(dir, { recursive: true, force: true }))
  await assert.rejects(
    host.call('backup/import', { backup: { some: 'other json file' } }),
    /not a HarnessDesk backup/,
  )
})

test('the host carries provenance as historical observations and deduplicates a second restore', async (t) => {
  const firstDir = await mkdtemp(join(tmpdir(), 'provenance-backup-first-'))
  const secondDir = await mkdtemp(join(tmpdir(), 'provenance-backup-second-'))
  const first = await hostAt(firstDir)
  const second = await hostAt(secondDir)
  t.after(() => first.host.dispose())
  t.after(() => second.host.dispose())
  t.after(async () => rm(firstDir, { recursive: true, force: true }))
  t.after(async () => rm(secondDir, { recursive: true, force: true }))
  const backup = await first.host.call('backup/export', {})
  assert.deepEqual(backup.provenance, { version: 1, projects: [] })
  const carried = {
    ...backup,
    provenance: {
      version: 1,
      projects: [{
        project: '/work/project',
        entries: [{ kind: 'gap', value: { id: 'historical-gap', reason: 'history-gap', from: null, to: 10 } }],
      }],
    },
  }
  const restored = await second.host.call('backup/import', { backup: carried })
  assert.deepEqual(restored.provenance, { restored: 1, duplicate: 0, refused: 0 })
  const again = await second.host.call('backup/import', { backup: carried })
  assert.deepEqual(again.provenance, { restored: 0, duplicate: 1, refused: 0 })
  const exported = await second.host.call('backup/export', {})
  const entry = exported.provenance?.projects[0]?.entries[0] as { value: { restoredAt: number } }
  assert.equal(typeof entry.value.restoredAt, 'number')
})

// ------------------------------------------------------------- findings (phase 7)
/*
 * Named addition for the findings ledger: a backup carries finding events
 * with their details, a restore marks each one history, and nothing about it
 * resumes — a staged carry is dropped with the rest of a restored Goal's
 * journal, a restored confirmation clears nothing, and a restored receipt
 * cannot be carried from.
 */
test('restored findings retain details without live operations', async () => {
  const source = await mkdtemp(join(tmpdir(), 'hd-backup-findings-source-'))
  const target = await mkdtemp(join(tmpdir(), 'hd-backup-findings-target-'))
  try {
    const A = 'a'.repeat(40)
    const id = 'finding-00000000-0000-4000-8000-000000000001'
    const origin = { goal: 'portable-goal', run: 'run-1', round: 1, card: 1, seat: 'seat-r', at: A }
    const records: EvidenceRecord[] = [
      { id: 'raise-1', fact: { kind: 'finding', id, state: 'open', at: A }, card: { board: 'portable-goal', id: 1 }, checkout: null, seat: 'seat-r', round: 1, observedAt: 1, posted: null,
        finding: { version: 1, sequence: 1, operation: 'op-1', origin, event: { kind: 'raise', title: 'Unbounded retry', body: 'It never stops.', category: 'security', blocking: true, related: null, anchor: { path: 'src/a.ts', line: 3, side: 'RIGHT' } } } },
      { id: 'withdraw-1', fact: { kind: 'finding', id, state: 'withdrawn', at: A }, card: { board: 'portable-goal', id: 1 }, checkout: null, seat: null, round: 1, observedAt: 2, posted: null,
        finding: { version: 1, sequence: 2, operation: 'op-2', origin, event: { kind: 'verdict', state: 'withdrawn', note: 'Not a bug.', by: 'person' } } },
    ]
    const port = { board: () => null, cwdOf: () => null, push: () => {}, log: () => {} }
    const from = new EvidencePlane({ dir: join(source, 'evidence'), seenFile: join(source, 'seen.json') }, port)
    await from.store.append('/work/repo', 'evidence', records.map((record) => ({ type: 'evidence', record }) as const))
    const into = new EvidencePlane({ dir: join(target, 'evidence'), seenFile: join(target, 'seen.json') }, port)
    const count = await into.restore(await from.backup())
    assert.equal(count.restored, 2)
    const back = (await into.store.read('/work/repo', 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
    assert.deepEqual(back.map((record) => record.finding), records.map((record) => record.finding), 'every detail travelled')
    assert.ok(back.every((record) => record.restored), 'and every event is marked history')
    const [view] = foldFindings(back)
    assert.equal(view!.title, 'Unbounded retry')
    assert.equal(view!.restored, true)
    assert.equal(isResolved(view!), false, 'a restored withdrawal clears nothing here')

    // A Goal wrapped while a carry was staged in another Goal: restored, its journal is gone and nothing replays.
    await migrateDesk(source, async () => {})
    await migrateDesk(target, async () => {})
    const goals = new GoalStore(source)
    await goals.load()
    const carrying: GoalDocument = {
      version: 1, goal: goal('carrying-goal', { revision: 0 }), board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
      citations: [], receipt: null,
      operation: { kind: 'carry', id: 'carry-1', goal: 'carrying-goal', source: 'portable-goal', receipt: 'receipt-1', dependsOn: ['portable-goal'], records: [] },
    }
    await goals.save(carrying, null)
    const restoredGoals = new GoalStore(target)
    await restoredGoals.load()
    assert.equal(await restoredGoals.restore(goals.read('carrying-goal'), 50), 'restored')
    assert.equal(restoredGoals.read('carrying-goal').operation, null, 'a restored carry is not resumed')
    assert.deepEqual(restoredGoals.read('carrying-goal').goal.dependsOn, [], 'and its dependency was never applied')
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ intake (phase 8)
/*
 * Named addition for trigger consent: arming is this machine's and this
 * person's alone. A backup carries a project's declarations only as the
 * repository content they already are — never an arm, a signing key or a
 * source cursor — and nothing in a backup, however it is crafted, restores
 * one as live state.
 */
test('restore never arms a trigger', async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), 'hd-backup-trigger-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'hd-backup-trigger-b-'))
  t.after(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  })
  const a = await hostAt(dirA)
  t.after(() => a.host.dispose())
  const armedHere = triggerRig({ home: dirA })
  const preview = await armedHere.consent.preview(armedHere.world.project, 'review')
  await armedHere.consent.arm(armedHere.world.project, 'review', preview.token!)
  assert.ok(await armedHere.consent.binding(armedHere.world.project, 'review'))
  const machineFile = await readFile(join(dirA, 'triggers-machine.json'), 'utf8')
  const key = (await readFile(join(dirA, 'triggers-key.bin'), 'utf8')).trim()

  const backup = await a.host.call('backup/export', {})
  const exported = JSON.stringify(backup)
  assert.ok(!exported.includes(key), 'the signing key never travels')
  assert.ok(!exported.includes('"signature"'), 'no signed arm travels')
  assert.ok(!exported.includes(machineFile), 'the consent file never travels')

  // A crafted backup that carries the whole consent file, and the key, in every place a restore reads.
  const crafted = {
    ...backup,
    preferences: { ...backup.preferences, triggers: JSON.parse(machineFile), 'triggers-key': key, triggerConsent: { review: true } },
    triggers: JSON.parse(machineFile),
  }
  const b = await hostAt(dirB)
  t.after(() => b.host.dispose())
  await b.host.call('backup/import', { backup: crafted })
  // Nothing on the restored desk arms, polls or opens anything for it.
  await assert.rejects(readFile(join(dirB, 'triggers-machine.json'), 'utf8'), /ENOENT/)
  await assert.rejects(readFile(join(dirB, 'triggers-key.bin'), 'utf8'), /ENOENT/)
  const restored = triggerRig({ home: dirB })
  assert.equal(await restored.consent.binding(restored.world.project, 'review'), null)
  assert.deepEqual(await restored.consent.armed(), [], 'no current arm, so nothing is polled')
  const view = (await restored.consent.list(restored.world.project)).triggers.find((one) => one.id === 'review')
  assert.equal(view?.state, 'off')
  const goals = await b.host.call('goal/list', {})
  assert.equal(goals.filter((one) => one.goal.origin.kind === 'trigger').length, 0, 'no Goal is reserved for it')
})

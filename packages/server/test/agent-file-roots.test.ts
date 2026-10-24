import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AgentFileRoots, type AgentFileReads } from '../src/agent-file-roots.js'

/**
 * The roster's folders as places a file may be read or written by path, read
 * off the host's thread, once, and kept.
 *
 * Every test here uses a disk made of tables, so what is asked of it can be
 * counted and what it answers can be held back — the way a linked folder on a
 * volume that has stopped answering holds a real one.
 */

const USER = '/state/agents'
const BUILTIN = '/app/agents'
const ROOTS = { user: USER, builtin: BUILTIN }

interface Entry {
  readonly name: string
  readonly dir?: boolean
  readonly link?: boolean
}

const listing = (entries: readonly Entry[]) =>
  entries.map((entry) => ({
    name: entry.name,
    isDirectory: () => entry.dir ?? false,
    isSymbolicLink: () => entry.link ?? false,
  }))

const fakeDisk = (tree: Record<string, Entry[]>, sources: readonly string[] = []) => {
  const asked: string[] = []
  let held: Promise<void> | undefined
  const reads: AgentFileReads = {
    entries: async (folder) => {
      asked.push(`entries ${folder}`)
      // What is there when it is asked, not when the disk gets round to answering.
      const found = tree[folder]
      await held
      if (found === undefined) throw Object.assign(new Error(`${folder} is not here`), { code: 'ENOENT' })
      return listing(found)
    },
    isFile: async (path) => {
      asked.push(`isFile ${path}`)
      return sources.includes(path)
    },
  }
  return {
    reads,
    asked,
    tree,
    /** Stops answering listings until the returned function is called. */
    hold: (): (() => void) => {
      let open!: () => void
      held = new Promise<void>((resolve) => { open = resolve })
      return () => {
        held = undefined
        open()
      }
    },
  }
}

const listingsAsked = (disk: { asked: readonly string[] }): string[] => disk.asked.filter((one) => one.startsWith('entries '))

const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now()
  const value = await run()
  return { value, ms: performance.now() - started }
}

test('the roster\'s roots are this machine\'s and the built-in one, with each Agent folder and the source it links to', async () => {
  const disk = fakeDisk(
    {
      [USER]: [
        { name: 'reviewer', dir: true },
        { name: 'scout', link: true },
        { name: 'notes.txt' },
        { name: '.git', dir: true },
        { name: '.harnessdesk-agent-half-written', dir: true },
      ],
      [BUILTIN]: [{ name: 'helper', dir: true }],
    },
    [`${USER}/scout/AGENT.md`, `${BUILTIN}/helper/AGENT.md`],
  )
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads })
  assert.deepEqual(await roots.list('read'), [
    USER,
    `${USER}/reviewer`,
    `${USER}/scout`,
    `${USER}/scout/AGENT.md`,
    BUILTIN,
    `${BUILTIN}/helper`,
    `${BUILTIN}/helper/AGENT.md`,
  ])
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`, `${USER}/scout`, `${USER}/scout/AGENT.md`])
})

test('the built-in root is never listed for a write', async () => {
  const disk = fakeDisk({ [USER]: [], [BUILTIN]: [{ name: 'helper', dir: true }] })
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads })
  assert.deepEqual(await roots.list('write'), [USER])
  assert.deepEqual(listingsAsked(disk), [`entries ${USER}`])
})

test('a root that cannot be listed is a root with nothing linked into it', async () => {
  const disk = fakeDisk({})
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads })
  assert.deepEqual(await roots.list('read'), [USER, BUILTIN])
})

test('an Agent folder whose source cannot be read is a folder without its source', async () => {
  const disk = fakeDisk({ [USER]: [{ name: 'reviewer', dir: true }], [BUILTIN]: [] })
  const roots = new AgentFileRoots({
    roots: () => ROOTS,
    reads: { ...disk.reads, isFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } },
  })
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`])
})

test('a reading stands until its time is up', async () => {
  const disk = fakeDisk({ [USER]: [{ name: 'reviewer', dir: true }], [BUILTIN]: [] })
  let clock = 1_000
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads, ttlMs: 500, now: () => clock })
  await roots.list('read')
  const first = disk.asked.length
  clock += 499
  await roots.list('read')
  assert.equal(disk.asked.length, first, 'a request inside the time is answered from the reading already taken')
  clock += 1
  await roots.list('read')
  assert.ok(disk.asked.length > first, 'a request when the time is up reads again')
})

test('the roster changing ends a reading at once', async () => {
  const disk = fakeDisk({ [USER]: [{ name: 'reviewer', dir: true }], [BUILTIN]: [] })
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads, ttlMs: 60_000 })
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`])
  disk.tree[USER] = [{ name: 'reviewer', dir: true }, { name: 'scout', dir: true }]
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`], 'nothing has said the roster changed')
  roots.invalidate()
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`, `${USER}/scout`])
})

test('a reading that was in flight when the roster changed is not kept as current', async () => {
  const disk = fakeDisk({ [USER]: [{ name: 'reviewer', dir: true }], [BUILTIN]: [] })
  const open = disk.hold()
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads, ttlMs: 60_000 })
  const before = roots.list('write')
  disk.tree[USER] = [{ name: 'reviewer', dir: true }, { name: 'scout', dir: true }]
  roots.invalidate()
  open()
  assert.deepEqual(await before, [USER, `${USER}/reviewer`], 'a request that began before the change is answered with the roster it began with')
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`, `${USER}/scout`], 'the next one reads the roster as it is')
})

test('requests at the same moment share one reading', async () => {
  const disk = fakeDisk({ [USER]: [{ name: 'reviewer', dir: true }], [BUILTIN]: [] })
  const open = disk.hold()
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads })
  const answers = Promise.all([roots.list('read'), roots.list('read'), roots.list('read'), roots.list('write')])
  open()
  const [first, ...rest] = await answers
  for (const answer of rest.slice(0, 2)) assert.deepEqual(answer, first)
  assert.deepEqual(listingsAsked(disk), [`entries ${USER}`, `entries ${BUILTIN}`], 'each root is listed once, however many asked')
})

test('a disk that does not answer costs one request the wait, and the others no more', { timeout: 10_000 }, async () => {
  const disk = fakeDisk({ [USER]: [{ name: 'reviewer', dir: true }], [BUILTIN]: [] })
  const open = disk.hold()
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads, waitMs: 200 })
  const first = await timed(() => roots.list('write'))
  assert.deepEqual(first.value, [USER], 'a folder not yet seen is not admitted')
  assert.ok(first.ms >= 150, `the first request waited for the reading (${first.ms.toFixed(0)}ms)`)
  const second = await timed(() => roots.list('write'))
  assert.deepEqual(second.value, [USER])
  assert.ok(second.ms < 100, `the next one does not wait for a reading already late (${second.ms.toFixed(0)}ms)`)
  assert.deepEqual(listingsAsked(disk), [`entries ${USER}`], 'and does not ask the stopped disk again beside it')
  open()
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`], 'a late reading is kept when it lands')
})

test('a reading gone stale answers while a newer one is read', { timeout: 10_000 }, async () => {
  const disk = fakeDisk({ [USER]: [{ name: 'reviewer', dir: true }], [BUILTIN]: [] })
  let clock = 0
  const roots = new AgentFileRoots({ roots: () => ROOTS, reads: disk.reads, ttlMs: 100, waitMs: 100, now: () => clock })
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`])
  clock += 100
  disk.hold()
  assert.deepEqual(await roots.list('write'), [USER, `${USER}/reviewer`], 'the last reading, not the root alone')
})

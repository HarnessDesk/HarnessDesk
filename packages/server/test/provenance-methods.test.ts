import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { CaptureHealth, SeatRecord } from '@harnessdesk/protocol'

import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import type { HostContext } from '../src/methods/context.js'
import { provenanceMethods } from '../src/methods/provenance.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { makeRepo } from './fixtures/provenance-repo.js'
import { Host, serve } from '../src/index.js'
import { Logger } from '../src/log.js'
import { StateStore } from '../src/state.js'
import { tempDir } from './scratch.js'
import { Client } from './fixtures/harness.js'

const health: CaptureHealth = {
  project: '/work/project', enabled: false, state: 'stopped', reason: 'Capture is off on this machine.',
  nextStep: 'Turn capture on.', checkedAt: null, lastCapturedAt: null, pending: 0, gaps: 0, revision: 1,
}

const waitForProject = async (host: Host, root: string, project: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const status = await host.call('provenance/status', { root }).catch(() => null)
    if (status?.[0]?.project === project) return
    await delay(20)
  }
  assert.fail(`Timed out waiting for ${project} to register from ${root}`)
}

test('every named-root handler confines before reaching its narrow provenance port', async () => {
  const calls: unknown[] = []
  const ctx = {
    workspaces: { confineProvenanceRoot: async (root: string) => { calls.push(['confine', root]); return '/work/project' } },
    provenance: {
      read: async (root: string, shas: readonly string[]) => {
        calls.push(['read', root, shas])
        return { project: root, revision: 1, health, commits: [] }
      },
      status: async (root?: string) => { calls.push(['status', root]); return [health] },
      setCapture: async (root: string, enabled: boolean) => { calls.push(['capture', root, enabled]); return health },
      retry: async (root: string) => { calls.push(['retry', root]); return health },
      seat: async (root: string, seat: string) => {
        calls.push(['seat', root, seat])
        return { seat: null, session: null, unavailable: 'Unavailable.' }
      },
    },
  } as unknown as HostContext
  await provenanceMethods['provenance/commits'](ctx, { root: '/alias', shas: [] })
  await provenanceMethods['provenance/status'](ctx, { root: '/alias' })
  await provenanceMethods['provenance/capture'](ctx, { root: '/alias', enabled: false })
  await provenanceMethods['provenance/retry'](ctx, { root: '/alias' })
  await provenanceMethods['provenance/seat'](ctx, { root: '/alias', seat: 'seat-1' })
  await provenanceMethods['provenance/status'](ctx, {})
  assert.deepEqual(calls, [
    ['confine', '/alias'], ['read', '/work/project', []],
    ['confine', '/alias'], ['status', '/work/project'],
    ['confine', '/alias'], ['capture', '/work/project', false],
    ['confine', '/alias'], ['retry', '/work/project'],
    ['confine', '/alias'], ['seat', '/work/project', 'seat-1'],
    ['status', undefined],
  ])
})

test('a confinement refusal never reaches the provenance service', async () => {
  let reads = 0
  const ctx = {
    workspaces: { confineProvenanceRoot: async () => { throw new Error('outside workspace') } },
    provenance: { read: async () => { reads += 1 } },
  } as unknown as HostContext
  await assert.rejects(provenanceMethods['provenance/commits'](ctx, { root: '/outside', shas: [] }), /outside workspace/)
  assert.equal(reads, 0)
})

test('indexed reads dedupe in order, never queue while off, and preserve historical Seat identity', async (t) => {
  const repo = await makeRepo()
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const seat: SeatRecord = {
    id: 'original', agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: 'Recorded seat',
    passedOver: [], standing: { kind: 'permission', permission: 'read' }, ceiling: null,
    checkout: { cwd: repo.dir, project: repo.dir, branch: null, head: null },
    session: { runtime: 'fixture', sessionId: 'original-session' }, board: null, role: null,
    openedAt: 1, closed: null,
  }
  const records = new Map<string, SeatRecord>([
    [seat.id, seat], ['foreign', { ...seat, id: 'foreign', checkout: { ...seat.checkout, project: '/work/other' } }],
    ['deleted', { ...seat, id: 'deleted', closed: { at: 2, why: 'deleted' } }],
    ['restored', { ...seat, id: 'restored', restored: { at: 3 } }],
  ])
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: (id: string) => records.get(id) ?? null } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => [repo.dir], push: () => {}, log: () => {},
  })
  t.after(() => plane.close())
  await plane.start()
  const deadline = Date.now() + 10000
  while (!(await plane.status()).length) {
    assert.ok(Date.now() < deadline, 'project registration completed')
    await delay(10)
  }
  await plane.setCapture(repo.dir, false)
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const read = await plane.read(repo.dir, [b, a, b])
  assert.deepEqual(read.commits.map((commit) => commit.sha), [b, a])
  assert.ok(read.commits.every((commit) => commit.state === 'unattributed' && commit.reason === 'capture-off'))
  assert.equal(read.health.pending, 0)
  assert.deepEqual((await plane.seat(repo.dir, 'original')).session, seat.session)
  assert.equal((await plane.seat(repo.dir, 'foreign')).seat, null)
  assert.equal((await plane.seat(repo.dir, 'missing')).seat, null)
  assert.equal((await plane.seat(repo.dir, 'deleted')).unavailable, 'Its conversation was deleted.')
  assert.equal((await plane.seat(repo.dir, 'restored')).session, null)
  await assert.rejects(plane.read(repo.dir, Array(1001).fill(a)), /at most 1000/)
  await assert.rejects(plane.read(repo.dir, ['HEAD']), /full object id/)
  await assert.rejects(plane.status('/outside'), /not registered/)
  await plane.setCapture(repo.dir, true)
  const pending = await plane.read(repo.dir, [a])
  assert.equal(pending.commits[0]?.state, 'pending')
  assert.equal(pending.commits[0]?.reason, 'catching-up')
  assert.deepEqual(pending.commits[0]?.seats, [])
  assert.ok(pending.revision > read.revision)
})


test('Host.call reaches the real built provenance context without starting a runtime or listener', async () => {
  const host = new Host({
    state: new StateStore(join(tempDir('provenance-host-'), 'state.json')),
    logger: new Logger('test', { level: 'error', console: false }),
    catalogRefreshMs: 0,
  })
  try {
    assert.deepEqual(await host.call('provenance/status', {}), [])
    await assert.rejects(host.call('provenance/seat', { root: '/outside', seat: 'seat-1' }))
  } finally {
    await host.dispose()
  }
})

test('a linked-only workspace captures through its canonical project controls', async () => {
  const repo = await makeRepo()
  const head = await repo.commitTree(null, { 'work.ts': 'export const work = true\n' }, 'head')
  await repo.git('update-ref', 'refs/heads/main', head)
  const linked = join(repo.stateDir, 'linked-checkout')
  await repo.git('worktree', 'add', '--detach', linked, head)
  const host = new Host({
    state: new StateStore(join(repo.stateDir, 'state.json')),
    logger: new Logger('test', { level: 'error', console: false }),
    catalogRefreshMs: 0,
  })
  try {
    await host.start()
    await host.call('workspace/open', { path: linked })
    await waitForProject(host, repo.dir, repo.dir)
    await waitForProject(host, linked, repo.dir)
    assert.equal((await host.call('provenance/status', { root: linked }))[0]?.project, repo.dir)
    const capture = await host.call('provenance/capture', { root: linked, enabled: false })
    assert.equal(capture.project, repo.dir)
    assert.equal((await host.call('provenance/status', { root: repo.dir }))[0]?.enabled, false)
    await host.call('provenance/capture', { root: repo.dir, enabled: true })
    assert.equal((await host.call('provenance/retry', { root: linked })).project, repo.dir)
  } finally {
    await host.dispose()
  }
})

test('an ordinary nested workspace root reaches canonical provenance controls', async () => {
  const repo = await makeRepo()
  const head = await repo.commitTree(null, { 'work.ts': 'export const work = true\n' }, 'head')
  await repo.git('update-ref', 'refs/heads/main', head)
  const nested = join(repo.dir, 'nested')
  await mkdir(nested)
  const host = new Host({
    state: new StateStore(join(repo.stateDir, 'state.json')),
    logger: new Logger('test', { level: 'error', console: false }),
    catalogRefreshMs: 0,
  })
  try {
    await host.start()
    await host.call('workspace/open', { path: nested })
    await waitForProject(host, nested, repo.dir)
    assert.equal((await host.call('provenance/capture', { root: nested, enabled: false })).project, repo.dir)
    assert.equal((await host.call('provenance/commits', { root: nested, shas: [head] })).project, repo.dir)
    assert.equal((await host.call('provenance/seat', { root: nested, seat: 'missing' })).unavailable,
      'This Seat record is unavailable in this project.')
    await host.call('provenance/capture', { root: nested, enabled: true })
    assert.equal((await host.call('provenance/retry', { root: nested })).project, repo.dir)
  } finally {
    await host.dispose()
  }
})

test('relative provenance roots are refused by the wire and direct host calls', async (t) => {
  const repo = await makeRepo()
  const head = await repo.commitTree(null, { 'work.ts': 'export const work = true\n' }, 'head')
  await repo.git('update-ref', 'refs/heads/main', head)
  const linked = join(repo.stateDir, 'linked-checkout')
  await repo.git('worktree', 'add', '--detach', linked, head)
  const host = new Host({
    state: new StateStore(join(repo.stateDir, 'state.json')),
    logger: new Logger('test', { level: 'error', console: false }),
    catalogRefreshMs: 0,
  })
  await host.start()
  const server = await serve({ host, logger: new Logger('test', { level: 'error', console: false }), port: 0 })
  const client = await Client.connect(server)
  t.after(async () => { client.close(); await server.close(); await host.dispose() })
  await host.call('workspace/open', { path: linked })
  await waitForProject(host, linked, repo.dir)
  const root = relative(process.cwd(), repo.dir)
  const wireCalls = [
    ['provenance/commits', { root, shas: [head] }],
    ['provenance/status', { root }],
    ['provenance/capture', { root, enabled: false }],
    ['provenance/retry', { root }],
    ['provenance/seat', { root, seat: 'missing' }],
  ] as const
  for (const [method, params] of wireCalls) {
    await assert.rejects(client.call(method, params), /not an absolute path/)
  }
  await assert.rejects(host.call('provenance/commits', { root, shas: [head] }), /not an absolute path/)
  await assert.rejects(host.call('provenance/status', { root }), /not an absolute path/)
  await assert.rejects(host.call('provenance/capture', { root, enabled: false }), /not an absolute path/)
  await assert.rejects(host.call('provenance/retry', { root }), /not an absolute path/)
  await assert.rejects(host.call('provenance/seat', { root, seat: 'missing' }), /not an absolute path/)
  await assert.equal((await host.call('provenance/status', { root: linked }))[0]?.enabled, true)
})

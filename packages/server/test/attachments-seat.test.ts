import assert from 'node:assert/strict'
import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { McpServerSpec } from '@harnessdesk/agent-inventory'
import type {
  AttachmentDeclaration,
  AttachmentIdentity,
  AttachmentSupport,
  SessionAttachmentReceipt,
} from '@harnessdesk/protocol'

import { bundleDigest, mcpIdentityDigest, type BundleFile } from '../src/attachments/catalog.js'
import { AttachmentsPlane, HeldBeyondFilterError, UnsuppressedAutoLoadError, type AttachmentSubject, type AttachmentsPlanePort, type ResolvedForPlane } from '../src/attachments/plane.js'
import { tempDir } from './scratch.js'
import { seat } from './fixtures/goals.js'

/**
 * The one transaction every Seat's attachments go through: prepare, then
 * (once a caller opened a session and read it back) record — and, for a
 * Seat that is reopened, reapply. Every test here proves isolation and
 * refusal as hard as the happy path — a Seat's attachments are exactly as
 * much its own as its checkout is.
 *
 * Identities are content-backed: a skill's digest is the real bundle digest
 * of the bytes the port hands back with it, and a server's is the real
 * identity digest of its spec — the plane stages and verifies both, so a
 * made-up digest would (rightly) never load.
 */

const content = new Map<string, ResolvedForPlane>()

const skillFiles = (name: string, seed: string): BundleFile[] => [{ path: 'SKILL.md', bytes: Buffer.from(`---\nname: ${name}\n---\n${seed}\n`) }]
const serverSpec = (name: string, seed: string): McpServerSpec => ({ name, transport: 'stdio', command: 'node', args: [seed] })

/** An identity whose digest is the real digest of content this file keeps, keyed by `seed` so two seeds are two contents. */
const identity = (overrides: { kind?: 'skill' | 'mcp'; name?: string; seed?: string; source?: 'agent' | 'library' } = {}): AttachmentIdentity => {
  const kind = overrides.kind ?? 'skill'
  const name = overrides.name ?? 'demo'
  const seed = overrides.seed ?? 'a'
  const files = kind === 'skill' ? skillFiles(name, seed) : []
  const server = kind === 'mcp' ? serverSpec(name, seed) : null
  const made: AttachmentIdentity = {
    kind,
    name,
    digest: kind === 'skill' ? bundleDigest(files) : mcpIdentityDigest(server!),
    source: overrides.source ?? (kind === 'skill' ? 'agent' : 'library'),
    pathLabel: `~/${name}`,
  }
  content.set(`${kind}:${name}:${made.digest}`, { identity: made, files, server })
  return made
}

const declaration = (id: AttachmentIdentity, overrides: Partial<AttachmentDeclaration> = {}): AttachmentDeclaration => ({
  kind: id.kind,
  name: id.name,
  identity: id,
  problem: null,
  ...overrides,
})

const subject = (overrides: Partial<AttachmentSubject> = {}): AttachmentSubject => ({
  project: '/project',
  incarnation: 'incarnation-a',
  agent: 'scout',
  origin: 'project',
  agentDigest: 'agent-digest',
  runtime: 'claude',
  build: '1.0.0',
  ceiling: 'merge',
  ...overrides,
})

const support: AttachmentSupport = {
  runtime: 'claude',
  build: '1.0.0',
  skills: 'scoped',
  mcp: 'scoped-gated',
  suppressUnapproved: true,
  reason: null,
}

interface PortFixture extends AttachmentsPlanePort {
  readonly permitted: Set<string>
}

/** A port whose `resolve` hands back, for every declared identity, exactly the content that identity was made from. */
const portFor = (declarations: Record<string, readonly AttachmentDeclaration[]>, overrides: Partial<AttachmentsPlanePort> = {}): PortFixture => {
  const permitted = new Set<string>()
  return {
    permitted,
    resolve: async (s) => {
      const found = declarations[s.agent] ?? []
      const resolved = found.flatMap((one) =>
        one.identity ? [content.get(`${one.identity.kind}:${one.identity.name}:${one.identity.digest}`)!] : [],
      )
      return { declarations: found, resolved }
    },
    permits: async (s, id) => permitted.has(`${s.agent}:${id.kind}:${id.name}:${id.digest}:${s.build}`),
    support: () => support,
    suppressUnapproved: async () => true,
    ...overrides,
  }
}

const permit = (port: PortFixture, s: AttachmentSubject, id: AttachmentIdentity): void => {
  port.permitted.add(`${s.agent}:${id.kind}:${id.name}:${id.digest}:${s.build}`)
}

test("two Seats keep disjoint frozen inputs", async () => {
  const idA = identity({ name: 'skill-a', seed: 'a' })
  const idB = identity({ name: 'skill-b', seed: 'b' })
  const port = portFor({ 'agent-a': [declaration(idA)], 'agent-b': [declaration(idB)] })
  permit(port, subject({ agent: 'agent-a' }), idA)
  permit(port, subject({ agent: 'agent-b' }), idB)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-disjoint-'), port)

  const preparedA = await plane.prepare(subject({ agent: 'agent-a' }))
  const preparedB = await plane.prepare(subject({ agent: 'agent-b' }))

  assert.deepEqual(preparedA.input.skills?.map((one) => one.name), ['skill-a'])
  assert.deepEqual(preparedB.input.skills?.map((one) => one.name), ['skill-b'])
  // Mutating one caller's own result must never reach the other's.
  ;(preparedA.input.skills as unknown[]).push({ name: 'skill-b', digest: idB.digest, path: 'x' })
  const preparedBAgain = await plane.prepare(subject({ agent: 'agent-b' }))
  assert.deepEqual(preparedBAgain.input.skills?.map((one) => one.name), ['skill-b'])
})

test('changed bundle needs review', async () => {
  const original = identity({ seed: 'original' })
  const changed = identity({ seed: 'changed' })
  let current = original
  const base = portFor({})
  const port: PortFixture = {
    ...base,
    resolve: async () => ({ declarations: [declaration(current)], resolved: [content.get(`skill:demo:${current.digest}`)!] }),
  }
  permit(port, subject(), original) // only the original bytes were ever approved
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-changed-'), port)

  const before = await plane.prepare(subject())
  assert.deepEqual(before.declarations[0]!.problem, null)
  assert.deepEqual(before.input.skills?.map((one) => one.digest), [original.digest])

  current = changed
  const after = await plane.prepare(subject())
  assert.equal(after.input.skills?.length, 0, 'the changed bundle never reaches the isolated input')
  assert.match(after.declarations[0]!.problem ?? '', /Review this content/)
})

test('unapproved default repository content is suppressed', async () => {
  const id = identity()
  const port = portFor({ scout: [declaration(id)] })
  // Never approved.
  const suppressible = new AttachmentsPlane(tempDir('hd-attach-seat-suppress-ok-'), port)
  const prepared = await suppressible.prepare(subject())
  assert.equal(prepared.input.skills?.length, 0)
  assert.match(prepared.declarations[0]!.problem ?? '', /Review this content/)

  const unsuppressible = new AttachmentsPlane(
    tempDir('hd-attach-seat-suppress-refuse-'),
    portFor({ scout: [declaration(id)] }, { suppressUnapproved: async () => false }),
  )
  await assert.rejects(unsuppressible.prepare(subject()), UnsuppressedAutoLoadError)
})

test('readback has to match', async () => {
  const id = identity({ seed: 'real' })
  const port = portFor({ scout: [declaration(id)] })
  permit(port, subject(), id)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-readback-'), port)
  const prepared = await plane.prepare(subject())
  assert.deepEqual(prepared.input.skills?.map((one) => one.digest), [id.digest])

  const claimedDifferent: SessionAttachmentReceipt = {
    key: prepared.input.key,
    loaded: [{ kind: 'skill', name: 'demo', digest: 'f'.repeat(64) }],
    refused: [],
  }
  const record = await plane.record(seat('seat-1'), prepared, claimedDifferent)
  assert.equal(record.results[0]!.status, 'not-loaded')
  assert.match(record.results[0]!.reason ?? '', /different content/)
  assert.equal(plane.liveServersFor('seat-1' as never), null)
})

test('plain start is unchanged', async () => {
  // An Agent with genuinely nothing declared: the port's own `resolve` for
  // *this* subject answers with nothing, proving the plain path produces no
  // input and no declarations without needing to special-case it here — the
  // guard this test really pins is one level up, in the caller that decides
  // whether `record` is worth calling at all (see the integration note in
  // `methods/agents.ts`): a Seat with nothing prepared must never get an
  // attachment sidecar written for it.
  const folder = tempDir('hd-attach-seat-plain-')
  const plane = new AttachmentsPlane(folder, portFor({}))
  const prepared = await plane.prepare(subject())
  assert.deepEqual(prepared.declarations, [])
  assert.deepEqual(prepared.input, { key: prepared.input.key, skills: null, mcp: null })
  assert.equal(await plane.read('never-called-record' as never), null, 'no sidecar exists when record was never called')
  assert.deepEqual(await readdir(folder), [], 'nothing is staged for an Agent that declares nothing')
})

test('a skill and a server that share a name are matched by kind, never by name alone', async () => {
  const skillId = identity({ kind: 'skill', name: 'foo', seed: 'skill' })
  const mcpId = identity({ kind: 'mcp', name: 'foo', seed: 'server' })
  const declarations = [declaration(skillId), declaration(mcpId)]

  // Only the skill loaded; the server did not. The server must not ride in on the skill's name.
  const port = portFor({ scout: declarations })
  permit(port, subject(), skillId)
  permit(port, subject(), mcpId)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-kind-'), port)
  const prepared = await plane.prepare(subject())
  const record = await plane.record(seat('seat-kind'), prepared, {
    key: prepared.input.key,
    loaded: [{ kind: 'skill', name: 'foo', digest: skillId.digest }],
    refused: [{ kind: 'mcp', name: 'foo', reason: 'gateway down' }],
  })
  assert.deepEqual(
    record.results.map((one) => `${one.identity.kind}:${one.status}`),
    ['skill:loaded', 'mcp:not-loaded'],
  )
  assert.deepEqual(plane.liveServersFor('seat-kind' as never) ?? [], [], 'a server the runtime refused is never live because a skill of the same name loaded')

  // And the other way round: the server loaded, and its live identity is the server's, never the skill's.
  const plane2 = new AttachmentsPlane(tempDir('hd-attach-seat-kind2-'), port)
  const prepared2 = await plane2.prepare(subject())
  await plane2.record(seat('seat-kind2'), prepared2, {
    key: prepared2.input.key,
    loaded: [{ kind: 'mcp', name: 'foo', digest: mcpId.digest }],
    refused: [{ kind: 'skill', name: 'foo', reason: 'not reported' }],
  })
  const live = plane2.liveServersFor('seat-kind2' as never) ?? []
  assert.equal(live.length, 1)
  assert.equal(live[0]!.identity.kind, 'mcp')
  assert.equal(live[0]!.identity.digest, mcpId.digest)
  assert.deepEqual(live[0]!.spec, serverSpec('foo', 'server'), 'the live grant carries the exact approved spec the gateway will dial')
})

test('the host stages what it approved: a runtime is handed a host-owned copy of exactly the approved bytes, never the source folder', async () => {
  const id = identity({ seed: 'staged' })
  const port = portFor({ scout: [declaration(id)] })
  permit(port, subject(), id)
  const folder = tempDir('hd-attach-seat-staged-')
  const staging = tempDir('hd-attach-seat-staging-')
  const plane = new AttachmentsPlane(folder, port, { staging })
  const prepared = await plane.prepare(subject())
  const path = prepared.input.skills![0]!.path
  assert.equal(path, join(await realpath(staging), 'skill', id.digest), 'the staged path is in the host’s own folder, named by the approved digest')
  assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), '---\nname: demo\n---\nstaged\n')

  // Something rewrites the staged copy between two Seats: the next Seat
  // never gets it — the copy is read back and hashed before it is reused.
  await writeFile(join(path, 'SKILL.md'), 'tampered')
  const again = await plane.prepare(subject())
  assert.equal(await readFile(join(again.input.skills![0]!.path, 'SKILL.md'), 'utf8'), '---\nname: demo\n---\nstaged\n', 'a tampered staged copy is replaced by the approved bytes')
})

test('content whose bytes are not what its digest names is never staged', async () => {
  const id = identity({ seed: 'honest' })
  const port = portFor({ scout: [declaration(id)] }, {
    resolve: async () => ({ declarations: [declaration(id)], resolved: [{ identity: id, files: skillFiles('demo', 'dishonest'), server: null }] }),
  })
  permit(port, subject(), id)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-dishonest-'), port)
  const prepared = await plane.prepare(subject())
  assert.deepEqual(prepared.input.skills, [])
  assert.match(prepared.declarations[0]!.problem ?? '', /not the content that was approved/)
})

test('reapply re-applies the frozen filter on a reopen: a new key, the same approved content, never the Agent’s current wishes', async () => {
  const skillId = identity({ name: 'demo', seed: 'frozen' })
  const mcpId = identity({ kind: 'mcp', name: 'tools', seed: 'frozen' })
  let declared = [declaration(skillId), declaration(mcpId)]
  const port = portFor({})
  const live: PortFixture = { ...port, resolve: async () => ({ declarations: declared, resolved: declared.map((one) => content.get(`${one.kind}:${one.name}:${one.identity!.digest}`)!) }) }
  permit(live, subject(), skillId)
  permit(live, subject(), mcpId)
  const staging = tempDir('hd-attach-seat-reapply-staging-')
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-reapply-'), live, { staging })
  const opened = seat('seat-re')
  const prepared = await plane.prepare(subject())
  await plane.record(opened, prepared, { key: prepared.input.key, loaded: [{ kind: 'skill', name: 'demo', digest: skillId.digest }, { kind: 'mcp', name: 'tools', digest: mcpId.digest }], refused: [] })

  // The Agent's file changes after the Seat opened: the reopen must not see it.
  declared = [declaration(identity({ name: 'other', seed: 'new' }))]
  await plane.revokeLive(opened.id) // a restart forgets every live grant
  const reopened = await plane.reapply(opened, { build: '1.0.0' })
  assert.ok(reopened, 'a Seat that froze attachments has a filter to re-apply')
  assert.notEqual(reopened.input.key, prepared.input.key)
  assert.deepEqual(reopened.input.skills?.map((one) => `${one.name}:${one.digest}`), [`demo:${skillId.digest}`])
  assert.deepEqual(reopened.input.mcp?.map((one) => `${one.name}:${one.digest}`), [`tools:${mcpId.digest}`])
  const record = await plane.record(opened, reopened, { key: reopened.input.key, loaded: [{ kind: 'skill', name: 'demo', digest: skillId.digest }, { kind: 'mcp', name: 'tools', digest: mcpId.digest }], refused: [] })
  assert.equal(record.epoch, 1, 'a reopen is a new observation epoch')
  assert.equal(plane.liveServersFor(opened.id)?.length, 1, 'the reopened Seat reaches its approved server again')

  // A new runtime build is not covered by the approval: nothing loads, and the filter still holds.
  const newBuild = await plane.reapply(opened, { build: '2.0.0' })
  assert.deepEqual(newBuild?.input.skills, [])
  assert.deepEqual(newBuild?.input.mcp, [])
  assert.match(newBuild?.declarations[0]!.problem ?? '', /approved for another build of this agent \(1\.0\.0\), and it now runs 2\.0\.0; review it again/)

  // The staged copy is gone: the reopen says so, and still applies the filter.
  await rm(join(staging, 'skill', skillId.digest), { recursive: true })
  const gone = await plane.reapply(opened, { build: '1.0.0' })
  assert.deepEqual(gone?.input.skills, [])
  assert.match(gone?.declarations[0]!.problem ?? '', /no longer on this desk/)

  // A closed Seat's conversation keeps its filter but reaches no server.
  const closed = await plane.reapply({ ...opened, closed: { at: 2, reason: 'released' } as never }, { build: '1.0.0' })
  assert.deepEqual(closed?.input.mcp, [])
  assert.match(closed?.declarations[1]!.problem ?? '', /Seat has ended/)

  // A Seat that never froze anything has nothing to re-apply.
  assert.equal(await plane.reapply(seat('never-seated'), { build: '1.0.0' }), null)
})

test('reapply refuses a runtime that can no longer keep unapproved content out', async () => {
  const id = identity({ seed: 'refuse' })
  const port = portFor({ scout: [declaration(id)] })
  permit(port, subject(), id)
  const folder = tempDir('hd-attach-seat-reapply-refuse-')
  const plane = new AttachmentsPlane(folder, port)
  const prepared = await plane.prepare(subject())
  await plane.record(seat('seat-r'), prepared, { key: prepared.input.key, loaded: [{ kind: 'skill', name: 'demo', digest: id.digest }], refused: [] })
  const blind = new AttachmentsPlane(folder, { ...port, suppressUnapproved: async () => false })
  await assert.rejects(blind.reapply(seat('seat-r'), { build: '9.9.9' }), UnsuppressedAutoLoadError)
})

/*
 * #895. Two Seats staging the same digest took turns only by luck: one could
 * find the copy missing mid-write and remove the target the other had just
 * placed. Staging a digest now waits for whatever else is staging it, and
 * then finds the copy already there, verified.
 */
test('two Seats staging the same skill take turns, and the second finds the first one’s copy', async () => {
  const shared = identity({ name: 'shared', seed: 'race' })
  let releaseFirst!: () => void
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
  let firstWriting!: () => void
  const firstIn = new Promise<void>((resolve) => { firstWriting = resolve })
  let secondArrived!: () => void
  const secondIn = new Promise<void>((resolve) => { secondArrived = resolve })
  const steps: string[] = []
  let first = true
  const port = portFor({ 'agent-a': [declaration(shared)], 'agent-b': [declaration(shared)] })
  permit(port, subject({ agent: 'agent-a' }), shared)
  permit(port, subject({ agent: 'agent-b' }), shared)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-race-'), port, {
    onStaging: async (_digest, step) => {
      steps.push(step)
      if (first && step === 'writing') {
        first = false
        firstWriting()
        await firstHeld
        return
      }
      secondArrived()
    },
  })
  const a = plane.prepare(subject({ agent: 'agent-a' }))
  await firstIn
  const b = plane.prepare(subject({ agent: 'agent-b' }))
  // The second Seat has either queued behind the first or started writing over it.
  await secondIn
  releaseFirst()
  const [preparedA, preparedB] = await Promise.all([a, b])
  assert.deepEqual(steps, ['writing', 'waiting'], 'the second Seat waited its turn and never wrote the copy again')
  const path = preparedA.input.skills?.[0]?.path
  assert.ok(path)
  assert.equal(preparedB.input.skills?.[0]?.path, path)
  assert.deepEqual(await readdir(path), ['SKILL.md'])
})

/*
 * #895. Staged copies were never removed. A launch collects every copy no
 * frozen Seat filter and no approval names — but never one a Seat is opening
 * on — along with anything a crash left half-written.
 */
test('staged copies nobody references are collected; frozen, approved and opening ones are kept', async () => {
  const folder = tempDir('hd-attach-seat-collect-')
  const frozen = identity({ name: 'frozen', seed: 'f' })
  const granted = identity({ name: 'granted', seed: 'g' })
  const orphan = identity({ name: 'orphan', seed: 'o' })
  const orphanServer = identity({ kind: 'mcp', name: 'orphan-tools', seed: 'o' })
  const opening = identity({ name: 'opening', seed: 'p' })
  const port = portFor({
    kept: [declaration(frozen)],
    others: [declaration(granted), declaration(orphan), declaration(orphanServer)],
    later: [declaration(opening)],
  })
  for (const [agent, ids] of [['kept', [frozen]], ['others', [granted, orphan, orphanServer]], ['later', [opening]]] as const) {
    for (const id of ids) permit(port, subject({ agent }), id)
  }
  const first = new AttachmentsPlane(folder, port)
  const kept = await first.prepare(subject({ agent: 'kept' }))
  await first.record(seat('seat-kept'), kept, { key: kept.input.key, loaded: [{ kind: 'skill', name: 'frozen', digest: frozen.digest }], refused: [] })
  await first.prepare(subject({ agent: 'others' }))
  const skills = join(folder, '.staged', 'skill')
  await writeFile(join(await realpath(skills), '.left-by-a-crash.tmp'), 'half')

  // A later launch: nothing is opening yet, until a Seat starts to.
  const later = new AttachmentsPlane(folder, port)
  await later.prepare(subject({ agent: 'later' }))
  const removed = await later.collectStaged(new Set([granted.digest]))
  assert.equal(removed, 3, 'the orphan skill, the orphan server and the half-written copy')
  assert.deepEqual((await readdir(skills)).sort(), [frozen.digest, granted.digest, opening.digest].sort())
  assert.deepEqual(await readdir(join(folder, '.staged', 'mcp')), [])
})

test('a frozen filter that cannot be read keeps every staged copy', async () => {
  const folder = tempDir('hd-attach-seat-collect-damaged-')
  const orphan = identity({ name: 'orphan', seed: 'damaged' })
  const port = portFor({ others: [declaration(orphan)] })
  permit(port, subject({ agent: 'others' }), orphan)
  await new AttachmentsPlane(folder, port).prepare(subject({ agent: 'others' }))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(folder, '.frozen'), { recursive: true })
  await writeFile(join(folder, '.frozen', 'seat-x.json'), '{"version":1,"seat":')
  assert.equal(await new AttachmentsPlane(folder, port).collectStaged(new Set()), 0)
  assert.deepEqual(await readdir(join(folder, '.staged', 'skill')), [orphan.digest])
})

test('a Seat whose seating fell back to another runtime says its content was approved for the first, not just "review"', async () => {
  const id = identity({ name: 'fallback', seed: 'fb' })
  const port = portFor({ scout: [declaration(id)] }, {
    reviewedElsewhere: async (s) => (s.runtime === 'claude' ? { reviewed: 'First Agent', seated: 'Second Agent' } : null),
  })
  const prepared = await new AttachmentsPlane(tempDir('hd-attach-seat-fallback-'), port).prepare(subject())
  assert.equal(prepared.input.skills?.length, 0)
  assert.equal(prepared.declarations[0]!.problem, 'This was approved for First Agent, but this Seat runs on Second Agent instead, and an approval covers only the agent it was given for.')
})

/*
 * #940 review P3-1. A reopen answered with a session the agent still held
 * takes that session's receipt only when its key is one this Seat's own
 * filter was handed under — never a receipt from another Seat's input whose
 * loaded list merely fits inside this reopen's filter.
 */
test('a held session’s receipt counts only under a key this Seat’s own filter was handed', async () => {
  const { receiptFrom } = await import('../src/attachments/plane.js')
  const id = identity({ name: 'held', seed: 'held' })
  const port = portFor({ scout: [declaration(id)] })
  permit(port, subject(), id)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-held-key-'), port)
  const opened = seat('seat-held')
  const first = await plane.prepare(subject())
  await plane.record(opened, first, { key: first.input.key, loaded: [{ kind: 'skill', name: 'held', digest: id.digest }], refused: [] })
  const reopen = await plane.reapply(opened, { build: '1.0.0' })
  assert.ok(reopen)
  const answering = (key: string) => ({ attachmentReceipt: async () => ({ key, loaded: [{ kind: 'skill' as const, name: 'held', digest: id.digest }], refused: [] }) })
  const own = await receiptFrom(answering(first.input.key), 's' as never, reopen.input.key, { reopen, seatKeys: plane.keysOf(opened.id) })
  assert.equal(own.key, reopen.input.key)
  assert.deepEqual(own.loaded.map((one) => one.name), ['held'], 'this Seat’s own earlier filter: taken, re-keyed')
  const foreign = await receiptFrom(answering('another-seats-key'), 's' as never, reopen.input.key, { reopen, seatKeys: plane.keysOf(opened.id) })
  assert.deepEqual(foreign.loaded, [], 'a key this Seat never had: nothing loaded')
  assert.deepEqual(plane.keysOf(seat('seat-other').id), new Set())
})

/*
 * #939, from the review of #940. Right after a restart, a fresh
 * `AttachmentsPlane`'s key ledger for a Seat is empty — this process has
 * never handed that Seat any key at all. A held session's pre-restart
 * receipt is then neither provably within its filter nor provably outside
 * it: there is nothing here to check it against. Silently recording
 * "nothing loaded" would be trusted from then on as if it had truthfully
 * been asked; instead the reopen fails closed, and the caller closes the
 * session rather than carry a receipt nobody actually read back.
 */
test('a held session answered by a process that never opened its Seat at all fails closed, never as nothing loaded', async () => {
  const { receiptFrom } = await import('../src/attachments/plane.js')
  const id = identity({ name: 'held', seed: 'held-restart' })
  const port = portFor({ scout: [declaration(id)] })
  permit(port, subject(), id)
  const folder = tempDir('hd-attach-seat-held-restart-')
  const plane = new AttachmentsPlane(folder, port)
  const opened = seat('seat-held-restart')
  const first = await plane.prepare(subject())
  await plane.record(opened, first, { key: first.input.key, loaded: [{ kind: 'skill', name: 'held', digest: id.digest }], refused: [] })

  // A fresh process (a restart) reads back the same frozen filter: its own key ledger for this Seat starts empty.
  const restarted = new AttachmentsPlane(folder, port)
  const reopen = await restarted.reapply(opened, { build: '1.0.0' })
  assert.ok(reopen)
  assert.deepEqual(restarted.keysOf(opened.id), new Set(), 'a fresh process has handed this Seat no key yet')
  const answering = (key: string) => ({ attachmentReceipt: async () => ({ key, loaded: [{ kind: 'skill' as const, name: 'held', digest: id.digest }], refused: [] }) })
  await assert.rejects(
    receiptFrom(answering(first.input.key), 's' as never, reopen.input.key, { reopen, seatKeys: restarted.keysOf(opened.id) }),
    (error: unknown) => error instanceof HeldBeyondFilterError,
    'an unprovable held receipt closes the session rather than being read as nothing loaded',
  )
})

/*
 * #940 review P3-2. Collection lists `staged/skill` and `staged/mcp`: a link
 * swapped in for either would have it collect in whatever folder it points
 * at. A kind folder, or the staging folder itself, that is not a real folder
 * is left alone.
 */
test('collection never follows a link swapped in for a staging folder', async () => {
  const { mkdir, symlink, rename } = await import('node:fs/promises')
  const folder = tempDir('hd-attach-seat-collect-link-')
  const victim = tempDir('hd-attach-seat-collect-victim-')
  const bystander = 'f'.repeat(64)
  await mkdir(join(victim, bystander))
  await writeFile(join(victim, 'notes.tmp'), 'keep me')
  const orphan = identity({ name: 'orphan', seed: 'link' })
  const port = portFor({ others: [declaration(orphan)] })
  permit(port, subject({ agent: 'others' }), orphan)
  await new AttachmentsPlane(folder, port).prepare(subject({ agent: 'others' }))
  // The skill folder is moved away and a link to the victim put in its place.
  await rename(join(folder, '.staged', 'skill'), join(folder, 'moved'))
  await symlink(victim, join(folder, '.staged', 'skill'))
  assert.equal(await new AttachmentsPlane(folder, port).collectStaged(new Set()), 0)
  assert.deepEqual((await readdir(victim)).sort(), [bystander, 'notes.tmp'].sort(), 'nothing in the folder the link points at was touched')
  // The staging folder itself swapped for a link: nothing collected either.
  const outer = tempDir('hd-attach-seat-collect-outer-')
  await rename(join(folder, '.staged'), join(outer, 'staged'))
  await symlink(join(outer, 'staged'), join(folder, '.staged'))
  assert.equal(await new AttachmentsPlane(folder, port).collectStaged(new Set()), 0)
})

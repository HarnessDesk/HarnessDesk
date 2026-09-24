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
import { AttachmentsPlane, UnsuppressedAutoLoadError, type AttachmentSubject, type AttachmentsPlanePort, type ResolvedForPlane } from '../src/attachments/plane.js'
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
  assert.match(newBuild?.declarations[0]!.problem ?? '', /Review this content/)

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

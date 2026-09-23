import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  AttachmentDeclaration,
  AttachmentIdentity,
  AttachmentSupport,
  SeatRecord,
  SessionAttachmentReceipt,
} from '@harnessdesk/protocol'

import { AttachmentsPlane, UnsuppressedAutoLoadError, type AttachmentSubject, type AttachmentsPlanePort, type ResolvedForPlane } from '../src/attachments/plane.js'
import { tempDir } from './scratch.js'
import { seat } from './fixtures/goals.js'

/**
 * The one transaction every Seat's attachments go through: prepare, then
 * (once a caller opened a session and read it back) record. Every test here
 * proves isolation and refusal as hard as the happy path — a Seat's
 * attachments are exactly as much its own as its checkout is.
 */

const identity = (overrides: Partial<AttachmentIdentity> = {}): AttachmentIdentity => ({
  kind: 'skill',
  name: 'demo',
  digest: 'digest-a',
  source: 'agent',
  pathLabel: '~/demo',
  ...overrides,
})

const declaration = (overrides: Partial<AttachmentDeclaration> = {}): AttachmentDeclaration => ({
  kind: 'skill',
  name: 'demo',
  identity: identity(),
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

const portFor = (
  declarations: Record<string, readonly AttachmentDeclaration[]>,
  resolved: Record<string, readonly ResolvedForPlane[]> = {},
  overrides: Partial<AttachmentsPlanePort> = {},
): PortFixture => {
  const permitted = new Set<string>()
  return {
    permitted,
    resolve: async (s) => ({ declarations: declarations[s.agent] ?? [], resolved: resolved[s.agent] ?? [] }),
    permits: async (s, id) => permitted.has(`${s.agent}:${id.kind}:${id.name}:${id.digest}`),
    support: () => support,
    suppressUnapproved: async () => true,
    ...overrides,
  }
}

const permit = (port: PortFixture, s: AttachmentSubject, id: AttachmentIdentity): void => {
  port.permitted.add(`${s.agent}:${id.kind}:${id.name}:${id.digest}`)
}

test("two Seats keep disjoint frozen inputs", async () => {
  const idA = identity({ name: 'skill-a', digest: 'digest-a' })
  const idB = identity({ name: 'skill-b', digest: 'digest-b' })
  const port = portFor({
    'agent-a': [declaration({ name: 'skill-a', identity: idA })],
    'agent-b': [declaration({ name: 'skill-b', identity: idB })],
  })
  permit(port, subject({ agent: 'agent-a' }), idA)
  permit(port, subject({ agent: 'agent-b' }), idB)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-disjoint-'), port)

  const preparedA = await plane.prepare(subject({ agent: 'agent-a' }))
  const preparedB = await plane.prepare(subject({ agent: 'agent-b' }))

  assert.deepEqual(preparedA.input.skills?.map((one) => one.name), ['skill-a'])
  assert.deepEqual(preparedB.input.skills?.map((one) => one.name), ['skill-b'])
  // Mutating one caller's own result must never reach the other's.
  ;(preparedA.input.skills as unknown[]).push({ name: 'skill-b', digest: 'digest-b', path: 'x' })
  const preparedBAgain = await plane.prepare(subject({ agent: 'agent-b' }))
  assert.deepEqual(preparedBAgain.input.skills?.map((one) => one.name), ['skill-b'])
})

test('changed bundle needs review', async () => {
  const original = identity({ digest: 'digest-original' })
  const changed = identity({ digest: 'digest-changed' })
  let currentIdentity = original
  const port = portFor(
    {},
    {},
    {
      resolve: async () => ({ declarations: [declaration({ identity: currentIdentity })], resolved: [] }),
      permits: async (s, id) => id.digest === 'digest-original', // only the original bytes were ever approved
    },
  )
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-changed-'), port)

  const before = await plane.prepare(subject())
  assert.deepEqual(before.declarations[0]!.problem, null)
  assert.deepEqual(before.input.skills?.map((one) => one.digest), ['digest-original'])

  currentIdentity = changed
  const after = await plane.prepare(subject())
  assert.equal(after.input.skills?.length, 0, 'the changed bundle never reaches the isolated input')
  assert.match(after.declarations[0]!.problem ?? '', /Review this content/)
})

test('unapproved default repository content is suppressed', async () => {
  const id = identity()
  const port = portFor({ scout: [declaration({ identity: id })] })
  // Never approved.
  const suppressible = new AttachmentsPlane(tempDir('hd-attach-seat-suppress-ok-'), port)
  const prepared = await suppressible.prepare(subject())
  assert.equal(prepared.input.skills?.length, 0)
  assert.match(prepared.declarations[0]!.problem ?? '', /Review this content/)

  const unsuppressible = new AttachmentsPlane(
    tempDir('hd-attach-seat-suppress-refuse-'),
    portFor({ scout: [declaration({ identity: id })] }, {}, { suppressUnapproved: async () => false }),
  )
  await assert.rejects(unsuppressible.prepare(subject()), UnsuppressedAutoLoadError)
})

test('readback has to match', async () => {
  const id = identity({ digest: 'digest-real' })
  const port = portFor({ scout: [declaration({ identity: id })] })
  permit(port, subject(), id)
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-readback-'), port)
  const prepared = await plane.prepare(subject())
  assert.deepEqual(prepared.input.skills?.map((one) => one.digest), ['digest-real'])

  const claimedDifferent: SessionAttachmentReceipt = {
    key: prepared.input.key,
    loaded: [{ kind: 'skill', name: 'demo', digest: 'digest-DIFFERENT' }],
    refused: [],
  }
  const record = await plane.record(seat('seat-1'), prepared, claimedDifferent)
  assert.equal(record.results[0]!.status, 'not-loaded')
  assert.match(record.results[0]!.reason ?? '', /different content/)
  assert.equal(plane.liveServersFor('seat-1' as never), null)
})

test('plain start is unchanged', async () => {
  const port = portFor(
    {},
    {},
    {
      resolve: async () => {
        throw new Error('resolve must not be called for an Agent with no declarations at all')
      },
    },
  )
  // An Agent with genuinely nothing declared: the port's own `resolve` for
  // *this* subject answers with nothing, proving the plain path produces no
  // input and no declarations without needing to special-case it here — the
  // guard this test really pins is one level up, in the caller that decides
  // whether `record` is worth calling at all (see the integration note in
  // `methods/agents.ts`): a Seat with nothing prepared must never get an
  // attachment sidecar written for it.
  const emptyPort: AttachmentsPlanePort = { ...port, resolve: async () => ({ declarations: [], resolved: [] }) }
  const plane = new AttachmentsPlane(tempDir('hd-attach-seat-plain-'), emptyPort)
  const prepared = await plane.prepare(subject())
  assert.deepEqual(prepared.declarations, [])
  assert.deepEqual(prepared.input, { key: prepared.input.key, skills: null, mcp: null, notes: null })
  assert.equal(await plane.read('never-called-record' as never), null, 'no sidecar exists when record was never called')
})

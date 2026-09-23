import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { SessionAttachments } from '@harnessdesk/protocol'

import { AcpRuntime } from '../src/index.js'

/**
 * Phase 12's attachment contract, over a real ACP peer process — the fake
 * agent, scripted to negotiate the extension honestly or not at all. Every
 * test here proves the negative as hard as the positive: an agent that
 * cannot prove it filters must never be reported as though it can, and a
 * receipt this desk cannot verify must never be trusted in part.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

const make = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE], env })

const attachments = (overrides: Partial<SessionAttachments> = {}): SessionAttachments => ({
  key: 'k-1',
  skills: [{ name: 'demo', digest: 'd'.repeat(64), path: '~/demo' }],
  mcp: null,
  notes: null,
  ...overrides,
})

test('negotiates before injecting: absent, wrong version, and malformed capability all mean unsupported', async (t) => {
  const plain = make()
  t.after(() => plain.dispose())
  await plain.start()
  assert.equal(plain.info.attachments?.skills, 'unsupported', 'an agent that never mentions the extension is unsupported, not assumed capable')
  assert.match(plain.info.attachments?.reason ?? '', /does not declare/)

  const wrongVersion = make({ FAKE_ACP_ATTACHMENTS: '1', FAKE_ACP_ATTACHMENTS_VERSION: '2' })
  t.after(() => wrongVersion.dispose())
  await wrongVersion.start()
  assert.equal(wrongVersion.info.attachments?.skills, 'unsupported', 'a version other than exactly 1 is unsupported')

  const malformed = make({ FAKE_ACP_ATTACHMENTS: '1', FAKE_ACP_ATTACHMENTS_MALFORMED: '1' })
  t.after(() => malformed.dispose())
  await malformed.start()
  assert.equal(malformed.info.attachments?.skills, 'unsupported', 'a non-boolean field is unsupported, never coerced')

  const capable = make({ FAKE_ACP_ATTACHMENTS: '1' })
  t.after(() => capable.dispose())
  await capable.start()
  assert.equal(capable.info.attachments?.skills, 'scoped')
  // MCP stays unsupported through this adapter regardless of what the peer
  // claims: HarnessDesk does not yet connect a live `mcpServers` entry to a
  // Seat's approved gateway servers, and claiming otherwise would be exactly
  // the "capability nobody confirmed" this phase refuses to report.
  assert.equal(capable.info.attachments?.mcp, 'unsupported')
  assert.equal(capable.info.attachments?.suppressUnapproved, true)
})

test('mutation: defaulting missing support to capable is exactly the bug this guards', async (t) => {
  // Proven here rather than only asserted above: a decoder that defaulted an
  // absent capability to "supported" would pass every other assertion in
  // this file (nothing here re-checks `plain`'s specific reason text after
  // this point) but must fail this one, which is the actual security
  // property — an unmeasured runtime is never scoped.
  const plain = make()
  t.after(() => plain.dispose())
  await plain.start()
  assert.notEqual(plain.info.attachments?.skills, 'scoped', 'an agent that said nothing must never read as capable')
})

test('the prepared input reaches session/new under _meta.harnessdesk.attachments, and survives a tool-server refusal', async (t) => {
  const runtime = make({ FAKE_ACP_ATTACHMENTS: '1', FAKE_ACP_REFUSE_TOOLS: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()

  const input = attachments()
  const session = await runtime.createSession({ cwd: process.cwd(), attachments: input })
  t.after(() => session.close())

  // The desk's own plugin-tool bridge was refused (FAKE_ACP_REFUSE_TOOLS),
  // which retries session/new with `mcpServers: []` — a completely different
  // concern from the skill this session was scoped with. If the retry ever
  // dropped `_meta`'s attachments key, a real capable runtime would silently
  // fall back to native, unscoped loading exactly when the desk's own tools
  // were the thing refused.
  const receipt = await runtime.attachmentReceipt(session.id)
  assert.equal(receipt.key, 'k-1')
  assert.deepEqual(receipt.loaded, [{ kind: 'skill', name: 'demo', digest: 'd'.repeat(64) }])
})

test('receipt rejects extra or changed content: key mismatch, unrequested extra, and malformed shape are all refused whole', async (t) => {
  const input = attachments()

  const wrongKey = make({
    FAKE_ACP_ATTACHMENTS: '1',
    FAKE_ACP_ATTACHMENTS_RECEIPT: JSON.stringify({ key: 'stale-key', loaded: [{ kind: 'skill', name: 'demo', digest: 'd'.repeat(64) }], refused: [] }),
  })
  t.after(() => wrongKey.dispose())
  await wrongKey.start()
  const s1 = await wrongKey.createSession({ cwd: process.cwd(), attachments: input })
  t.after(() => s1.close())
  await assert.rejects(wrongKey.attachmentReceipt(s1.id), /this desk will not trust/)

  const extraItem = make({
    FAKE_ACP_ATTACHMENTS: '1',
    FAKE_ACP_ATTACHMENTS_RECEIPT: JSON.stringify({
      key: 'k-1',
      loaded: [
        { kind: 'skill', name: 'demo', digest: 'd'.repeat(64) },
        { kind: 'skill', name: 'never-declared', digest: 'e'.repeat(64) },
      ],
      refused: [],
    }),
  })
  t.after(() => extraItem.dispose())
  await extraItem.start()
  const s2 = await extraItem.createSession({ cwd: process.cwd(), attachments: input })
  t.after(() => s2.close())
  await assert.rejects(
    extraItem.attachmentReceipt(s2.id),
    /this desk will not trust/,
    'a receipt claiming a name this Seat never declared is rejected whole, not salvaged minus that entry',
  )

  const malformedDigest = make({
    FAKE_ACP_ATTACHMENTS: '1',
    FAKE_ACP_ATTACHMENTS_RECEIPT: JSON.stringify({ key: 'k-1', loaded: [{ kind: 'skill', name: 'demo', digest: 'not-hex' }], refused: [] }),
  })
  t.after(() => malformedDigest.dispose())
  await malformedDigest.start()
  const s3 = await malformedDigest.createSession({ cwd: process.cwd(), attachments: input })
  t.after(() => s3.close())
  await assert.rejects(malformedDigest.attachmentReceipt(s3.id), /this desk will not trust/)
})

test('a plain conversation with no attachments never asks for a receipt at all', async (t) => {
  const runtime = make({ FAKE_ACP_ATTACHMENTS: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: process.cwd() })
  t.after(() => session.close())
  await assert.rejects(runtime.attachmentReceipt(session.id), /never given attachments/)
})

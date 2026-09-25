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
  ...overrides,
})

test('negotiates before injecting: absent, wrong version, and malformed capability all mean unsupported', async (t) => {
  const plain = make()
  t.after(() => plain.dispose())
  await plain.start()
  assert.equal(plain.info.attachments?.skills, 'unsupported', 'an agent that never mentions the extension is unsupported, not assumed capable')
  assert.match(plain.info.attachments?.reason ?? '', /does not declare/)
  assert.match(plain.info.attachments?.reason ?? '', /^Fake ACP Agent /, 'a reason a person reads names the agent by its presentation (rule 8)')
  assert.doesNotMatch(plain.info.attachments?.reason ?? '', /fake-acp/)

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
  // Now trusted exactly like `skills`: the host side's own gateway route
  // (bootstrap.ts's McpToolGateway, reached over every ACP peer's existing
  // `harnessdesk` server) is real, so a peer's own claim is admitted the
  // same way skills already are — never by which runtime this happens to be.
  assert.equal(capable.info.attachments?.mcp, 'scoped-gated')
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

/**
 * A real Library MCP identity, not a made-up one: SHA-256 over
 * `canonicalMcp` of `{name: 'reviewer-tools', transport: 'stdio', command:
 * 'node', args: ['server.mjs']}` — pinned against the catalog's own
 * `mcpIdentityDigest` by `packages/server/test/attachments-catalog.test.ts`
 * (`PINNED_MCP_DIGEST`), which this package cannot import.
 */
const LIBRARY_MCP_DIGEST = 'f0dc54b9c1cc6b3f5258181220f07a45af1ab746d32d63338a8c4cee47cdf40d'

test('a receipt naming a real Library MCP identity is accepted, and a 16-hex display digest never is', async (t) => {
  const runtime = make({ FAKE_ACP_ATTACHMENTS: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const input = attachments({
    skills: null,
    mcp: [{ name: 'reviewer-tools', digest: LIBRARY_MCP_DIGEST, endpoint: `mcp:reviewer-tools:${LIBRARY_MCP_DIGEST}` }],
  })
  const session = await runtime.createSession({ cwd: process.cwd(), attachments: input })
  t.after(() => session.close())
  const receipt = await runtime.attachmentReceipt(session.id)
  assert.deepEqual(receipt.loaded, [{ kind: 'mcp', name: 'reviewer-tools', digest: LIBRARY_MCP_DIGEST }])

  const short = make({ FAKE_ACP_ATTACHMENTS: '1' })
  t.after(() => short.dispose())
  await short.start()
  const shortInput = attachments({ skills: null, mcp: [{ name: 'reviewer-tools', digest: LIBRARY_MCP_DIGEST.slice(0, 16), endpoint: 'mcp:x' }] })
  const s2 = await short.createSession({ cwd: process.cwd(), attachments: shortInput })
  t.after(() => s2.close())
  await assert.rejects(short.attachmentReceipt(s2.id), /this desk will not trust/, 'a truncated digest gates nothing')
})

test('a load (a reopened Seat) carries the frozen input it is handed, and its receipt answers for the reopen’s own key', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'acp-attach-load-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, 'sessions.json')
  writeFileSync(store, JSON.stringify({ kept: { sessionId: 'kept', cwd: dir, title: 'Kept', updatedAt: new Date().toISOString(), turns: [] } }))
  const runtime = make({ FAKE_ACP_ATTACHMENTS: '1', FAKE_ACP_STORE: store })
  t.after(() => runtime.dispose())
  await runtime.start()
  const reopened = attachments({ key: 'reopen-key' })
  const session = await runtime.resumeSession('kept' as never, { attachments: reopened })
  t.after(() => session.close())
  const receipt = await runtime.attachmentReceipt(session.id)
  assert.equal(receipt.key, 'reopen-key')
  assert.deepEqual(receipt.loaded.map((one) => one.name), ['demo'])
})

const storedPeer = async (t: { after(fn: () => unknown): void }) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'acp-attach-reopen-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, 'sessions.json')
  const opens = join(dir, 'opens.ndjson')
  writeFileSync(store, JSON.stringify({ kept: { sessionId: 'kept', cwd: dir, title: 'Kept', updatedAt: new Date().toISOString(), turns: [] } }))
  const runtime = make({ FAKE_ACP_ATTACHMENTS: '1', FAKE_ACP_STORE: store, FAKE_ACP_OPENS: opens })
  t.after(() => runtime.dispose())
  await runtime.start()
  const loads = async () => {
    const { readFileSync } = await import('node:fs')
    let text = ''
    try { text = readFileSync(opens, 'utf8') } catch {}
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; filtered?: boolean }).filter((one) => one.method === 'session/load')
  }
  return { runtime, loads }
}

test('a session a read opened with no filter is loaded again with the filter a reopen carries', async (t) => {
  const { runtime, loads } = await storedPeer(t)
  await runtime.readSession('kept' as never) // over ACP, a read is a load — with no filter
  const session = await runtime.resumeSession('kept' as never, { attachments: attachments({ key: 'reopen-key' }) })
  t.after(() => session.close())
  assert.deepEqual((await loads()).map((one) => one.filtered), [false, true])
  assert.equal((await runtime.attachmentReceipt(session.id)).key, 'reopen-key')
})

test('a session already open on a filter, or with a turn running, is handed back as it is — a second reopen never cancels it', async (t) => {
  const { runtime, loads } = await storedPeer(t)
  const first = await runtime.resumeSession('kept' as never, { attachments: attachments({ key: 'key-a' }) })
  t.after(() => first.close())
  const again = await runtime.resumeSession('kept' as never, { attachments: attachments({ key: 'key-b' }) })
  assert.equal(again, first, 'already on a filter: the same session, not a reload')
  assert.deepEqual((await loads()).map((one) => one.filtered), [true])
  assert.equal((await runtime.attachmentReceipt(first.id)).key, 'key-a')

  // An unfiltered session with a turn in flight is not dropped either.
  const { runtime: other, loads: otherLoads } = await storedPeer(t)
  await other.readSession('kept' as never)
  const live = await other.resumeSession('kept' as never)
  const turn = live.send([{ type: 'text', text: 'slow' }])
  const during = await other.resumeSession('kept' as never, { attachments: attachments({ key: 'key-c' }) })
  assert.equal(during, live, 'a running turn is never cancelled by a reopen')
  assert.deepEqual((await otherLoads()).map((one) => one.filtered), [false])
  await live.interrupt?.()
  await turn.catch(() => {})
})

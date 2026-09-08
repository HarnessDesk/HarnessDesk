import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sessionId } from '@harnessdesk/protocol'

import { AcpRuntime } from '../src/index.js'

/**
 * What ACP can and cannot say about ending a conversation.
 *
 * The protocol has no archive and no delete, so both are declared false by
 * default — and that is the answer the interface needs: archiving is the
 * host's job for these agents, and Delete must be greyed rather than offered
 * and then thrown from. An agent that *does* know where its own store is says
 * so in the handshake and is asked.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

const make = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE], env })

test('an ordinary ACP agent declares neither archive nor delete, and refuses both', async (t) => {
  const runtime = make()
  t.after(() => runtime.dispose())
  await runtime.start()

  assert.equal(runtime.info.capabilities.archiveHistory, false)
  assert.equal(runtime.info.capabilities.deleteHistory, false)

  await assert.rejects(runtime.archiveSession(sessionId('x'), true), /no archive of its own/)
  await assert.rejects(runtime.deleteSession(sessionId('x')), /cannot delete a stored conversation/)
})

test('an agent that declares the delete extension is asked, and its store loses the row', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-delete-'))
  const store = join(dir, 'store.json')
  await writeFile(
    store,
    JSON.stringify({
      keep: { sessionId: 'keep', cwd: '/w', title: 'Kept', updatedAt: '2026-01-01T00:00:00Z', turns: [] },
      gone: { sessionId: 'gone', cwd: '/w', title: 'Going', updatedAt: '2026-01-02T00:00:00Z', turns: [] },
    }),
  )
  const runtime = make({ FAKE_ACP_DELETE: '1', FAKE_ACP_STORE: store })
  t.after(async () => {
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await runtime.start()

  assert.equal(runtime.info.capabilities.deleteHistory, true)
  // Still no archive: knowing where a store is does not give ACP an archive,
  // and claiming one would put the mark in two places.
  assert.equal(runtime.info.capabilities.archiveHistory, false)

  const before = await runtime.listSessions()
  assert.deepEqual(before.data.map((row) => String(row.id)).sort(), ['gone', 'keep'])

  const outcome = await runtime.deleteSession(sessionId('gone'))
  // The disposition travels back, because "moved to the Trash" and "deleted"
  // are different promises and the interface repeats whichever it is told.
  assert.equal(outcome.disposition, 'trash')
  assert.equal(outcome.removed, 1)

  const after = await runtime.listSessions()
  assert.deepEqual(after.data.map((row) => String(row.id)), ['keep'])
})

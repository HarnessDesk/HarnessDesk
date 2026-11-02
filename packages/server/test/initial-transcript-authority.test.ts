import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { itemId, sessionId, turnId, type AgentEvent, type Session } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { TranscriptDatabase } from '../src/transcript-database.js'
import { TranscriptStore } from '../src/transcripts.js'
import { FakeRuntime, FakeSession } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const initial = (runtime: FakeRuntime, root: string, id = 'synthetic-initial'): Session => {
  const live = new FakeSession(runtime, sessionId(id), { cwd: root, model: 'fake-1' }, {})
  return { ...live.snapshot(), turns: [{ id: turnId('one'), status: 'completed',
    items: [{ id: itemId('item'), type: 'assistantMessage', text: 'synthetic original' }] }], itemsLoaded: true }
}

for (const race of ['none', 'insert', 'tombstone'] as const) {
  test(`unsolicited full runtime session uses verified missing Host storage: ${race}`, async t => {
    const root = tempDir('hd-initial-authority-')
    const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
    const runtime = new FakeRuntime(); host.register(runtime); await host.start()
    let closed = false
    t.after(async () => { if (!closed) await host.dispose().catch(() => {}) })
    const body = initial(runtime, root)
    let injected = false
    const matches = TranscriptStore.prototype.matchesBase
    if (race !== 'none') t.mock.method(TranscriptStore.prototype, 'matchesBase', function(this: TranscriptStore, session: Session, base: Parameters<typeof matches>[1]) {
      if (!injected && session.id === body.id && base.kind === 'missing') {
        injected = true
        const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
        try {
          if (race === 'insert') db.write({ version: 1, runtime: body.runtime, id: body.id, savedAt: 1,
            turns: [{ id: turnId('external'), status: 'completed', items: [{ id: itemId('external'), type: 'assistantMessage', text: 'external' }] }] })
          else db.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(`deleted:${JSON.stringify([body.runtime, body.id])}`, '1')
        } finally { db.close() }
      }
      return matches.call(this, session, base)
    })
    runtime.emit({ type: 'session/started', session: body })
    if (race !== 'none') assert.equal(injected, true)
    if (race === 'insert') await assert.rejects(host.dispose(), /authority|protected/i)
    else await host.dispose()
    closed = true
    const db = new TranscriptDatabase(join(root, 'sessions.sqlite'))
    try {
      if (race === 'none') assert.deepEqual(db.read(body.runtime, body.id)?.turns, body.turns)
      else if (race === 'insert') assert.equal(db.read(body.runtime, body.id)?.turns[0]?.id, turnId('external'))
      else assert.equal(db.isRemoved(body.runtime, body.id), true)
    } finally { db.close() }
  })
}

test('a callback retained from an old runtime cannot announce a new session', async t => {
  const root = tempDir('hd-initial-owner-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), builtinAgents: root, catalogRefreshMs: 0 })
  const old = new FakeRuntime(), replacement = new FakeRuntime()
  const subscribe = old.subscribe.bind(old)
  let stale!: (event: AgentEvent) => void
  old.subscribe = listener => { stale = listener; return subscribe(listener) }
  host.register(old); await host.start(); await host.unregister(old.info.id)
  host.register(replacement)
  t.after(() => host.dispose())
  const body = initial(old, root, 'old-runtime')
  stale({ type: 'session/started', session: body })
  assert.equal(host.registry.get(body.runtime, body.id), undefined)
})

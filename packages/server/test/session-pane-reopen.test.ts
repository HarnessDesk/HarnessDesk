import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { type Session, type SessionOptions } from '@harnessdesk/protocol'
import { SeatBook } from '../src/evidence/seats.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { Host, Logger, StateStore } from '../src/index.js'

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

for (const seated of [true, false]) {
  test(`pane reopen of an unlisted conversation ${seated ? 'uses only its durable Seat checkout and keeps picks' : 'refuses without a Seat checkout'}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-pane-unlisted-'))
    const cwd = join(dir, 'work')
    await mkdir(cwd)
    const store = join(dir, 'sessions.json')
    const writer = new AcpRuntime({ id: 'reader', name: 'Reader', command: process.execPath, args: [PEER],
      env: { FAKE_ACP_STORE: store, FAKE_ACP_STORE_DRAFTS: '1' } })
    t.after(async () => { await writer.dispose(); await rm(dir, { recursive: true, force: true }) })
    await writer.start()
    const created = await writer.createSession({ cwd })
    await created.close()
    await writer.dispose()
    if (seated) {
      await new SeatBook(new EvidenceStore(join(dir, 'evidence'))).opened({
        agent: null, briefDigest: null, seat: { runtime: 'reader' }, seatLabel: 'Reader', passedOver: [],
        standing: { kind: 'ceiling', level: 'read' }, ceiling: { level: 'read', hold: 'asked' },
        cwd, session: { runtime: 'reader', sessionId: String(created.id) }, board: null, role: null,
        runtimeServers: [],
      })
    }
    const runtime = new AcpRuntime({ id: 'reader', name: 'Reader', command: process.execPath, args: [PEER],
      env: { FAKE_ACP_STORE: store, FAKE_ACP_UNLISTED: String(created.id) } })
    const host = new Host({ logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
      catalogRefreshMs: 0, idleStopMs: 0, sessionRestMs: 0 })
    t.after(() => host.dispose())
    host.register(runtime)
    await host.start()
    const params = { runtime: runtime.info.id, sessionId: created.id }
    if (!seated) await runtime.resumeSession(created.id, { knownCwd: cwd })
    await host.call('session/resume', params)
    await host.call('session/options/set', { ...params, optionId: 'model', value: 'large' })
    await host.call('session/options/set', { ...params, optionId: 'mode', value: 'terse' })
    await host.call('session/close', params)
    const calls: Array<Partial<SessionOptions> | undefined> = []
    const resume = runtime.resumeSession.bind(runtime)
    runtime.resumeSession = async (id, options) => { calls.push(options); return resume(id, options) }
    if (!seated) {
      // No caller's folder may replace a Seat's durable checkout.
      await assert.rejects(host.call('session/resume', { ...params, options: { cwd: dir, knownCwd: cwd } }),
        (error: Error & { wireCode?: string }) => error.wireCode === 'sessionGone')
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.knownCwd, undefined)
      return
    }
    const reopened = await host.call('session/resume', { ...params, options: { cwd: dir, knownCwd: dir } }) as Session
    assert.equal(reopened.cwd, cwd)
    assert.deepEqual(calls.map(options => options?.knownCwd), [undefined, cwd])
    assert.deepEqual(calls[1], { ...calls[0], knownCwd: cwd }, 'the retry keeps every reopen option')
    assert.ok(calls.every(options => options?.requestedCeiling === 'read'))
    assert.ok(calls.every(options => options?.runtimeServers?.length === 0))
    assert.deepEqual(reopened.options?.filter(option => ['model', 'mode'].includes(option.id))
      .map(option => [option.id, option.currentValue]).sort(), [['mode', 'terse'], ['model', 'large']])
    assert.equal(host.registry.get(runtime.info.id, created.id)?.restedOptions, undefined)
  })
}

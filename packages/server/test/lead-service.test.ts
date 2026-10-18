import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createLeadJournal, type LeadJournalRecord } from '@harnessdesk/lead'
import { LeadBudgets } from '../src/lead/budgets.js'

const key = 'sk-test-not-real-0000'
const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the plan' }] }], maxTokens: 32 }
const rig = async (t: { after(fn: () => Promise<void>): void }, hooks: { resolveTool?: () => Promise<any>; stopOwned?: () => Promise<void> } = {}) => {
  const home = await mkdtemp('/tmp/hd-ls-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-service', caps: { usdMicros: 1000, rounds: 4 }, freshnessMs: 1000 })
  const events: string[] = [], timers = new Set<() => void>()
  const budgets = new LeadBudgets({ now: () => 100, runs: () => [], member: async () => true, interruptChecks() {}, stop: async () => {},
    schedule(callback) { timers.add(callback); return () => { timers.delete(callback) } } })
  let configured = true, spawns = 0, closes = 0, stopped = 0, process: any, supervisorOptions: any
  const bootstrap: any[] = []
  const broker = { async leadStatus() { return { configured, protection: 'synthetic cipher' } },
    async resolveLead() { if (!configured) throw new Error('lead-key-unavailable'); return key },
    async storeLead() { events.push('store'); configured = true }, async deleteLead() { events.push('delete'); configured = false } }
  const modulePath = new URL('../src/lead/service.js', import.meta.url).href
  const { LeadService } = await import(modulePath)
  const service = new LeadService({ journal, project: { id: 'synthetic', path: home }, broker, model: 'synthetic-model', prices: {},
    resolveTool: hooks.resolveTool ?? (async () => { throw new Error('unused') }), freezePlan: async (proposal: unknown) => proposal, readEvidence: async () => { throw new Error('unused') },
    register: () => { events.push('register'); const close = budgets.register(journal); return { admission: {}, close: () => { events.push('unregister'); close() } } },
    childStarted: () => (budgets as any).childStarted(journal), recover: () => budgets.recover(),
    openDoor: async () => ({ descriptor: { home, pid: 123, startedAt: 1, hostVersion: 'test', protocolVersion: 1, socketPath: `${home}/test.sock` },
      close: async () => { closes++; events.push('close-door') } }),
    stopOwned: async () => { stopped++; events.push('stop-owned'); await hooks.stopOwned?.() },
    createSupervisor: (options: any) => {
      supervisorOptions = options
      process = { live: false, async ensure() { if (this.live) return; bootstrap.push(await options.bootstrap()); spawns++; this.live = true; await options.onStarted?.() },
        async send() { assert.equal(this.live, true); return { status: 'completed' } },
        async stop(reason = 'stopped') { if (!this.live) return; events.push('stop-child'); this.live = false; await options.onExit?.(reason) },
        ownershipWithdrawn(runId: string) { events.push(`withdraw:${runId}`) },
        async crash() { this.live = false; await options.onExit?.('lead-child-exited') } }
      return process
    } })
  t.after(() => service.close())
  return { service, home, journal, budgets, timers, records, events, bootstrap, options: () => supervisorOptions, process: () => process, spawns: () => spawns, closes: () => closes, stopped: () => stopped }
}

test('two simultaneous sends start one child only after explicit enable', async t => {
  const s = await rig(t)
  await assert.rejects(s.service.send(input), /lead-disabled/)
  await s.service.setEnabled(true)
  assert.equal(s.spawns(), 0)
  await Promise.all([s.service.send(input), s.service.send(input)])
  assert.equal(s.spawns(), 1)
})

test('synthetic key reaches only bootstrap; renderer metadata and journal never contain it', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  assert.equal(s.bootstrap[0].key, key)
  assert.deepEqual(await s.service.status('anthropic'), { configured: true, protection: 'synthetic cipher' })
  assert.equal(JSON.stringify([await s.service.status('anthropic'), s.records, s.events]).includes(key), false)
})

for (const operation of ['replace', 'delete']) {
  test(`${operation} key stops old child and closes its door before changing broker state`, async t => {
    const s = await rig(t)
    await s.service.setEnabled(true); await s.service.send(input)
    const old = s.process()
    if (operation === 'replace') await s.service.setKey('anthropic', 'sk-test-not-real-1111')
    else await s.service.deleteKey('anthropic')
    assert.equal(old.live, false)
    assert.ok(s.events.indexOf('stop-child') < s.events.indexOf(operation === 'replace' ? 'store' : 'delete'))
    assert.ok(s.events.indexOf('close-door') < s.events.indexOf(operation === 'replace' ? 'store' : 'delete'))
    if (operation === 'delete') await assert.rejects(s.service.send(input), /lead-key-unavailable/)
    else { await s.service.send(input); assert.equal(s.spawns(), 2) }
  })
}

test('disable and host shutdown latch sends closed before yielding', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  const disabling = s.service.setEnabled(false)
  await assert.rejects(s.service.send(input), /lead-disabled/)
  await disabling
  assert.equal(s.process().live, false)
  await s.service.setEnabled(true); await s.service.send(input)
  const closing = s.service.close()
  await assert.rejects(s.service.send(input), /lead-closed/)
  await closing
  assert.equal(s.process().live, false)
})

test('child exit stops owned work, unregisters budgets and cancels cleanup retries before recovery', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  await assert.rejects(s.service.recover(), /lead-child-live/)
  await s.process().crash()
  assert.equal(s.stopped(), 1)
  assert.ok(s.events.includes('unregister'))
  assert.equal(s.timers.size, 0)
  // No stale owner: a new child can register this same logical goal.
  await s.service.send(input)
  assert.equal(s.spawns(), 2)
  assert.equal(s.journal.state.phase, 'waiting-for-user', 'recovery never silently resumes work')
})

test('ownership withdrawn mid-wait sends a typed withdrawal and stops owned work', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  await s.service.ownershipWithdrawn('run-synthetic')
  assert.ok(s.events.includes('withdraw:run-synthetic'))
  assert.ok(s.stopped() > 0)
  assert.equal(s.journal.state.phase, 'waiting-for-user')
})

for (const operation of ['close', 'disable', 'replace']) {
  test(`${operation} still terminates child and closes door when the journal latch fails`, async t => {
    const s = await rig(t)
    await s.service.setEnabled(true); await s.service.send(input)
    const setPhase = s.journal.setManagementPhase.bind(s.journal)
    s.journal.setManagementPhase = async () => { throw new Error('synthetic write failure') }
    const action = operation === 'close' ? s.service.close() : operation === 'disable' ? s.service.setEnabled(false) : s.service.setKey('anthropic', key)
    await assert.rejects(action, /synthetic write failure/)
    s.journal.setManagementPhase = setPhase
    assert.equal(s.process().live, false)
    assert.equal(s.closes(), 1)
    assert.equal(s.events.includes('store'), false, 'failed latch cannot change key')
  })
}

test('failed owned-work cleanup fences replacement children', async t => {
  const s = await rig(t, { stopOwned: async () => { throw new Error('synthetic stop failure') } })
  await s.service.setEnabled(true); await s.service.send(input)
  await assert.rejects(s.process().crash(), /synthetic stop failure/)
  await assert.rejects(s.service.send(input), /lead-cleanup-pending/)
  assert.equal(s.spawns(), 1)
})

for (const operation of ['close', 'disable', 'replace', 'withdraw']) {
  test(`a pending tool resolution cannot grant authority after ${operation}`, async t => {
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const s = await rig(t, { resolveTool: async () => { entered(); await wait; return { project: null, runId: null, start: null, context: {} } } })
    await s.service.setEnabled(true); await s.service.send(input)
    const resolving = s.options().resolveTool({ method: 'flow/executions', params: {} })
    await enteredPromise
    if (operation === 'close') await s.service.close()
    else if (operation === 'disable') await s.service.setEnabled(false)
    else if (operation === 'replace') await s.service.setKey('anthropic', key)
    else await s.service.ownershipWithdrawn('run-synthetic')
    release()
    await assert.rejects(resolving, /lead-(closed|disabled|lifecycle-changed)/)
  })
}

test('a widening repository policy blocks management before any child or door starts', async t => {
  const s = await rig(t)
  await s.journal.setPolicy({ version: 1, revision: 2, mode: 'plan', rules: [] })
  const root = s.home
  await mkdir(`${root}/.harnessdesk`)
  await writeFile(`${root}/.harnessdesk/lead.json`, JSON.stringify({ version: 1, revision: 3, mode: 'manage', rules: [] }))
  await s.service.setEnabled(true)
  await assert.rejects(s.service.send(input), /widening.*blocks management/)
  assert.equal(s.spawns(), 0)
  assert.equal(s.bootstrap.length, 0)
  assert.equal(s.events.includes('register'), false)
})

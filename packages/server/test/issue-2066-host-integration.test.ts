import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync, fork } from 'node:child_process'
import { canBeginLeadGoal, createLeadJournal } from '@harnessdesk/lead'
import { LeadFileJournal } from '../src/lead/journal.js'
import { createLeadRig } from './fixtures/lead-rig.js'
import { FakeForge, Clocks } from './fixtures/intake-forge.js'
import { LEAD_MESSAGES_DEFAULTS } from '@harnessdesk/lead'
import { CredentialBroker } from '../src/credentials.js'
import { intakeDesk, commitTriggers } from './fixtures/intake-host.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'
import { MentionObserverBudget } from '../src/lead/mention-observer-budget.js'
import { CarryOnService } from '../src/carry-on/service.js'

const trigger = `- id: ask
  on: mention
  people: [a-teammate]
  opens: { flow: review-pr }
  again: { role: reviewer }
  concurrency: 4
`

test('a chosen mention budget funds assessments independently of the Lead goal', { timeout: 60000 }, async t => {
  const repo = await makeRepo('hd-mention-budget-')
  await commitTriggers(repo, trigger)
  const calls: { model: string }[] = []
  const transport = { async send(request: { body: string }) {
    calls.push(JSON.parse(request.body))
    return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 } } }) }
  } }
  const cipher = { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() }
  const d = await intakeDesk({ repo, lead: true, characterizationTransport: transport, characterizationSeed: async stateDir => {
    await new CredentialBroker(join(stateDir, 'credentials.json'), cipher).storeLead('anthropic', 'sk-test-not-real-0000')
  } })
  t.after(() => d.stop())
  d.forge.users.set('a-teammate', { id: 31 })
  const preview = await d.host.call('trigger/preview', { root: repo.dir, id: 'ask' })
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.token)
  await d.host.call('trigger/arm', { root: repo.dir, id: 'ask', token: preview.token })
  await d.host.call('trigger/mode', { root: repo.dir, id: 'ask', mode: 'act' })
  const say = async (n: number) => {
    const at = d.clocks.wall + 1000
    d.forge.issues.push({ number: n, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9000 + n, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
    d.clocks.advance(60000); await d.host.intakePlane.tick()
  }
  assert.equal((await d.host.call('lead/mentionBudget/read', {})).enabled, false)
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  await say(1)
  assert.equal(calls.length, 1, 'no Lead goal is required')
  assert.equal(calls[0]!.model, LEAD_MESSAGES_DEFAULTS.observerModel)
  const first = await d.host.call('lead/mentionBudget/read', {})
  assert.equal(first.spentUsdMicros, 21, 'the observer model prices input, output, read and each cache TTL')
  assert.equal(first.uncertainUsdMicros, 0)
  const draft = await d.host.call('lead/thread/read', {})
  await say(2)
  assert.equal(calls.length, 2)
  const after = await d.host.call('lead/thread/read', {})
  assert.deepEqual(after.settings.caps, draft.settings.caps)
  assert.ok((await d.host.call('lead/mentionBudget/read', {})).spentUsdMicros > first.spentUsdMicros)
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 0 })
  await say(3)
  assert.equal(calls.length, 2, 'turning off prevents the next provider request')
  await d.stop()
  const reopened = await intakeDesk({ repo, stateDir: d.stateDir, lead: true, characterizationTransport: transport })
  t.after(() => reopened.stop())
  const restored = await reopened.host.call('lead/mentionBudget/read', {})
  assert.equal(restored.enabled, false)
  assert.equal(restored.spentUsdMicros, 42, 'known observer spend survives a Host restart')
})


test('an active Lead goal keeps its historical charges when an assessment settles', { timeout: 120000 }, async t => {
  const forge = new FakeForge(), clock = new Clocks(Date.now()), calls: { model: string }[] = []
  const transport = { async send(request: { body: string }) {
    calls.push(JSON.parse(request.body))
    return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) }
  } }
  const rig = await createLeadRig({ holdWorkers: true, manualChecks: true, characterizationKeep: true, characterizationTransport: transport,
    characterizationIntake: { gh: forge.runner, now: () => clock.wall, monotonic: () => clock.mono,
      timers: { every() { return 0 }, clear() {} }, usage: async () => ({ samples: [], complete: true }) } })
  t.after(async () => { await rig.dispose(); await rm(dirname(rig.home), { recursive: true, force: true }) })
  await rig.sendGoal()
  await rig.waitFor(() => !!rig.pending('plan'), 'real plan')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => rig.journal.state.runs.length > 0 && !!rig.journal.state.budget?.goalId, 'real bound goal')
  await rig.waitFor(() => rig.journal.state.budget?.spend === 'known', 'real goal budget observation')
  const goalId = rig.journal.state.budget!.goalId!
  const before = structuredClone(rig.journal.state.budget!.settled)
  const execution = await rig.host.call('flow/execution', { run: rig.journal.state.runs[0]!.runId })
  assert.equal(execution.goal, goalId)
  await mkdir(join(rig.project.path, '.harnessdesk'), { recursive: true })
  await writeFile(join(rig.project.path, '.harnessdesk', 'triggers.yml'), trigger.replace('opens: { flow: review-pr }\n  again: { role: reviewer }', 'opens: { lead: true }'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: rig.project.path, stdio: 'ignore' })
  git('add', '.harnessdesk/triggers.yml'); git('commit', '-m', 'synthetic trigger')
  try { git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git') } catch { git('remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git') }
  forge.users.set('a-teammate', { id: 31 })
  const preview = await rig.host.call('trigger/preview', { root: rig.project.path, id: 'ask' })
  assert.deepEqual(preview.problems, []); assert.ok(preview.token)
  await rig.host.call('trigger/arm', { root: rig.project.path, id: 'ask', token: preview.token })
  await rig.host.call('trigger/mode', { root: rig.project.path, id: 'ask', mode: 'act' })
  await rig.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  const at = clock.wall + 1000
  forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9001, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
  clock.advance(60000); await rig.host.intakePlane.tick()
  assert.equal(calls.length, 1); assert.equal(calls[0]!.model, LEAD_MESSAGES_DEFAULTS.observerModel)
  assert.equal(rig.journal.state.budget!.goalId, goalId)
  assert.deepEqual(rig.journal.state.budget!.settled, before)
  assert.ok((await rig.host.call('lead/mentionBudget/read', {})).spentUsdMicros > 0)
  await rig.dispose()
  const storage = await LeadFileJournal.open(rig.home, 'synthetic-thread')
  try { const reopened = await createLeadJournal(storage); assert.equal(reopened.state.budget?.goalId, goalId); assert.deepEqual(reopened.state.budget?.settled, before) }
  finally { await storage.close() }
})

test('an in-flight assessment settles its own receipt after the Lead changes goals', { timeout: 120000 }, async t => {
  const forge = new FakeForge(), clock = new Clocks(Date.now()), calls: { model: string }[] = []
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const sent = new Promise<void>(resolve => { started = resolve })
  const transport = { async send(request: { body: string }) {
    calls.push(JSON.parse(request.body)); started(); await held
    return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) }
  } }
  const rig = await createLeadRig({ characterizationKeep: true, characterizationTransport: transport,
    characterizationIntake: { gh: forge.runner, now: () => clock.wall, monotonic: () => clock.mono,
      timers: { every() { return 0 }, clear() {} }, usage: async () => ({ samples: [], complete: true }) } })
  t.after(async () => { release(); await rig.dispose(); await rm(dirname(rig.home), { recursive: true, force: true }) })
  await rig.journal.updateBudget({ version: 1, type: 'reserve', now: Date.now(), requestId: 'prior-lead-charge', inputTokens: 100, maxOutputTokens: 10, inputUsdMicrosPerMillion: 1000000, outputUsdMicrosPerMillion: 1000000, cacheReadUsdMicrosPerMillion: 1000000, cacheWriteUsdMicrosPerMillion: 1000000 })
  await rig.journal.updateBudget({ version: 1, type: 'settle', now: Date.now(), requestId: 'prior-lead-charge', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
  await rig.journal.stop(async () => {})
  assert.ok(canBeginLeadGoal(rig.journal.state))
  await mkdir(join(rig.project.path, '.harnessdesk'), { recursive: true })
  await writeFile(join(rig.project.path, '.harnessdesk', 'triggers.yml'), trigger.replace('opens: { flow: review-pr }\n  again: { role: reviewer }', 'opens: { lead: true }'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: rig.project.path, stdio: 'ignore' })
  git('add', '.harnessdesk/triggers.yml'); git('commit', '-m', 'synthetic trigger')
  try { git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git') } catch { git('remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git') }
  forge.users.set('a-teammate', { id: 31 })
  const preview = await rig.host.call('trigger/preview', { root: rig.project.path, id: 'ask' })
  assert.deepEqual(preview.problems, []); assert.ok(preview.token)
  await rig.host.call('trigger/arm', { root: rig.project.path, id: 'ask', token: preview.token })
  await rig.host.call('trigger/mode', { root: rig.project.path, id: 'ask', mode: 'act' })
  await rig.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  const at = clock.wall + 1000
  forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9001, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
  clock.advance(60000)
  const tick = rig.host.intakePlane.tick()
  await sent
  assert.equal(calls.length, 1)
  const pending = await rig.host.call('lead/mentionBudget/read', {})
  assert.ok(pending.reservedUsdMicros > 0)
  await rig.waitFor(() => canBeginLeadGoal(rig.journal.state), 'prior goal settled while assessment is held')
  const oldGoal = structuredClone(rig.journal.state.budget!)
  assert.equal(oldGoal.leadUsdMicros, 110, 'the old goal has a pre-existing charge')
  await rig.journal.beginGoal('synthetic-next-goal', Date.now())
  const newGoal = structuredClone(rig.journal.state.budget!)
  assert.notEqual(newGoal.logicalGoalId, oldGoal.logicalGoalId)
  assert.deepEqual(rig.journal.state.completedBudgets.at(-1), oldGoal)
  release(); await tick
  const budget = await rig.host.call('lead/mentionBudget/read', {})
  assert.equal(budget.reservedUsdMicros, 0)
  assert.equal(budget.spentUsdMicros, 20)
  assert.equal(budget.uncertainUsdMicros, 0)
  assert.deepEqual(rig.journal.state.completedBudgets.at(-1), oldGoal)
  assert.deepEqual(rig.journal.state.budget, newGoal)
  clock.advance(60000); await rig.host.intakePlane.tick()
  assert.equal(calls.length, 1, 'the completed mention is not automatically resent')
  await rig.dispose()
  const storage = await LeadFileJournal.open(rig.home, 'synthetic-thread')
  try { const reopened = await createLeadJournal(storage); assert.deepEqual(reopened.state.completedBudgets.at(-1), oldGoal); assert.deepEqual(reopened.state.budget, newGoal) }
  finally { await storage.close() }
})

test('a failed observer budget close still releases unrelated Host storage', { timeout: 60000 }, async t => {
  const repo = await makeRepo('hd-mention-close-')
  await commitTriggers(repo, trigger)
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const sent = new Promise<void>(resolve => { started = resolve })
  const transport = { async send() { started(); await held; return { status: 500, body: '{}' } } }
  const cipher = { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() }
  const d = await intakeDesk({ repo, lead: true, characterizationTransport: transport, characterizationSeed: async stateDir => {
    await new CredentialBroker(join(stateDir, 'credentials.json'), cipher).storeLead('anthropic', 'sk-test-not-real-0000')
  } })
  t.after(async () => { release(); await d.stop().catch(() => {}) })
  d.forge.users.set('a-teammate', { id: 31 })
  const preview = await d.host.call('trigger/preview', { root: repo.dir, id: 'ask' })
  await d.host.call('trigger/arm', { root: repo.dir, id: 'ask', token: preview.token! })
  await d.host.call('trigger/mode', { root: repo.dir, id: 'ask', mode: 'act' })
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  const at = d.clocks.wall + 1000
  d.forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9001, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
  d.clocks.advance(60000)
  const tick = d.host.intakePlane.tick()
  await sent
  assert.ok((await d.host.call('lead/mentionBudget/read', {})).reservedUsdMicros > 0)
  await writeFile(join(d.stateDir, 'lead', 'mention-observer-budget.json'), '{"tampered":true}')
  // Intake now drains first, so its settlement sees the tamper before close.
  // Inject a separate close failure to verify that Host still drains and reports it.
  const originalClose = MentionObserverBudget.prototype.close
  MentionObserverBudget.prototype.close = async function () { await originalClose.call(this); throw new Error('synthetic budget close failure') }
  const closing = d.stop()
  const releaseTimer = setTimeout(release, 500)
  try { await assert.rejects(closing, /synthetic budget close failure/) } finally { MentionObserverBudget.prototype.close = originalClose; clearTimeout(releaseTimer); release() }
  await tick.catch(() => {})
  const reopened = await intakeDesk({ repo, stateDir: d.stateDir, lead: true })
  t.after(() => reopened.stop())
  assert.ok(reopened.host, 'the unrelated Host writer lease was released')
})

test('shutdown drains an in-flight assessment before closing its budget', { timeout: 60000 }, async t => {
  const repo = await makeRepo('hd-mention-shutdown-')
  await commitTriggers(repo, trigger)
  let release!: () => void, started!: () => void, signal!: AbortSignal
  const held = new Promise<void>(resolve => { release = resolve })
  const sent = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const transport = { async send(request: { signal: AbortSignal }) {
    calls++; signal = request.signal; started(); await held
    return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) }
  } }
  const cipher = { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() }
  const d = await intakeDesk({ repo, lead: true, characterizationTransport: transport, characterizationSeed: async stateDir => {
    await new CredentialBroker(join(stateDir, 'credentials.json'), cipher).storeLead('anthropic', 'sk-test-not-real-0000')
  } })
  t.after(async () => { release(); await d.stop().catch(() => {}) })
  d.forge.users.set('a-teammate', { id: 31 })
  const preview = await d.host.call('trigger/preview', { root: repo.dir, id: 'ask' })
  await d.host.call('trigger/arm', { root: repo.dir, id: 'ask', token: preview.token! })
  await d.host.call('trigger/mode', { root: repo.dir, id: 'ask', mode: 'act' })
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  const at = d.clocks.wall + 1000
  d.forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9001, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
  d.clocks.advance(60000)
  const tick = d.host.intakePlane.tick()
  await sent
  const pending = await d.host.call('lead/mentionBudget/read', {})
  assert.ok(pending.reservedUsdMicros > 0)
  let reached!: () => void, budgetClosing = false
  const boundary = new Promise<void>(resolve => { reached = resolve })
  const originalIdle = CarryOnService.prototype.storageIdle, originalClose = MentionObserverBudget.prototype.close
  CarryOnService.prototype.storageIdle = async function () { await originalIdle.call(this); reached() }
  MentionObserverBudget.prototype.close = function () { budgetClosing = true; return originalClose.call(this) }
  const closing = d.stop()
  try {
    await boundary
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(budgetClosing, false, 'the budget stays open while the source delivery is in flight')
    assert.equal(signal.aborted, false, 'a complete response precedes the separate mention abort')
  } finally {
    CarryOnService.prototype.storageIdle = originalIdle; MentionObserverBudget.prototype.close = originalClose
    release(); await closing; await tick.catch(() => {})
  }
  const reopened = await intakeDesk({ repo, stateDir: d.stateDir, lead: true })
  t.after(() => reopened.stop())
  const budget = await reopened.host.call('lead/mentionBudget/read', {})
  assert.equal(calls, 1)
  assert.equal(budget.reservedUsdMicros, 0)
  assert.equal(budget.uncertainUsdMicros, 0, 'completed usage must not become uncertain at shutdown')
  assert.equal(budget.spentUsdMicros, 20)
})

test('assessment has a durable manual decision before provider dispatch', { timeout: 60000 }, async t => {
  const repo = await makeRepo('hd-mention-shutdown-')
  await commitTriggers(repo, trigger)
  let release!: () => void, started!: () => void, signal!: AbortSignal
  const held = new Promise<void>(resolve => { release = resolve })
  const sent = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const transport = { async send(request: { signal: AbortSignal }) {
    calls++; signal = request.signal; started(); await held
    return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) }
  } }
  const cipher = { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() }
  const d = await intakeDesk({ repo, lead: true, characterizationTransport: transport, characterizationSeed: async stateDir => {
    await new CredentialBroker(join(stateDir, 'credentials.json'), cipher).storeLead('anthropic', 'sk-test-not-real-0000')
  } })
  t.after(async () => { release(); await d.stop().catch(() => {}) })
  d.forge.users.set('a-teammate', { id: 31 })
  const preview = await d.host.call('trigger/preview', { root: repo.dir, id: 'ask' })
  await d.host.call('trigger/arm', { root: repo.dir, id: 'ask', token: preview.token! })
  await d.host.call('trigger/mode', { root: repo.dir, id: 'ask', mode: 'act' })
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  const at = d.clocks.wall + 1000
  d.forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9001, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
  d.clocks.advance(60000)
  const tick = d.host.intakePlane.tick()
  await sent
  try {
    const ledger = JSON.parse(await readFile(join(d.stateDir, 'triggers-mentions.json'), 'utf8'))
    assert.equal(ledger.assessed.count, 1)
    assert.equal(ledger.decisions.length, 1, 'replay must find a decision before the provider effect')
    assert.equal(ledger.decisions[0].decision, 'ask')
    assert.match(ledger.decisions[0].reason, /unconfirmed/i)
  } finally { release(); await tick.catch(() => {}) }
  assert.equal(calls, 1)
})


for (const crashPoint of ['after-dispatch', 'before-proof'] as const) test(`a crashed assessment at ${crashPoint} is not automatically resent and can be manually re-evaluated`, { timeout: 60000 }, async t => {
  const repo = await makeRepo('hd-mention-crash-')
  await commitTriggers(repo, trigger)
  const stateDir = tempDir('hd-mention-crash-state-')
  const child = fork(new URL('./fixtures/mention-crash.js', import.meta.url), [repo.dir, stateDir, crashPoint], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr?.on('data', chunk => { errors += String(chunk) })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGKILL'); await exited
    }
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dispatch deadline: ${errors}`)), 15000)
    child.once('message', message => { clearTimeout(timer); message === crashPoint ? resolve() : reject(new Error('unexpected fixture message')) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`child exited before dispatch: ${errors}`)) })
  })
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL'); await exit
  const clocks = new Clocks(1800000000000); clocks.advance(60000)
  let calls = 0
  const transport = { async send() { calls++; return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) } } }
  const d = await intakeDesk({ repo, stateDir, clocks, lead: true, characterizationTransport: transport })
  t.after(() => d.stop())
  d.forge.users.set('a-teammate', { id: 31 })
  const at = 1800000001000
  d.forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9001, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
  clocks.advance(60000); await d.host.intakePlane.tick()
  assert.equal(calls, 0, 'cursor replay does not resend an uncertain assessment')
  const page = await d.host.call('trigger/decisions', { root: repo.dir, id: 'ask' })
  const decision = page.decisions.find(one => one.comment.id === '9001')
  assert.ok(decision); assert.match(decision.reason, /unconfirmed/i)
  const budget = await d.host.call('lead/mentionBudget/read', {})
  if (crashPoint === 'after-dispatch') assert.ok(budget.uncertainUsdMicros > 0)
  else assert.equal(budget.uncertainUsdMicros, 0, 'no provider reservation was made before this fixture stopped')
  assert.equal(JSON.parse(await readFile(join(stateDir, 'triggers-mentions.json'), 'utf8')).assessed.count, 1, 'a crash before no-send proof keeps its daily count')
  const comment = d.forge.issues[0]!.comments[0]!
  comment.body = '@dex please fix an edited request'
  comment.updated = d.forge.issues[0]!.updated = clocks.wall + 1000
  clocks.advance(60000); await d.host.intakePlane.tick()
  assert.equal(calls, 0, 'an edited comment is not sent automatically')
  await assert.rejects(d.host.call('trigger/decision/reevaluate', { root: repo.dir, id: 'ask', decision: decision.id }), /edited after it was first read/)
  comment.body = '@dex please fix this'
  const rearm = await d.host.call('trigger/preview', { root: repo.dir, id: 'ask' })
  await d.host.call('trigger/arm', { root: repo.dir, id: 'ask', token: rearm.token! })
  clocks.advance(60000); await d.host.intakePlane.tick()
  assert.equal(calls, 0, 'rearming does not resend the prior uncertain comment')
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 0 })
  const beforeRefusal = JSON.parse(await readFile(join(stateDir, 'triggers-mentions.json'), 'utf8')).assessed.count
  const refused = await d.host.call('trigger/decision/reevaluate', { root: repo.dir, id: 'ask', decision: decision.id })
  assert.match(refused.reason, /unconfirmed/i, 'a refused new attempt cannot erase the earlier uncertainty')
  assert.equal(JSON.parse(await readFile(join(stateDir, 'triggers-mentions.json'), 'utf8')).assessed.count, beforeRefusal)
  assert.equal(calls, 0)
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  await d.host.call('trigger/decision/reevaluate', { root: repo.dir, id: 'ask', decision: decision.id })
  assert.equal(calls, 1, 'a person can explicitly request a new assessment')
})

for (const startingCap of [0, 1]) test(`a no-send assessment at cap ${startingCap} does not consume the last daily slot`, { timeout: 60000 }, async t => {
  const repo = await makeRepo('hd-mention-count-')
  await commitTriggers(repo, trigger)
  const stateDir = tempDir('hd-mention-count-state-')
  const date = new Date(), now = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12)
  const clocks = new Clocks(now)
  await writeFile(join(stateDir, 'triggers-mentions.json'), JSON.stringify({ version: 1, decisions: [], threads: [], modes: {}, assessed: { day: new Date(now).toISOString().slice(0, 10), count: 199 } }))
  let sends = 0
  const transport = { async send() { sends++; return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) } } }
  const cipher = { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() }
  const d = await intakeDesk({ repo, stateDir, clocks, lead: true, characterizationTransport: transport, characterizationSeed: async home => {
    await new CredentialBroker(join(home, 'credentials.json'), cipher).storeLead('anthropic', 'sk-test-not-real-0000')
  } })
  t.after(() => d.stop())
  d.forge.users.set('a-teammate', { id: 31 })
  const preview = await d.host.call('trigger/preview', { root: repo.dir, id: 'ask' })
  await d.host.call('trigger/arm', { root: repo.dir, id: 'ask', token: preview.token! })
  await d.host.call('trigger/mode', { root: repo.dir, id: 'ask', mode: 'act' })
  if (startingCap) await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: startingCap })
  const say = async (number: number) => {
    const at = clocks.wall + 1000
    d.forge.issues.push({ number, state: 'open', created: at, updated: at, events: [], comments: [{ id: 9000 + number, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
    clocks.advance(60000); await d.host.intakePlane.tick()
  }
  await say(1)
  assert.equal(sends, 0)
  const after = JSON.parse(await readFile(join(stateDir, 'triggers-mentions.json'), 'utf8'))
  await d.host.call('lead/mentionBudget/configure', { dailyCapUsdMicros: 1000000 })
  await say(2)
  assert.equal(after.assessed.count, 199, 'a proven no-send did not consume the last slot')
  assert.equal(sends, 1, 'the funded next request may use the last slot')
})

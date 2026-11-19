import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { canBeginLeadGoal, createLeadJournal } from '@harnessdesk/lead'
import { LeadFileJournal } from '../src/lead/journal.js'
import { createLeadRig } from './fixtures/lead-rig.js'
import { FakeForge, Clocks } from './fixtures/intake-forge.js'
import { LEAD_MESSAGES_DEFAULTS } from '@harnessdesk/lead'
import { CredentialBroker } from '../src/credentials.js'
import { intakeDesk, commitTriggers } from './fixtures/intake-host.js'
import { makeRepo } from './fixtures/evidence-desk.js'

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
  const closing = d.stop()
  const releaseTimer = setTimeout(release, 500)
  try { await assert.rejects(closing) } finally { clearTimeout(releaseTimer); release() }
  await tick.catch(() => {})
  const reopened = await intakeDesk({ repo, stateDir: d.stateDir, lead: true })
  t.after(() => reopened.stop())
  assert.ok(reopened.host, 'the unrelated Host writer lease was released')
})

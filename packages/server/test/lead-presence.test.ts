import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { LEAD_PRESENCE_LIMITS, capLeadPushText, parseLeadPresenceView, type LeadAsk, type LeadDeviceRef, type LeadWorkCard } from '@harnessdesk/protocol'
import { LEAD_DIGEST_OBSERVER_DAILY_MICROS, LeadPresenceStore, type LeadPresencePorts } from '../src/lead/presence.js'

const MIN = 60_000
const desktop: LeadDeviceRef = { id: 'window:main', label: 'Desktop' }
const phone: LeadDeviceRef = { id: 'phone:p1', label: 'Jane’s iPhone' }
const work = (id: string, stage: LeadWorkCard['stage'], at: number, extra: Partial<LeadWorkCard> = {}): LeadWorkCard => ({
  id, title: `Item ${id}`, project: 'acme-app', stage, group: stage === 'needs-you' ? 'needs-you' : stage === 'done' || stage === 'stopped' ? 'done' : 'working',
  links: { chats: [], teams: [], prs: [], issues: [] }, createdAt: 0, updatedAt: at, ...extra,
})

const rig = async (t: TestContext, over: Partial<LeadPresencePorts> = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'lead-presence-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let now = new Date(2026, 10, 10, 6, 0).getTime(), spent = 0, revision = 10, quiet = false
  let items: LeadWorkCard[] = []
  let messages: { id: string; role: string; text: string; ask?: LeadAsk }[] = []
  const pushes: unknown[] = []
  const observed: unknown[] = []
  const ports: LeadPresencePorts = {
    file: join(home, 'lead', 'presence.json'), now: () => now, spent: () => spent, revision: () => revision,
    board: async () => ({ version: 1, items, more: 0 }), waiting: () => [], messages: () => messages,
    quiet: async () => quiet, name: () => 'Dex', push: notice => { pushes.push(notice) }, ...over,
  }
  const store = new LeadPresenceStore(ports)
  return { store, ports, home, pushes, observed, file: ports.file,
    tick: (ms: number) => { now += ms }, setNow: (at: number) => { now = at }, now: () => now,
    spend: (micros: number) => { spent += micros }, setItems: (next: LeadWorkCard[]) => { items = next },
    setMessages: (next: typeof messages) => { messages = next }, setQuiet: (value: boolean) => { quiet = value },
    bump: () => { revision++ }, reopen: () => new LeadPresenceStore(ports) }
}

test('a short absence is a glance; thirty minutes away brings one digest of what changed', async t => {
  const r = await rig(t)
  await r.store.read(desktop, { active: true })
  r.tick(10 * MIN)
  r.setItems([work('work-1', 'done', r.now(), { closedAt: r.now(), outcome: 'done', fact: 'PR merged' })])
  assert.equal((await r.store.read(desktop, { active: true })).digest, null, 'ten minutes is not an absence')
  r.tick(40 * MIN)
  r.setItems([
    work('work-1', 'done', r.now() - 30 * MIN, { closedAt: r.now() - 30 * MIN, outcome: 'done', fact: 'PR merged' }),
    work('work-2', 'needs-you', r.now() - 5 * MIN, { blocker: 'An approval waits for you' }),
    work('work-3', 'stopped', r.now() - 4 * MIN, { fact: 'A Team stopped' }),
    work('work-0', 'done', 1, { closedAt: 1, outcome: 'done' }),
  ])
  r.spend(1_500_000)
  const view = await r.store.read(desktop, { active: true })
  const digest = view.digest!
  assert.deepEqual(digest.items.map(item => [item.kind, item.id, item.fact]), [['waiting', 'work-2', 'An approval waits for you'], ['stopped', 'work-3', 'A Team stopped'], ['done', 'work-1', 'PR merged']])
  assert.equal(digest.spentUsdMicros, 1_500_000)
  assert.equal(digest.summary, undefined, 'three items but no observer port: no paragraph')
  parseLeadPresenceView(view)
  assert.equal((await r.store.read(desktop, { active: true })).digest?.id, digest.id, 'the same digest stays until it is dismissed')
})

test('the digest is the same on the window and the phone; dismissing on one leaves the other', async t => {
  const r = await rig(t)
  await r.store.read(desktop, { active: true }); await r.store.read(phone, { active: true })
  r.tick(2 * 60 * MIN)
  r.setItems([work('work-2', 'needs-you', r.now() - MIN)])
  r.spend(40_000)
  const onDesktop = (await r.store.read(desktop, { active: true })).digest!
  const onPhone = (await r.store.read(phone, { active: true })).digest!
  assert.deepEqual(onPhone, onDesktop)
  const after = await r.store.dismiss(desktop, onDesktop.id)
  assert.equal(after.digest, null)
  assert.equal((await r.store.read(desktop, { active: true })).digest, null, 'dismissed stays dismissed')
  assert.deepEqual((await r.store.read(phone, { active: true })).digest, onPhone, 'the phone still has its own')
  const reopened = r.reopen()
  assert.deepEqual((await reopened.read(phone, { active: true })).digest, onPhone, 'marks survive a restart')
})

test('"What happened?" builds a digest on demand, and nothing new is said so', async t => {
  const r = await rig(t)
  await r.store.read(desktop, { active: true })
  r.tick(2 * MIN)
  const quiet = (await r.store.read(desktop, { active: true, recap: true })).digest!
  assert.equal(quiet.kind, 'recap'); assert.deepEqual(quiet.items, [])
  r.setItems([work('work-4', 'done', r.now(), { closedAt: r.now(), outcome: 'done' })])
  const next = (await r.store.read(desktop, { active: true, recap: true })).digest!
  assert.deepEqual(next.items.map(item => item.id), ['work-4'])
})

test('decisions that belong to no work item count as waiting on you', async t => {
  const waiting = [{ id: 'plan-1', title: 'A plan waits for you', position: 12 }, { id: 'plan-0', title: 'Old plan', position: 3 }]
  const r = await rig(t, { waiting: () => waiting })
  await r.store.read(desktop, { active: true })
  r.tick(40 * MIN)
  const digest = (await r.store.read(desktop, { active: true })).digest!
  assert.deepEqual(digest.items.map(item => item.id), ['plan-1'])
})

test('a paragraph comes from the observer model only when three items changed, and its cost is counted and capped', async t => {
  let calls = 0
  const r = await rig(t, { observe: async () => { calls++; return { text: 'Two things finished and one needs you.', usdMicros: 7_000 } } })
  await r.store.read(desktop, { active: true })
  r.tick(40 * MIN)
  r.setItems([work('work-1', 'needs-you', r.now()), work('work-2', 'needs-you', r.now())])
  assert.equal((await r.store.read(desktop, { active: true })).digest?.summary, undefined)
  assert.equal(calls, 0, 'two items changed: no model call')
  await r.store.dismiss(desktop, (await r.store.read(desktop, { active: true })).digest!.id)
  r.tick(40 * MIN)
  r.setItems([work('work-1', 'needs-you', r.now()), work('work-2', 'needs-you', r.now()), work('work-3', 'stopped', r.now())])
  r.spend(100_000)
  const digest = (await r.store.read(desktop, { active: true })).digest!
  assert.equal(digest.summary, 'Two things finished and one needs you.')
  assert.equal(digest.summaryUsdMicros, 7_000)
  assert.equal(digest.spentUsdMicros, 107_000, 'the paragraph is part of the spend reported')
  assert.equal(calls, 1)
  let big = await rig(t, { observe: async () => ({ text: 'Again.', usdMicros: LEAD_DIGEST_OBSERVER_DAILY_MICROS }) })
  await big.store.read(desktop, { active: true })
  for (let round = 0; round < 2; round++) {
    big.tick(40 * MIN)
    big.setItems(['a', 'b', 'c'].map(id => work(`work-${id.charCodeAt(0)}`, 'needs-you', big.now())))
    const view = await big.store.read(desktop, { active: true })
    assert.equal(view.digest?.summary, round === 0 ? 'Again.' : undefined, 'the day’s allowance is spent after the first')
    await big.store.dismiss(desktop, view.digest!.id)
  }
})

test('a failing observer leaves the deterministic digest alone', async t => {
  const r = await rig(t, { observe: async () => { throw new Error('offline') } })
  await r.store.read(desktop, { active: true })
  r.tick(40 * MIN)
  r.setItems(['1', '2', '3'].map(id => work(`work-${id}`, 'needs-you', r.now())))
  const digest = (await r.store.read(desktop, { active: true })).digest!
  assert.equal(digest.items.length, 3); assert.equal(digest.summary, undefined)
})

const ask = (minutes?: number): LeadAsk => ({ question: 'Start it?', options: [{ id: 'start', label: 'Start it' }, { id: 'later', label: 'Not now' }], recommended: 'start', ...(minutes ? { expiresInMinutes: minutes } : {}) })

test('an expired ask can no longer be answered, and says so; an unexpired one becomes a receipt naming who answered', async t => {
  const r = await rig(t)
  r.setMessages([{ id: 'message-3', role: 'assistant', text: 'Start it?', ask: ask(30) }])
  let view = await r.store.read(desktop, { active: true })
  assert.deepEqual(view.asks.map(a => [a.id, a.status]), [['message-3', 'open']])
  assert.equal(view.asks[0]!.expiresAt, r.now() + 30 * MIN)
  const record = await r.store.beforeSend(phone, 'Start it')
  assert.ok(record, 'an option’s label is an answer')
  r.tick(5 * MIN)
  await record()
  view = await r.store.read(desktop, { active: true })
  assert.deepEqual(view.asks[0], { id: 'message-3', status: 'answered', expiresAt: view.asks[0]!.expiresAt, answer: { option: 'Start it', by: 'Jane’s iPhone', at: r.now() } })
  r.tick(60 * MIN)
  assert.equal((await r.store.read(desktop, { active: true })).asks[0]!.status, 'answered', 'an answer never turns into an expiry')

  r.setMessages([{ id: 'message-5', role: 'assistant', text: 'Start it?', ask: ask(30) }])
  await r.store.read(desktop, { active: true })
  r.tick(31 * MIN)
  await assert.rejects(r.store.beforeSend(desktop, 'Not now'), (error: Error & { wireCode?: string }) => error.wireCode === 'lead-ask-expired')
  assert.equal((await r.store.read(desktop, { active: true })).asks.find(a => a.id === 'message-5')!.status, 'expired')
  assert.equal(await r.store.beforeSend(desktop, 'Something else entirely'), null, 'free text is still a message')
})

test('an ask with no expiry stays open; the host, not the model, sets the clock', async t => {
  const r = await rig(t)
  r.setMessages([{ id: 'message-3', role: 'assistant', text: 'Start it?', ask: ask() }])
  await r.store.read(desktop, { active: true })
  r.tick(30 * 24 * 60 * MIN)
  const view = await r.store.read(desktop, { active: true })
  assert.deepEqual(view.asks, [{ id: 'message-3', status: 'open' }])
  assert.ok(await r.store.beforeSend(desktop, 'Start it'))
})

test('the morning brief is off by default, waits for its time, once a day, and respects quiet hours', async t => {
  const r = await rig(t)
  assert.deepEqual(await r.store.brief(), { enabled: false, at: '07:30' })
  assert.equal(await r.store.tick(), false)
  await r.store.updateBrief({ enabled: true, at: '07:30' })
  await r.store.read(desktop, { active: true })
  r.setItems([work('work-2', 'needs-you', r.now())])
  assert.equal(await r.store.tick(), false, 'before the time')
  r.setNow(new Date(2026, 10, 10, 7, 31).getTime())
  r.setQuiet(true)
  assert.equal(await r.store.tick(), false, 'quiet hours hold it')
  assert.equal(r.pushes.length, 0)
  r.setQuiet(false)
  r.setNow(new Date(2026, 10, 10, 8, 5).getTime())
  assert.equal(await r.store.tick(), true, 'it goes out when quiet hours end, the same day')
  assert.equal(r.pushes.length, 1, 'one push')
  assert.equal(await r.store.tick(), false, 'once a day')
  const push = r.pushes[0] as { phone: { title: string; body: string } }
  assert.equal(push.phone.title, 'Dex: morning brief')
  const onDesktop = (await r.store.read(desktop, { active: true })).digest!
  const onPhone = (await r.store.read(phone, { active: true })).digest!
  assert.equal(onDesktop.kind, 'brief'); assert.deepEqual(onPhone, onDesktop)
  await r.store.dismiss(desktop, onDesktop.id)
  assert.equal((await r.store.read(desktop, { active: true })).digest, null)
  assert.equal((await r.store.read(phone, { active: true })).digest?.id, onDesktop.id)
  r.setNow(new Date(2026, 10, 11, 7, 40).getTime())
  assert.equal(await r.store.tick(), true, 'the next day')
})

test('switching the brief on after its time does not send one at once', async t => {
  const r = await rig(t)
  r.setNow(new Date(2026, 10, 10, 9, 0).getTime())
  await r.store.updateBrief({ enabled: true })
  assert.equal(await r.store.tick(), false)
  assert.equal(r.pushes.length, 0)
})

test('push text is capped per transport on one flat line', () => {
  const long = `${'word '.repeat(200)}\n\u0007end`
  const phone = capLeadPushText('phone', { title: long, body: long })
  assert.ok(phone.title.length <= 80 && [...phone.body].length <= 240)
  assert.ok(!/[\n\u0007]/.test(phone.body))
  const window = capLeadPushText('window', { title: 'Dex', body: long })
  assert.ok([...window.body].length <= 400 && [...window.body].length > 240)
  assert.equal(capLeadPushText('phone', { title: 'a', body: 'short' }).body, 'short')
  assert.ok(LEAD_PRESENCE_LIMITS.awayMs === 30 * MIN)
})

test('a file that cannot be read is never written over', async t => {
  const r = await rig(t)
  await r.store.read(desktop, { active: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(r.file, '{not json')
  const broken = r.reopen()
  await assert.rejects(broken.read(desktop, { active: true }), /could not be read/)
  assert.equal(await readFile(r.file, 'utf8'), '{not json')
})

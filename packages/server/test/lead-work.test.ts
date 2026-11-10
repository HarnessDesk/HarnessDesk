import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { LEAD_WORK_GROUPS, parseLeadWorkBoard, parseLeadWorkDetail, type LeadStage, type LeadWorkBoard } from '@harnessdesk/protocol'
import { LeadWorkLedger, wakeForLeadWork, type LeadWorkLinkState } from '../src/lead/work.js'

const rig = async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), 'lead-work-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const chats = new Map<string, LeadWorkLinkState | null>()
  const teams = new Map<string, LeadWorkLinkState & { readonly done: boolean }>()
  const prs: { ref: string; state: 'open' | 'merged' | 'closed'; failing: boolean }[] = []
  const published: LeadWorkBoard[] = []
  let now = 1_000_000, replies = 0
  const ports = {
    file: join(home, 'lead', 'work.json'), now: () => now, project: () => 'acme-app',
    chat: (id: string) => chats.has(id) ? chats.get(id)! : null,
    teams: async () => teams,
    pullRequests: () => prs,
    replies: () => replies,
    publish: (board: LeadWorkBoard) => { published.push(board) },
  }
  const ledger = await LeadWorkLedger.open(ports)
  const chat = (id: string, stage: LeadStage, reason = stage === 'idle' ? 'idle' : stage === 'working' ? 'running' : 'worker-approval') => { chats.set(id, { stage, reason }) }
  return { ledger, ports, chats, teams, prs, published, chat, file: ports.file,
    tick: (ms: number) => { now += ms }, now: () => now, reply: () => { replies++ }, reopen: () => LeadWorkLedger.open(ports) }
}
const start = async (r: Awaited<ReturnType<typeof rig>>, title: string, quotes: readonly string[], chatId: string, ledgerItem?: string) => {
  const claim = await r.ledger.claim({ title, quotes, ...(ledgerItem ? { ledgerItem } : {}) })
  if ('problem' in claim) return claim
  r.chat(chatId, 'queued', 'send-queued')
  return { item: await r.ledger.started(claim, chatId) }
}
const card = (board: LeadWorkBoard, id: string) => board.items.find(item => item.id === id)!

test('a duplicate start is refused with the open item named, and ledgerItem attaches instead', async t => {
  const r = await rig(t)
  const first = await start(r, 'Fix the login redirect', ['m-1'], 'fixture:a')
  assert.deepEqual(first, { item: 'work-1' })
  const sameQuote = await r.ledger.claim({ title: 'Something else entirely', quotes: ['m-1'] })
  assert.ok('problem' in sameQuote)
  assert.match(sameQuote.problem, /work-1/)
  assert.match(sameQuote.problem, /Fix the login redirect/)
  assert.match(sameQuote.problem, /ledgerItem/)
  const sameTitle = await r.ledger.claim({ title: 'fix the login redirect!', quotes: ['m-2'] })
  assert.ok('problem' in sameTitle && /work-1/.test(sameTitle.problem), 'a matching title is refused too')
  const reworded = await r.ledger.claim({ title: 'Fix the login redirect bug', quotes: ['m-5'] })
  assert.ok('problem' in reworded && /work-1/.test(reworded.problem), 'a reworded title is refused too')
  const numbered = await r.ledger.claim({ title: 'Fix issue 41 in the sync suite', quotes: ['m-6'] })
  assert.ok(!('problem' in numbered))
  r.ledger.release(numbered)
  const another = await r.ledger.claim({ title: 'Fix issue 42 in the sync suite', quotes: ['m-7'] })
  assert.ok(!('problem' in another), 'a different number is different work')
  r.ledger.release(another)
  const attached = await start(r, 'Add a test for the redirect', ['m-1'], 'fixture:b', 'work-1')
  assert.deepEqual(attached, { item: 'work-1' })
  assert.deepEqual(card(await r.ledger.board(), 'work-1').links.chats, ['fixture:a', 'fixture:b'])
  const other = await start(r, 'Update the changelog', ['m-3'], 'fixture:c')
  assert.deepEqual(other, { item: 'work-2' }, 'different work from a different message is new work')
  const unknown = await r.ledger.claim({ title: 'Anything', quotes: ['m-4'], ledgerItem: 'work-9' })
  assert.ok('problem' in unknown && /work-9/.test(unknown.problem))
})

test('a start in flight holds its claim, so a second identical start is refused before either lands', async t => {
  const r = await rig(t)
  const claim = await r.ledger.claim({ title: 'Bump the version', quotes: ['m-1'] })
  assert.ok(!('problem' in claim))
  const second = await r.ledger.claim({ title: 'Bump the version', quotes: ['m-1'] })
  assert.ok('problem' in second && /already starting/.test(second.problem))
  r.ledger.release(claim)
  assert.ok(!('problem' in (await r.ledger.claim({ title: 'Bump the version', quotes: ['m-1'] }))), 'a released claim no longer blocks')
})

test('stages follow scripted chat, Team and pull request changes, and the four groups keep Needs you first', async t => {
  const r = await rig(t)
  await start(r, 'Fix the login redirect', ['m-1'], 'fixture:a')
  await r.ledger.refresh()
  assert.equal(card(await r.ledger.board(), 'work-1').stage, 'queued')
  r.chat('fixture:a', 'working'); await r.ledger.refresh()
  assert.equal(card(await r.ledger.board(), 'work-1').stage, 'working')
  r.chat('fixture:a', 'you-answer', 'worker-approval'); await r.ledger.refresh()
  let item = card(await r.ledger.board(), 'work-1')
  assert.equal(item.stage, 'needs-you'); assert.equal(item.group, 'needs-you'); assert.match(item.blocker!, /approval/i)
  r.chat('fixture:a', 'working'); await r.ledger.refresh()
  r.chat('fixture:a', 'idle'); await r.ledger.refresh()
  item = card(await r.ledger.board(), 'work-1')
  assert.equal(item.stage, 'in-review', 'a finished chat waits for the Lead to report it')
  assert.match(item.fact!, /finished/i)
  r.reply(); await r.ledger.refresh()
  item = card(await r.ledger.board(), 'work-1')
  assert.equal(item.stage, 'done', 'every link settled: the chat finished and the Lead reported it')
  assert.equal(item.outcome, 'done'); assert.equal(item.group, 'done')
  r.chat('fixture:a', 'working'); await r.ledger.refresh()
  assert.equal(card(await r.ledger.board(), 'work-1').stage, 'working', 'an item the host closed reopens when its chat works again')

  r.teams.set('team-7', { stage: 'working', reason: 'running', done: false })
  await r.ledger.attach({ kind: 'mention', ref: 'https://github.com/acme/app/issues/4', title: 'Triage the flaky upload' }, { teams: ['team-7'], issues: ['acme/app#4'] })
  await r.ledger.refresh()
  assert.equal(card(await r.ledger.board(), 'work-2').stage, 'working')
  r.teams.set('team-7', { stage: 'you-review', reason: 'result-ready', done: false }); await r.ledger.refresh()
  assert.equal(card(await r.ledger.board(), 'work-2').stage, 'needs-you')
  r.teams.set('team-7', { stage: 'idle', reason: 'idle', done: true })
  await r.ledger.attach({ kind: 'mention', ref: 'https://github.com/acme/app/issues/4', title: 'Triage the flaky upload' }, { prs: ['acme/app#9'] })
  r.prs.push({ ref: 'acme/app#9', state: 'open', failing: true }); await r.ledger.refresh()
  item = card(await r.ledger.board(), 'work-2')
  assert.equal(item.stage, 'in-review'); assert.match(item.blocker!, /checks/i)
  r.prs[0] = { ref: 'acme/app#9', state: 'merged', failing: false }; await r.ledger.refresh()
  assert.equal(card(await r.ledger.board(), 'work-2').stage, 'done', 'the merged pull request settled the last link')

  await start(r, 'Write the release notes', ['m-5'], 'fixture:c')
  r.chat('fixture:c', 'you-blocked', 'failed')
  await start(r, 'Ship after the notes', ['m-6'], 'fixture:d')
  await r.ledger.note({ id: 'work-4', after: 'work-3' })
  r.chat('fixture:d', 'idle')
  await r.ledger.refresh()
  const board = await r.ledger.board()
  assert.equal(card(board, 'work-4').stage, 'blocked'); assert.equal(card(board, 'work-4').group, 'working')
  const order = board.items.map(entry => LEAD_WORK_GROUPS.indexOf(entry.group))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'groups arrive in board order')
  assert.equal(board.items[0]!.id, 'work-3', 'what needs the person comes first')
  assert.deepEqual(parseLeadWorkBoard(JSON.parse(JSON.stringify(board))), board)
  assert.deepEqual(r.published.at(-1), board, 'the host published the same projection it answers with')
})

test('the person closes with Done or Drop, closing is never undone by desk activity, and the file survives a restart', async t => {
  const r = await rig(t)
  await start(r, 'Fix the login redirect', ['m-1'], 'fixture:a')
  await start(r, 'Try the other approach', ['m-2'], 'fixture:b')
  await r.ledger.close({ id: 'work-1', outcome: 'done' })
  await r.ledger.close({ id: 'work-2', outcome: 'dropped' })
  r.chat('fixture:a', 'working'); await r.ledger.refresh()
  const board = await r.ledger.board()
  assert.equal(card(board, 'work-1').stage, 'done')
  assert.equal(card(board, 'work-2').stage, 'stopped'); assert.equal(card(board, 'work-2').outcome, 'dropped')
  const again = await r.ledger.claim({ title: 'Fix the login redirect', quotes: ['m-1'] })
  assert.ok(!('problem' in again), 'closed work never blocks a start')
  r.ledger.release(again)
  const reopened = await r.reopen()
  assert.deepEqual((await reopened.board()).items.map(item => [item.id, item.stage]), board.items.map(item => [item.id, item.stage]))
  const stored = JSON.parse(await readFile(r.file, 'utf8'))
  assert.equal(stored.version, 1); assert.equal(stored.items.length, 2)
  r.tick(31 * 24 * 60 * 60 * 1000); await reopened.refresh()
  assert.equal((await reopened.board()).items.length, 0, 'closed items are forgotten after thirty days')
})

test('a note is the only model write: it records text, an after link and a reminder, and never a stage', async t => {
  const r = await rig(t)
  await start(r, 'Fix the login redirect', ['m-1'], 'fixture:a')
  r.chat('fixture:a', 'working'); await r.ledger.refresh()
  const noted = await r.ledger.note({ id: 'work-1', note: 'Waiting on the design call before merging.', remindAt: r.now() + 2 * 60 * 60 * 1000 })
  assert.equal(noted.stage, 'working'); assert.equal(noted.note, 'Waiting on the design call before merging.')
  assert.equal((await r.ledger.dueReminders()).length, 0)
  r.tick(2 * 60 * 60 * 1000)
  const due = (await r.ledger.dueReminders())
  assert.deepEqual(due.map(entry => entry.id), ['work-1'])
  assert.match(due[0]!.text, /work-1/); assert.match(due[0]!.text, /Fix the login redirect/); assert.match(due[0]!.text, /design call/)
  await r.ledger.reminded('work-1', due[0]!.remindAt)
  assert.equal((await r.ledger.dueReminders()).length, 0, 'a delivered reminder does not fire again')
  assert.equal(card(await r.ledger.board(), 'work-1').remindAt, undefined)
  await assert.rejects(r.ledger.note({ id: 'work-1', after: 'work-1' }))
  await assert.rejects(r.ledger.note({ id: 'work-7', note: 'nope' }))
  const far = await r.ledger.note({ id: 'work-1', remindAt: r.now() + 90 * 24 * 60 * 60 * 1000 })
  assert.ok(far.remindAt! <= r.now() + 30 * 24 * 60 * 60 * 1000, 'a reminder is held to thirty days ahead')
  const detail = await r.ledger.read({ id: 'work-1' })
  assert.deepEqual(parseLeadWorkDetail(JSON.parse(JSON.stringify(detail))), detail)
  assert.deepEqual(detail.origin, { kind: 'person', quotes: ['m-1'] })
  assert.ok(detail.timeline.some(fact => /note/i.test(fact.text)))
})

test('attach creates one item for an accepted mention and later links join it rather than making another', async t => {
  const r = await rig(t)
  const first = await r.ledger.attach({ kind: 'mention', ref: 'https://github.com/acme/app/issues/12', title: 'Crash on empty upload' }, { issues: ['acme/app#12'] })
  const second = await r.ledger.attach({ kind: 'mention', ref: 'https://github.com/acme/app/issues/12', title: 'Crash on empty upload' }, { chats: ['fixture:x'], issues: ['acme/app#12'] })
  const third = await r.ledger.attach({ kind: 'trigger', ref: 'pr-opened', title: 'Review the fix' }, { prs: ['acme/app#13'], issues: ['acme/app#12'] })
  assert.equal(first, 'work-1'); assert.equal(second, 'work-1'); assert.equal(third, 'work-1', 'a shared issue link joins the open item')
  const item = card(await r.ledger.board(), 'work-1')
  assert.deepEqual(item.links, { chats: ['fixture:x'], teams: [], prs: ['acme/app#13'], issues: ['acme/app#12'] })
  assert.equal(item.stage, 'queued')
  const duplicate = await r.ledger.claim({ title: 'Crash on empty upload', quotes: [] })
  assert.ok('problem' in duplicate && /work-1/.test(duplicate.problem), 'a chat start for the same mention is refused too')
})

test('the board stays bounded: Done shows the latest eight, and a full ledger refuses new work in words', async t => {
  const r = await rig(t)
  for (let index = 1; index <= 12; index++) {
    await start(r, `Task number ${index} alpha`, [`m-${index}`], `fixture:${index}`)
    await r.ledger.close({ id: `work-${index}`, outcome: 'done' })
    r.tick(1000)
  }
  const board = await r.ledger.board()
  assert.equal(board.items.length, 8); assert.equal(board.more, 4)
  assert.equal(board.items[0]!.id, 'work-12', 'newest first inside a group')
  assert.equal((await r.ledger.board('all')).items.length, 12)
})

test('a due reminder wakes the Lead through the scheduled-run doors, once, and waits out quiet hours or a busy turn', async t => {
  const r = await rig(t)
  await start(r, 'Watch the release checks', ['m-1'], 'fixture:a')
  await r.ledger.note({ id: 'work-1', remindAt: r.now() + 60_000 })
  const calls: string[] = []
  let quiet = false, canBegin = false, accept = true
  const wake = {
    quiet: async () => quiet, canBegin: () => canBegin,
    offer: async (key: string, text: string, id: string) => { calls.push(`offer ${key} ${id} ${text}`); return accept },
    remind: async (key: string, text: string) => { calls.push(`remind ${key} ${text}`); return accept },
  }
  assert.equal(await wakeForLeadWork(r.ledger, wake), 0, 'nothing is due yet')
  r.tick(61_000)
  quiet = true
  assert.equal(await wakeForLeadWork(r.ledger, wake), 0)
  assert.deepEqual(calls, [], 'quiet hours hold the reminder')
  quiet = false; accept = false
  assert.equal(await wakeForLeadWork(r.ledger, wake), 0)
  assert.equal(calls.length, 1, 'a busy Lead is asked once and the reminder stays set')
  assert.ok(card(await r.ledger.board(), 'work-1').remindAt, 'an undelivered reminder is kept for the next tick')
  accept = true
  assert.equal(await wakeForLeadWork(r.ledger, wake), 1)
  const key = `work-reminder-work-1-${1_000_000 + 60_000}`
  assert.match(String(calls[1]), new RegExp(`^remind ${key} .*work-1.*Watch the release checks`), 'an open conversation takes the wake as a turn')
  assert.equal(String(calls[0]).split(' ')[1], key, 'a retry carries the same key, so it is never a second wake')
  assert.equal(card(await r.ledger.board(), 'work-1').remindAt, undefined, 'a delivered reminder is cleared')
  assert.equal(await wakeForLeadWork(r.ledger, wake), 0, 'and does not wake again')
  await r.ledger.note({ id: 'work-1', remindAt: r.now() })
  canBegin = true
  assert.equal(await wakeForLeadWork(r.ledger, wake), 1)
  assert.match(String(calls.at(-1)), /^offer work-reminder-work-1-\d+ work-1 /, 'a closed thread opens a goal the way a scheduled run does')
})

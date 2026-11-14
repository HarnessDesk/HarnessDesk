import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { leadChatHandleOf, leadWorkCards } from '@harnessdesk/lead'
import { rig, type Rig } from './fixtures/lead-attempts-rig.js'

type Card = { id: string, stage: string, fact?: string, stoppedBy?: string }
const card = async (r: Rig, id: string, done: (card: Card) => boolean): Promise<Card> => {
  for (let tries = 0; tries < 100; tries++) {
    const found = (await r.host.call('lead/work/list', {})).items.find(item => item.id === id) as Card | undefined
    if (found && done(found)) return found
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return (await r.host.call('lead/work/list', {})).items.find(item => item.id === id) as Card
}
const stopped = (found: Card) => found.stage === 'stopped'
const session = (r: Rig, id: string) => r.runtime.sessions.get(id.slice(id.indexOf(':') + 1))!
/** The window's door: the rail's Work menu Stop sends the same interrupt as the chat's own composer. */
const windowStop = (r: Rig, id: string) => r.host.call('turn/interrupt', { runtime: id.slice(0, id.indexOf(':')) as never, sessionId: id.slice(id.indexOf(':') + 1) as never })
const approveRetry = async (r: Rig, item: string, attempt: string) => {
  const handle = leadChatHandleOf(r.journal.state.chatHandles, attempt) ?? 'the existing chat'
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  await r.journal.appendReply(question, undefined, { question, retryOf: { item, attempt }, startsMarked: true,
    options: [{ id: 'start', label: 'Start another chat', starts: true }, { id: 'later', label: 'Not now' }], recommended: 'later' })
  await r.answer('Start another chat')
}

test('#2145: an explicit second attempt at open work waits for the person to answer', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, ledgerItem } = first.value as { id: string; ledgerItem: string }
  assert.ok(session(r, id))
  const before = r.runtime.sessions.size
  const duplicate = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)' } })
  assert.match((duplicate.value as { problem?: string }).problem ?? '', /open work/)
  assert.equal(r.runtime.sessions.size, before)
  const retry = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  assert.match((retry.value as { problem?: string }).problem ?? '', /ask/i, JSON.stringify(retry.value))
  assert.equal(r.runtime.sessions.size, before, 'no second chat before a question and answer')
})

for (const state of ['open', 'person-stopped'] as const) {
  test(`#2145 R2: a duplicate without an item prescribes an actionable bound question for ${state} work`, async t => {
    const r = await rig(t)
    await r.personWrites('Fix the stalled build a game task')
    const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
    const { id, ledgerItem } = first.value as { id: string; ledgerItem: string }
    if (state === 'person-stopped') { await windowStop(r, id); await card(r, ledgerItem, stopped) }
    const duplicate = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', cause: 'person' } })
    const problem = (duplicate.value as { problem?: string }).problem ?? ''
    const match = problem.match(/Ask the person ("(?:[^"\\]|\\.)*") with options/)
    assert.ok(match, `refusal must prescribe the canonical question: ${JSON.stringify(duplicate)}`)
    assert.ok(problem.includes(`retryOf { item: ${JSON.stringify(ledgerItem)}, attempt: ${JSON.stringify(id)} }`), problem)
    assert.match(problem, /id: start, starts: true/)
    assert.match(problem, /id: later.*recommended: later/)
    if (state === 'person-stopped') assert.match(problem, /stopped once/)
    const question = JSON.parse(match[1]!) as string
    await r.journal.appendReply(question, undefined, { question, retryOf: { item: ledgerItem, attempt: id }, startsMarked: true,
      options: [{ id: 'start', label: 'Start another chat', starts: true }, { id: 'later', label: 'Not now' }], recommended: 'later' })
    await r.answer('Start another chat')
    const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
    assert.ok((second.value as { id?: string }).id, JSON.stringify(second.value))
    assert.equal((second.value as { ledgerItem?: string }).ledgerItem, ledgerItem)
    assert.equal(r.runtime.sessions.size, 2)
    const third = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem } })
    assert.ok((third.value as { problem?: string }).problem, 'the answer admits only one retry')
  })
}

test('#2145: an explicit item cannot avoid asking by changing the title or project', async t => {
  const r = await rig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const item = (first.value as { ledgerItem: string }).ledgerItem
  const retitled = await r.execute({ method: 'lead/chat/start', params: { text: 'Proceed with this task', ledgerItem: item } })
  assert.ok((retitled.value as { problem?: string }).problem, JSON.stringify(retitled.value))
  assert.equal(r.runtime.sessions.size, 1, 'a changed title does not create a second chat')
  const distinct = await r.execute({ method: 'lead/chat/start', params: { text: 'Update the release notes' } })
  assert.ok((distinct.value as { id?: string }).id, 'distinct work without an item remains a fresh start')
  await r.stop()
  const { makeRepo } = await import('./fixtures/evidence-desk.js')
  const other = await rig(t, { stateDir: r.stateDir, records: r.records, repo: await makeRepo('hd-lead-other-project-') })
  const elsewhere = await other.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  assert.ok((elsewhere.value as { problem?: string }).problem, JSON.stringify(elsewhere.value))
  assert.equal(other.runtime.sessions.size, 0, 'changing projects does not grant a repeat')
})

test('#2145: an answered retry question permits only one new attempt', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, handle, ledgerItem } = first.value as { id: string; handle: string; ledgerItem: string }
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  const ask = { question, retryOf: { item: ledgerItem, attempt: id }, startsMarked: true as const,
    options: [{ id: 'start', label: 'Start another chat', starts: true as const }, { id: 'later', label: 'Not now' }], recommended: 'later' }
  await r.journal.appendReply(question, undefined, ask)
  await r.answer('I pick Start another chat')
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  assert.ok((second.value as { id?: string }).id, JSON.stringify(second.value))
  const count = r.runtime.sessions.size
  const third = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem } })
  assert.ok((third.value as { problem?: string }).problem, JSON.stringify(third.value))
  assert.equal(r.runtime.sessions.size, count)
})

test('#2145: an unrelated or negative answer cannot authorize a retry', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, handle, ledgerItem } = first.value as { id: string; handle: string; ledgerItem: string }
  const options = [{ id: 'start', label: 'Start another chat', starts: true as const }, { id: 'later', label: 'Not now' }]
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  await assert.rejects(r.journal.appendReply('Start unrelated work?', undefined, { question: 'Start unrelated work?', options, recommended: 'later', startsMarked: true,
    retryOf: { item: ledgerItem, attempt: id } }), /retry question/i)
  await assert.rejects(r.journal.appendReply(question, undefined, { question, options, recommended: 'start', startsMarked: true,
    retryOf: { item: ledgerItem, attempt: id } }), /retry question/i, 'the start option must not be recommended')
  await r.journal.appendReply('Start unrelated work?', undefined, { question: 'Start unrelated work?', options, recommended: 'later', startsMarked: true })
  await r.answer('Start another chat')
  const retry = () => r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  assert.ok(((await retry()).value as { problem?: string }).problem)
  await r.journal.appendReply(question, undefined, { question, options, recommended: 'later', startsMarked: true, retryOf: { item: ledgerItem, attempt: id } })
  await r.answer('Not now')
  assert.ok(((await retry()).value as { problem?: string }).problem)
  assert.equal(r.runtime.sessions.size, 1)
})

test('#2145: concurrent retries cannot spend one answer twice', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, handle, ledgerItem } = first.value as { id: string; handle: string; ledgerItem: string }
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  await r.journal.appendReply(question, undefined, { question, retryOf: { item: ledgerItem, attempt: id }, startsMarked: true,
    options: [{ id: 'start', label: 'Start another chat', starts: true }, { id: 'later', label: 'Not now' }], recommended: 'later' })
  await r.answer('Start another chat')
  const start = () => r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  const results = await Promise.all([start(), start()])
  assert.equal(results.filter(one => !!(one.value as { id?: string } | undefined)?.id).length, 1, JSON.stringify(results))
  assert.equal(r.runtime.sessions.size, 2)
})

test('#2145: a retry answer has to commit and name the current attempt', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, handle, ledgerItem } = first.value as { id: string; handle: string; ledgerItem: string }
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  const options = [{ id: 'start', label: 'Start another chat', starts: true as const }, { id: 'later', label: 'Not now' }]
  const retry = () => r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  await assert.rejects(r.journal.appendReply(question, undefined, { question, options, recommended: 'later', startsMarked: true, retryOf: { item: ledgerItem, attempt: 'fake:wrong' } }), /retry question/i)
  assert.ok(((await retry()).value as { problem?: string }).problem, 'a question for another attempt is not accepted')
  await r.journal.appendReply(question, undefined, { question, options, recommended: 'later', startsMarked: true, retryOf: { item: ledgerItem, attempt: id } })
  await r.host.leadPresence.observe()
  const finish = await r.host.leadPresence.beforeSend(undefined, 'Start another chat')
  await r.personWrites('Start another chat')
  assert.ok(((await retry()).value as { problem?: string }).problem, 'the answer is not committed while send is pending')
  await finish?.(false)
  assert.ok(((await retry()).value as { problem?: string }).problem, 'a failed answer never grants consent')
  assert.equal(r.runtime.sessions.size, 1)
})

test('#2145: a retry spent before an uncertain create stays spent after Host restart', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, handle, ledgerItem } = first.value as { id: string; handle: string; ledgerItem: string }
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  await r.journal.appendReply(question, undefined, { question, retryOf: { item: ledgerItem, attempt: id }, startsMarked: true,
    options: [{ id: 'start', label: 'Start another chat', starts: true }, { id: 'later', label: 'Not now' }], recommended: 'later' })
  await r.answer('Start another chat')
  r.runtime.createSession = async () => { throw new Error('controlled uncertain create') }
  await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  await r.stop()
  const restarted = await rig(t, r)
  const disk = JSON.parse(readFileSync(`${restarted.stateDir}/lead/work.json`, 'utf8')) as { items: { id: string; retryConsumed?: string }[] }
  assert.ok(disk.items.find(item => item.id === ledgerItem)?.retryConsumed, 'the consumed receipt survives Host restart')
  const again = await restarted.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  assert.equal(again.outcome, 'denied', 'the journal also holds an uncertain dispatch for recovery')
  assert.equal(restarted.runtime.sessions.size, 0)
})

test('#2145: a committed retry answer remains bound after Host restart', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, handle, ledgerItem } = first.value as { id: string; handle: string; ledgerItem: string }
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  await r.journal.appendReply(question, undefined, { question, retryOf: { item: ledgerItem, attempt: id }, startsMarked: true,
    options: [{ id: 'start', label: 'Start another chat', starts: true }, { id: 'later', label: 'Not now' }], recommended: 'later' })
  await r.answer('Start another chat')
  await r.stop()
  const restarted = await rig(t, r)
  await restarted.host.leadPresence.observe()
  restarted.runtime.reserveSessionIds(1)
  const result = await restarted.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  assert.ok((result.value as { id?: string } | undefined)?.id, JSON.stringify(result))
  assert.equal(restarted.runtime.sessions.size, 1)
})

test('#2145: a stop invalidates an earlier unspent retry answer for the same chat', async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, ledgerItem } = first.value as { id: string; ledgerItem: string }
  await approveRetry(r, ledgerItem, id)
  await windowStop(r, id)
  await card(r, ledgerItem, stopped)
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  assert.ok((second.value as { problem?: string }).problem, JSON.stringify(second.value))
  assert.equal(r.runtime.sessions.size, 1)
})

test('#2108: a stop from the window or the phone on a later attempt under the same item is the person\'s, and the Lead\'s cards say so', async t => {
  const r = await rig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  assert.equal(first.outcome, 'succeeded')
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  assert.ok(session(r, one))
  await windowStop(r, one)
  let found = await card(r, item, stopped)
  assert.equal(found.stoppedBy, 'person', 'the window\'s stop is the person\'s')
  assert.equal(found.fact, 'Stopped: the person stopped its chat')

  // Another attempt under the same item, once the host asked and the person said to start it (#2145), which they stop
  // from the phone's work list.
  assert.ok(((await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })).value as { problem?: string }).problem)
  await approveRetry(r, item, one)
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  assert.equal(second.outcome, 'succeeded', JSON.stringify(second.value))
  const two = (second.value as { id: string }).id
  found = await card(r, item, one => one.stage !== 'stopped')
  await r.host.call('workspace/stop', { id: two })
  found = await card(r, item, stopped)
  assert.equal(found.stoppedBy, 'person', 'the second attempt\'s stop is the person\'s too')
  assert.equal(found.fact, 'Stopped: the person stopped its chat')

  // What the Lead reads on every request names who stopped it, so it never says it does not know.
  const block = leadWorkCards(await r.host.call('lead/work/list', {}), Date.now())!
  assert.match(block, new RegExp(`${item} \\[stopped\\][^\\n]*stopped by the person`), block)
})

/** Two attempts under one item, each stopped by the person from the window. Returns the item and the second chat. */
const twiceStopped = async (r: Rig): Promise<{ item: string, last: string }> => {
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  await windowStop(r, one)
  await card(r, item, stopped)
  // One stop already asks first (#2145): the host refuses once, then the person says to start again.
  assert.ok(((await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })).value as { problem?: string }).problem)
  await approveRetry(r, item, one)
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  const last = (second.value as { id: string }).id
  await card(r, item, found => found.stage !== 'stopped')
  await windowStop(r, last)
  await card(r, item, stopped)
  return { item, last }
}

test('#2108: a third attempt at an item stopped twice is refused until the person answers, even when the person asked for it', async t => {
  const r = await rig(t)
  const { item, last } = await twiceStopped(r)
  await r.personWrites('Try the build task again')
  const chats = r.runtime.sessions.size
  const refused = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  const problem = (refused.value as { problem?: string }).problem
  assert.ok(problem, `the host refuses the third attempt: ${JSON.stringify(refused.value)}`)
  assert.equal(r.runtime.sessions.size, chats, 'no chat was started')
  assert.match(problem, /stopped twice/)
  assert.match(problem, /the person stopped/)
  assert.match(problem, new RegExp(last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'it names the last chat, to continue')
  assert.match(problem, /continue/i); assert.match(problem, /fresh/i); assert.match(problem, /drop/i)
  // Asking again without the person answering is refused again: the guard is the host's, not the instruction's.
  const again = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  assert.ok((again.value as { problem?: string }).problem)
  // A new title for the same work is the same item: refused the same way, never a way around the guard.
  const renamed = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task again', cause: 'person' } })
  assert.ok((renamed.value as { problem?: string }).problem, JSON.stringify(renamed))
  // The person answers: start fresh. The next attempt goes ahead under the same item.
  await approveRetry(r, item, last)
  const third = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  assert.equal(typeof (third.value as { id?: string }).id, 'string', JSON.stringify(third.value))
  assert.equal((third.value as { ledgerItem?: string }).ledgerItem, item)
})

test('#2108: the stops ride the card, so the rail and the phone can say who stopped each attempt', async t => {
  const r = await rig(t)
  const { item } = await twiceStopped(r)
  const found = await card(r, item, stopped) as Card & { stops?: { by?: string }[] }
  assert.deepEqual(found.stops?.map(stop => stop.by), ['person', 'person'])
  const block = leadWorkCards(await r.host.call('lead/work/list', {}), Date.now())!
  assert.match(block, /2 attempts stopped \(the person stopped it each time\)/)
})

test('#2108 review: the Lead stopping its own chat twice is not the person saying no, so another attempt goes ahead', async t => {
  const r = await rig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  assert.equal((await r.execute({ method: 'lead/chat/stop', params: { id: one } })).outcome, 'succeeded')
  await card(r, item, stopped)
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  const two = (second.value as { id: string }).id
  await card(r, item, found => found.stage !== 'stopped')
  assert.equal((await r.execute({ method: 'lead/chat/stop', params: { id: two } })).outcome, 'succeeded')
  const found = await card(r, item, stopped) as Card & { stops?: { by?: string }[] }
  assert.deepEqual(found.stops?.map(stop => stop.by), ['lead', 'lead'], 'both stops were the Lead\'s own')
  const chats = r.runtime.sessions.size
  const third = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  assert.equal(typeof (third.value as { id?: string }).id, 'string', `no question first: ${JSON.stringify(third.value)}`)
  assert.equal(r.runtime.sessions.size, chats + 1, 'the third attempt started')
})

test('#2117 review 4: a stop after the person answered asks again; their earlier answer does not cover the next attempt', async t => {
  const r = await rig(t)
  const { item, last } = await twiceStopped(r)
  await r.personWrites('Try the build task again')
  const refused = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  assert.ok((refused.value as { problem?: string }).problem, 'the host asks first')
  // The person answers: continue the last chat. The Lead does, and the person stops that chat again.
  await r.personWrites('Continue the last chat')
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: last, text: 'Carry on from where you stopped' } })).outcome, 'succeeded')
  await card(r, item, found => found.stage !== 'stopped')
  await windowStop(r, last)
  const found = await card(r, item, one => stopped(one) && ((one as Card & { stops?: unknown[] }).stops?.length ?? 0) === 3) as Card & { stops?: { by?: string }[] }
  assert.deepEqual(found.stops?.map(stop => stop.by), ['person', 'person', 'person'])
  // A fresh start now is a new question, not the answer the person gave before this stop.
  const chats = r.runtime.sessions.size
  const fresh = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (fresh)', ledgerItem: item } })
  assert.match((fresh.value as { problem?: string }).problem ?? '', /stopped 3 times/, JSON.stringify(fresh.value))
  assert.equal(r.runtime.sessions.size, chats, 'no chat was started')
  await approveRetry(r, item, last)
  const after = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (fresh)', ledgerItem: item } })
  assert.equal(typeof (after.value as { id?: string }).id, 'string', JSON.stringify(after.value))
})

test('#2145: a second attempt at work the person stopped once is refused until the person answers, even under ledgerItem after they asked for it', async t => {
  const r = await rig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  await windowStop(r, one)
  await card(r, item, stopped)
  // The person asks for another chat; the Lead names the stopped item, as the r4 sitting's desktop turn did.
  await r.personWrites('Open another chat to fix build a game')
  const chats = r.runtime.sessions.size
  const refused = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  const problem = (refused.value as { problem?: string }).problem ?? ''
  assert.match(problem, /Nothing was started/, JSON.stringify(refused.value))
  assert.match(problem, /stopped once/)
  assert.match(problem, new RegExp(one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'it names the last chat, to continue')
  assert.equal(r.runtime.sessions.size, chats, 'no chat was started')
  await r.personWrites('What time is it?')
  const aside = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  assert.ok((aside.value as { problem?: string }).problem, 'an unrelated person message is not an answer')
  assert.equal(r.runtime.sessions.size, chats)
  // The same request under a fresh title is the same work, and refused the same way.
  const renamed = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task', cause: 'person' } })
  assert.match((renamed.value as { problem?: string }).problem ?? '', /stopped once/, JSON.stringify(renamed.value))
  await approveRetry(r, item, one)
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  assert.equal(typeof (second.value as { id?: string }).id, 'string', JSON.stringify(second.value))
})

test('#2145: the Lead\'s work list, read the moment the window\'s Stop lands, already says the person stopped it', async t => {
  const r = await rig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  await card(r, item, found => found.stage !== 'queued')
  await windowStop(r, one)
  // No polling: the chat-changed wake reads the list at once, before any debounced refresh of the ledger.
  const block = leadWorkCards(await r.host.call('lead/work/list', {}), Date.now())!
  assert.match(block, new RegExp(`${item} \\[stopped\\][^\\n]*stopped by the person`), block)
})

test('#2145: an answer that picked a way without a new chat never starts one; an option marked starts does', async t => {
  const r = await rig(t)
  await r.personWrites('Why did the build a game run stall?')
  const ask = () => ({ question: 'The fix was stopped. How do you want to go on?', recommended: 'read',
    options: [{ id: 'again', label: 'Open a new chat and try again', starts: true as const }, { id: 'read', label: 'Only read the full reason, change nothing' }],
    // The stamp the host puts on every question it reads from the Lead under the starts rule.
    startsMarked: true as const })
  await r.journal.appendReply('The fix was stopped. How do you want to go on?', undefined, ask())
  await r.personWrites('Only read the full reason, change nothing')
  const chats = r.runtime.sessions.size
  const refused = await r.execute({ method: 'lead/chat/start', params: { text: 'Read the full stall reason, read-only' } })
  const problem = (refused.value as { problem?: string }).problem ?? ''
  assert.match(problem, /Nothing was started/, JSON.stringify(refused.value))
  assert.match(problem, /Only read the full reason, change nothing/)
  assert.equal(r.runtime.sessions.size, chats, 'no chat was started')
  await r.journal.appendReply('The fix was stopped. How do you want to go on?', undefined, ask())
  await r.personWrites('Open a new chat and try again')
  const started = await r.execute({ method: 'lead/chat/start', params: { text: 'Read the full stall reason, read-only' } })
  assert.match((started.value as { id?: string }).id ?? '', /./, JSON.stringify(started.value))
  assert.equal((started.value as { problem?: string }).problem, undefined)
})

test('#2145: a question stored before the starts rule keeps the old answer behaviour: its answer may still start a chat', async t => {
  const r = await rig(t)
  await r.personWrites('Why did the build a game run stall?')
  // Written by an older desk: no option says starts, and the question carries no stamp.
  await r.journal.appendReply('The fix was stopped. Shall I start it again?', undefined, { question: 'The fix was stopped. Shall I start it again?', recommended: 'start',
    options: [{ id: 'start', label: 'Start it' }, { id: 'later', label: 'Not now' }] })
  await r.personWrites('Start it')
  const started = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build' } })
  assert.match((started.value as { id?: string }).id ?? '', /./, JSON.stringify(started.value))
  assert.equal((started.value as { problem?: string }).problem, undefined)
})

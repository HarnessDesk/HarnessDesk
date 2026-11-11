import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RuntimeInfo, SeatRecord, Turn } from '@harnessdesk/protocol'

import { ASK_ANSWER_BYTES, ASK_TRUNCATED_MARK, ConsultPlane, answerText, type AskingSeat, type ConsultPort, type OpenedConsult } from '../src/consult.js'

/*
 * The consult engine's rules, in order, over a port of closures: who may
 * ask, whom, how often, within what money and size, and what comes back.
 * The host's own wiring of that port — the hidden conversation, the held
 * read ceiling, the discard — is `consult.test.ts`, on a real desk.
 */

const info = (id: string, read = true): RuntimeInfo => ({
  id, presentation: { name: `Agent ${id.toUpperCase()}` },
  ...(read ? { ceilings: { read: { settings: [{ option: 'sandbox', value: 'read-only' }], how: 'Read-only sandbox' } } } : {}),
} as unknown as RuntimeInfo)

interface Rig {
  readonly plane: ConsultPlane
  readonly port: ConsultPort
  readonly calls: string[]
  readonly audit: Record<string, unknown>[]
  seat: AskingSeat | null
  reply: (text: string) => Turn
  budget: { ok: true } | { ok: false; detail: string }
  held: boolean
  timers: Map<number, () => void>
  finals: unknown[]
}

const turn = (text: string, status: Turn['status'] = 'completed'): Turn =>
  ({ id: 't1', status, items: text === '' ? [] : [{ id: 'a1', type: 'assistantMessage', text }] }) as unknown as Turn

const rig = (): Rig => {
  const calls: string[] = []
  const audit: Record<string, unknown>[] = []
  const state: Rig = {
    calls, audit,
    seat: { run: 'run-1', goal: 'goal-1', seat: 'seat-1', ask: { seats: [{ runtime: 'b' }], times: 2, timeoutSeconds: 30 }, trigger: false, used: 0 },
    reply: () => turn('4'),
    budget: { ok: true },
    held: true,
    timers: new Map(),
    finals: [],
  } as unknown as Rig
  let spent = 0
  let timer = 0
  const port: ConsultPort = {
    caller: (runtime) => (runtime === 'a' ? { cwd: '/work/checkout', project: '/work' } : null),
    isConsult: (_runtime, sessionId) => sessionId === 'consult-1',
    askingSeat: () => state.seat ? { ...state.seat, used: spent } : null,
    seat: (id) => ({ id, board: 'goal-1' }) as unknown as SeatRecord,
    spendAsk: async (_run, _seat, times) => { if (spent >= times) return null; spent += 1; calls.push(`spend:${spent}`); return spent },
    beforeDispatch: async () => state.budget,
    runtime: (id) => (id === 'b' ? info('b') : id === 'c' ? info('c', false) : null),
    open: async (agent, where) => { calls.push(`open:${agent.runtime}:${where.cwd}`); return { runtime: agent.runtime, sessionId: 'consult-1', openedAt: 0 } },
    holdRead: async () => { calls.push('hold'); return state.held },
    ask: (_consult: OpenedConsult, text, signal) => new Promise<Turn>((resolve, reject) => {
      calls.push(`ask:${text.split('\n\n')[1]}`)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      const answer = state.reply(text)
      if (answer.status !== 'inProgress') queueMicrotask(() => resolve(answer))
    }),
    discard: async () => { calls.push('discard'); return null },
    metered: async (_caller, consult) => { calls.push(`metered:${consult.n}`); return `seat-1/ask/${consult.n}` },
    meteredStart: async (_goal, meter) => { calls.push(`meteredStart:${meter}`) },
    usage: () => null,
    meteredEnd: async (_goal, meter, _ended, final) => { calls.push(`meteredEnd:${meter}`); state.finals.push(final) },
    linkOpened: async (seat, consult) => { calls.push(`linkOpened:${seat}:${consult.n}`) },
    linkClosed: async (seat) => { calls.push(`linkClosed:${seat}`) },
    audit: (entry) => { audit.push(entry) },
    log: () => {},
    now: () => 0,
    setTimer: (fire) => { timer += 1; state.timers.set(timer, fire); return timer },
    clearTimer: (id) => { state.timers.delete(id as number) },
  }
  return Object.assign(state, { port, plane: new ConsultPlane(port) })
}

const scope = { runtime: 'a', sessionId: 'caller-1' }
const code = (expected: string) => (error: unknown): boolean => (error as { wireCode?: string }).wireCode === expected

test('an allowed seat asks once: open, hold read, ask, discard — and the answer comes back with the agent’s own name', async () => {
  const r = rig()
  const answer = await r.plane.ask({ agent: 'b', question: 'What is 2+2?', context: 'Arithmetic.' }, scope)
  assert.deepEqual(answer, { text: '4', agentName: 'Agent B', truncated: false })
  assert.deepEqual(r.calls, ['spend:1', 'open:b:/work/checkout', 'hold', 'linkOpened:seat-1:1', 'ask:What is 2+2?', 'linkClosed:seat-1', 'discard'])
  assert.equal(r.audit.length, 1)
  assert.deepEqual({ ...r.audit[0], durationMs: 0 }, { runtime: 'a', sessionId: 'caller-1', agent: 'b', outcome: 'answered', bytesIn: 23, bytesOut: 1, durationMs: 0 })
})

test('the gate: no caller, a consult asking, a role without ask, an agent not listed — each refused before anything opens', async () => {
  const r = rig()
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, {}), code('askNoCaller'))
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, { runtime: 'a', sessionId: 'consult-1' }), code('askDepth'))
  await assert.rejects(r.plane.ask({ agent: 'z', question: 'q', context: null }, scope), (error: Error) =>
    code('askNotAllowed')(error) && /may ask only: b \(Agent B\)/.test(error.message))
  r.seat = { ...r.seat!, ask: null }
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, scope), code('askNotAllowed'))
  r.seat = null
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, scope), code('askNotAllowed'))
  assert.deepEqual(r.calls, [], 'no ask was spent and nothing opened')
})

test('times: the seat’s asks run out, and the next is askSpent', async () => {
  const r = rig()
  await r.plane.ask({ agent: 'b', question: 'one', context: null }, scope)
  await r.plane.ask({ agent: 'b', question: 'two', context: null }, scope)
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'three', context: null }, scope), code('askSpent'))
  assert.equal(r.calls.filter((one) => one.startsWith('open')).length, 2)
})

test('money: a trigger’s Goal at its cap refuses with askBudget; under it, the consult is metered on the caller’s Goal', async () => {
  const r = rig()
  r.seat = { ...r.seat!, trigger: true }
  r.budget = { ok: false, detail: 'This Goal has spent its budget.' }
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, scope), (error: Error) => code('askBudget')(error) && /spent its budget/.test(error.message))
  assert.equal(r.calls.length, 0)
  r.budget = { ok: true }
  await r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  assert.ok(r.calls.includes('metered:1'))
  // The turn's start is on the meter before the question is sent, and its end after the turn.
  const at = (call: string): number => r.calls.findIndex((one) => one.startsWith(call))
  assert.ok(at('meteredStart:seat-1/ask/1') > at('metered:1') && at('meteredStart:seat-1/ask/1') < at('ask:'), r.calls.join(', '))
  assert.ok(at('meteredEnd:seat-1/ask/1') > at('ask:') && at('meteredEnd:seat-1/ask/1') < at('discard'), r.calls.join(', '))
})

test('the deadline bounds the open: the timer fires while opening is held — askTimeout at once, and the late conversation is discarded', async () => {
  const r = rig()
  let opened!: (consult: OpenedConsult) => void
  ;(r.port as { open: ConsultPort['open'] }).open = (agent) => {
    r.calls.push(`open:${agent.runtime}`)
    return new Promise((resolve) => { opened = resolve })
  }
  const asking = r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  while (!r.calls.some((one) => one.startsWith('open'))) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(r.timers.size, 1)
  for (const fire of r.timers.values()) fire()
  await assert.rejects(asking, code('askTimeout'))
  assert.deepEqual(r.calls, ['spend:1', 'open:b'], 'nothing was asked, held or discarded yet')
  assert.equal(r.audit[0]!['outcome'], 'askTimeout')
  opened({ runtime: 'b', sessionId: 'consult-late', openedAt: 0 })
  while (!r.calls.includes('discard')) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(r.calls, ['spend:1', 'open:b', 'discard'], 'the conversation that came back late is discarded, never asked')
})

test('the deadline bounds the hold and the meter; cleanup is bounded too: a discard that never ends is logged, and the ask still ends', async () => {
  const r = rig()
  r.seat = { ...r.seat!, trigger: true }
  const logged: string[] = []
  ;(r.port as { log: ConsultPort['log'] }).log = (message) => { logged.push(message) }
  ;(r.port as { holdRead: ConsultPort['holdRead'] }).holdRead = () => { r.calls.push('hold'); return new Promise<boolean>(() => {}) }
  ;(r.port as { discard: ConsultPort['discard'] }).discard = () => { r.calls.push('discard'); return new Promise<string | null>(() => {}) }
  const asking = r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  while (!r.calls.includes('hold')) await new Promise((resolve) => setImmediate(resolve))
  const [deadline] = [...r.timers.values()]
  deadline!()
  // Cleanup runs under its own timer: fire each one as it is set until the ask ends.
  let ended = false
  void asking.catch(() => undefined).finally(() => { ended = true })
  while (!ended) {
    await new Promise((resolve) => setImmediate(resolve))
    for (const fire of [...r.timers.values()]) fire()
  }
  await assert.rejects(asking, code('askTimeout'))
  assert.ok(r.calls.includes('discard'))
  assert.ok(logged.some((one) => /discard did not finish in time/.test(one)), logged.join(' | '))
  assert.equal(r.timers.size, 0, 'every timer is cleared')
})

test('sizes: an empty question, a 17 KiB question or context — askTooLarge, and nothing opens', async () => {
  const r = rig()
  const big = 'x'.repeat(17 * 1024)
  await assert.rejects(r.plane.ask({ agent: 'b', question: '  ', context: null }, scope), code('askTooLarge'))
  await assert.rejects(r.plane.ask({ agent: 'b', question: big, context: null }, scope), code('askTooLarge'))
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: big }, scope), code('askTooLarge'))
  // Bytes, not characters: 6 000 three-byte characters are over 16 KiB.
  await assert.rejects(r.plane.ask({ agent: 'b', question: '語'.repeat(6000), context: null }, scope), code('askTooLarge'))
  assert.deepEqual(r.calls, [])
})

test('admission: an agent not on the desk, or with no read ceiling, is not asked', async () => {
  const r = rig()
  r.seat = { ...r.seat!, ask: { seats: [{ runtime: 'b' }, { runtime: 'c' }, { runtime: 'gone' }], times: 5 } }
  await assert.rejects(r.plane.ask({ agent: 'gone', question: 'q', context: null }, scope), code('askUnavailable'))
  await assert.rejects(r.plane.ask({ agent: 'c', question: 'q', context: null }, scope), code('askNoReadCeiling'))
  assert.deepEqual(r.calls, [])
})

test('a read ceiling the runtime does not hold refuses, and the consult is still discarded', async () => {
  const r = rig()
  r.held = false
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, scope), code('askNoReadCeiling'))
  assert.deepEqual(r.calls, ['spend:1', 'open:b:/work/checkout', 'hold', 'discard'], 'never asked, so nothing is linked')
  assert.equal(r.audit[0]!['outcome'], 'askNoReadCeiling')
})

test('the timeout: the agent never answers, the timer fires — askTimeout, discarded', async () => {
  const r = rig()
  r.reply = () => turn('', 'inProgress')
  const asking = r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  while (!r.calls.some((one) => one.startsWith('ask:'))) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(r.timers.size, 1)
  for (const fire of r.timers.values()) fire()
  await assert.rejects(asking, (error: Error) => code('askTimeout')(error) && /within 30 seconds/.test(error.message))
  assert.equal(r.calls.at(-1), 'discard')
  assert.equal(r.timers.size, 0, 'the timer is cleared')
})

test('the run ending withdraws an open consult: askCancelled, discarded', async () => {
  const r = rig()
  r.reply = () => turn('', 'inProgress')
  const asking = r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  while (!r.calls.some((one) => one.startsWith('ask:'))) await new Promise((resolve) => setImmediate(resolve))
  r.plane.runEnded('run-1')
  await assert.rejects(asking, code('askCancelled'))
  assert.equal(r.calls.at(-1), 'discard')
})

test('a failed turn and a turn with nothing said are askFailed', async () => {
  const r = rig()
  r.reply = () => turn('', 'failed')
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, scope), code('askFailed'))
  r.reply = () => turn('')
  await assert.rejects(r.plane.ask({ agent: 'b', question: 'q', context: null }, scope), code('askFailed'))
})

test('one ask per caller at a time: a second waits for the first', async () => {
  const r = rig()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const order: string[] = []
  const ask = r.port.ask
  ;(r.port as { ask: ConsultPort['ask'] }).ask = async (consult, text, signal) => {
    order.push(`start:${text.split('\n\n')[1]}`)
    if (text.includes('first')) await gate
    const answer = await ask(consult, text, signal)
    order.push(`end:${text.split('\n\n')[1]}`)
    return answer
  }
  const first = r.plane.ask({ agent: 'b', question: 'first', context: null }, scope)
  const second = r.plane.ask({ agent: 'b', question: 'second', context: null }, scope)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, ['start:first'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second'])
})

test('the answer is text: control characters stripped, cut at 32 KiB on a character boundary, and marked', () => {
  assert.deepEqual(answerText('4\u0007\u001b[31m\u009b ok\n\tdone'), { text: '4[31m ok\n\tdone', truncated: false })
  const long = answerText('é'.repeat(40 * 1024))
  assert.equal(long.truncated, true)
  assert.ok(long.text.endsWith(ASK_TRUNCATED_MARK))
  assert.ok(Buffer.byteLength(long.text) <= ASK_ANSWER_BYTES)
  assert.equal(long.text.includes('\uFFFD'), false, 'never cut inside a character')
})

test('a 40 KiB reply reaches the caller truncated, with truncated: true', async () => {
  const r = rig()
  r.reply = () => turn('y'.repeat(40 * 1024))
  const answer = await r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  assert.equal(answer.truncated, true)
  assert.ok(answer.text.endsWith(ASK_TRUNCATED_MARK))
  assert.equal(r.audit[0]!['outcome'], 'truncated')
})

test('whose consult it is goes on disk before the question: a desk that stops mid-consult still knows the Seat that asked', async () => {
  const r = rig()
  r.seat = { ...r.seat!, trigger: true }
  r.reply = () => turn('', 'inProgress')
  const asking = r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  while (!r.calls.some((one) => one.startsWith('ask:'))) await new Promise((resolve) => setImmediate(resolve))
  const at = (call: string): number => r.calls.findIndex((one) => one.startsWith(call))
  assert.ok(at('linkOpened:seat-1:1') >= 0 && at('linkOpened:seat-1:1') < at('ask:'), r.calls.join(', '))
  assert.equal(at('linkClosed'), -1, 'its closing is written separately, once it ends')
  r.plane.runEnded('run-1')
  await assert.rejects(asking, code('askCancelled'))
  assert.ok(at('linkClosed:seat-1') > at('ask:') && at('linkClosed:seat-1') < at('discard'), r.calls.join(', '))
})

test('a question withdrawn before it is sent spent nothing: the meter closes unsent, not unknown, and no closing is written', async () => {
  const r = rig()
  r.seat = { ...r.seat!, trigger: true }
  ;(r.port as { meteredStart: ConsultPort['meteredStart'] }).meteredStart = (_goal, meter) => { r.calls.push(`meteredStart:${meter}`); return new Promise<void>(() => {}) }
  const asking = r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  while (!r.calls.some((one) => one.startsWith('meteredStart'))) await new Promise((resolve) => setImmediate(resolve))
  r.plane.runEnded('run-1')
  await assert.rejects(asking, code('askCancelled'))
  assert.equal(r.calls.some((one) => one.startsWith('ask:')), false, 'the question never went')
  assert.deepEqual(r.finals, ['unsent'])
  assert.equal(r.calls.some((one) => one.startsWith('linkClosed')), false)
  assert.equal(r.calls.at(-1), 'discard')
})

test('a sent question is metered with the usage its live conversation reported, read once before the discard', async () => {
  const r = rig()
  r.seat = { ...r.seat!, trigger: true }
  const live = { key: 'consult:b:consult-1' } as never
  let reads = 0
  ;(r.port as { usage: ConsultPort['usage'] }).usage = () => { reads += 1; r.calls.push('usage'); return live }
  await r.plane.ask({ agent: 'b', question: 'q', context: null }, scope)
  assert.deepEqual(r.finals, [live])
  assert.equal(reads, 1)
  assert.ok(r.calls.indexOf('usage') < r.calls.indexOf('discard'))
})

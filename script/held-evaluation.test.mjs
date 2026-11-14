import assert from 'node:assert/strict'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import vm from 'node:vm'

import { HELD_PROMISES, heldExpression } from './lib/held-evaluation.mjs'
import { Cdp } from './lib/desk.mjs'

setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc')

/**
 * A page whose debugger awaits a promise the way the one in Electron 42 does:
 * through a weak handle, with its own reaction queued last. Another reaction
 * the page queued first runs a full garbage collection — what a busy renderer
 * does often enough to fail a desk run in five.
 */
class WeakPage {
  #pending = []
  context = vm.createContext({ setTimeout, hold: (resolve, reject) => { this.#pending.push({ resolve, reject }) } })

  /** `Runtime.evaluate` with `awaitPromise` and `returnByValue`; answers the message body. */
  evaluate(expression) {
    let value
    try {
      value = vm.runInContext(expression, this.context)
    } catch (error) {
      return Promise.resolve(thrown(error))
    }
    if (typeof value?.then !== 'function') return Promise.resolve(byValue(value))
    const handle = new WeakRef(value)
    const collect = () => { gc() }
    value.then(collect, collect)
    const answer = new Promise((resolve) => {
      const read = (settle) => (outcome) => {
        if (handle.deref() === undefined) resolve({ error: { code: -32000, message: 'Promise was collected' } })
        else resolve(settle(outcome))
      }
      value.then(read(byValue), read(thrown))
    })
    value = undefined
    return answer
  }

  /** Settles the promise the expression left pending, from a task of its own. */
  settleLater(outcome = { value: 42 }) {
    setTimeout(() => settle(this.#pending.shift(), outcome, this.context), 5)
  }
}

/* `returnByValue` answers a copy, which is also what makes a value from the page's realm comparable here. */
const byValue = (value) => ({ result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } })

const thrown = (error) => ({ result: {}, exceptionDetails: { exception: { description: String(error?.stack ?? error) } } })

/* A function of its own, so nothing on the stack refers to the resolver once
   the microtasks run. */
const settle = ({ resolve, reject }, outcome, context) => {
  if ('error' in outcome) reject(new (vm.runInContext("Error", context))(outcome.error))
  else resolve(outcome.value)
}

const PENDING = 'new Promise((resolve, reject) => hold(resolve, reject))'

const turn = () => new Promise((resolve) => setTimeout(resolve, 20))

test('the fake page loses a promise the page no longer refers to', async () => {
  const page = new WeakPage()
  const answer = page.evaluate(PENDING)
  page.settleLater()
  assert.deepEqual(await answer, { error: { code: -32000, message: 'Promise was collected' } })
})

test('a held expression keeps its promise until the debugger has read it, then lets go', async () => {
  const page = new WeakPage()
  const answer = page.evaluate(heldExpression(PENDING))
  page.settleLater()
  assert.deepEqual(await answer, { result: { value: 42 } })
  await turn()
  assert.equal(page.context[HELD_PROMISES].size, 0)
})

test('a held expression rejects, throws and answers plain values exactly as the bare one does', async () => {
  const page = new WeakPage()
  const rejected = page.evaluate(heldExpression(PENDING))
  page.settleLater({ error: 'nope' })
  assert.match((await rejected).exceptionDetails.exception.description, /Error: nope/)
  assert.match((await page.evaluate(heldExpression('(() => { throw new Error("boom") })()'))).exceptionDetails.exception.description, /Error: boom/)
  assert.deepEqual(await page.evaluate(heldExpression('1 + 2')), { result: { value: 3 } })
  assert.deepEqual(await page.evaluate(heldExpression('({ a: 1 }) // a trailing comment')), { result: { value: { a: 1 } } })
  const thenable = await page.evaluate(heldExpression('({ then: 1 })'))
  assert.deepEqual(thenable, { result: { value: { then: 1 } } })
  await turn()
  assert.equal(page.context[HELD_PROMISES].size, 0)
})

test('the desk driver answers a promise a collection would otherwise have taken', async (t) => {
  const page = new WeakPage()
  const original = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { setTimeout(() => this.onopen?.(), 0) }
    send(text) {
      const { id, params } = JSON.parse(text)
      page.evaluate(params.expression).then((body) => {
        const message = body.error ? { id, error: body.error } : { id, result: body }
        this.onmessage?.({ data: JSON.stringify(message) })
      })
      page.settleLater()
    }
    close() {}
  }
  t.after(() => { globalThis.WebSocket = original })
  const cdp = await Cdp.open('ws://desk.test/page')
  assert.equal(await cdp.eval(PENDING), 42)
  assert.equal(await cdp.json(PENDING), 42)
  cdp.close()
})

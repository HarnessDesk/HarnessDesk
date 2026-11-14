import assert from 'node:assert/strict'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import vm from 'node:vm'

import { Cdp } from './lib/desk.mjs'
import { evaluateHeld } from './lib/held-evaluation.mjs'

setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc')

/**
 * A page and its debugger, behaving the way the one in Electron 42 does where
 * it matters here. Awaiting a promise holds it only through a weak handle,
 * with the debugger's own reaction queued last, and another reaction the page
 * queued first runs a full garbage collection, which is what a busy renderer
 * does often enough to fail a desk run in five. Objects the debugger hands out
 * by id stay in their object group, held strongly, until the group is released.
 */
class WeakPage {
  #pending = []
  #ids = 0
  groups = new Map()
  context = vm.createContext({ setTimeout, hold: (resolve, reject) => { this.#pending.push({ resolve, reject }) } })

  /** One debugger command; answers the message body, `{ result }` or `{ error }`. */
  async command(method, params) {
    if (method === 'Runtime.evaluate') {
      let value
      try {
        value = vm.runInContext(params.expression, this.context)
      } catch (error) {
        return { result: thrown(error) }
      }
      if (params.awaitPromise && isPromise(value)) return this.#await(value)
      if (params.returnByValue || value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return { result: byValue(value) }
      }
      const objectId = `object-${(this.#ids += 1)}`
      const group = this.groups.get(params.objectGroup) ?? new Map()
      group.set(objectId, value)
      this.groups.set(params.objectGroup, group)
      return { result: { result: { type: typeof value, ...(isPromise(value) ? { subtype: 'promise' } : {}), objectId } } }
    }
    if (method === 'Runtime.awaitPromise') return this.#await(this.#object(params.promiseObjectId))
    if (method === 'Runtime.callFunctionOn') {
      const fn = vm.runInContext(`(${params.functionDeclaration})`, this.context)
      return { result: byValue(fn.call(this.#object(params.objectId))) }
    }
    if (method === 'Runtime.releaseObjectGroup') {
      this.groups.delete(params.objectGroup)
      return { result: {} }
    }
    return { error: { code: -32601, message: `${method} wasn't found` } }
  }

  #object(objectId) {
    for (const group of this.groups.values()) if (group.has(objectId)) return group.get(objectId)
    throw new Error(`no object ${objectId}`)
  }

  #await(value) {
    const handle = new WeakRef(value)
    const collect = () => { gc() }
    value.then(collect, collect)
    const answer = new Promise((resolve) => {
      const read = (settle) => (outcome) => {
        if (handle.deref() === undefined) resolve({ error: { code: -32000, message: 'Promise was collected' } })
        else resolve({ result: settle(outcome) })
      }
      value.then(read(byValue), read(thrown))
    })
    value = undefined
    return answer
  }

  /** Settles the oldest promise the page left pending, from a task of its own. */
  settleLater(outcome = { value: 42 }) {
    setTimeout(() => {
      const pending = this.#pending.shift()
      if (pending) settle(pending, outcome, this.context)
    }, 5)
  }
}

const isPromise = (value) => Object.prototype.toString.call(value) === '[object Promise]'

/* `returnByValue` answers a copy, which is also what makes a value from the page's realm comparable here. */
const byValue = (value) => ({ result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } })

const thrown = (error) => ({ result: {}, exceptionDetails: { exception: { description: String(error?.stack ?? error) } } })

/* A function of its own, so nothing on the stack refers to the resolver once
   the microtasks run. */
const settle = ({ resolve, reject }, outcome, context) => {
  if ('error' in outcome) reject(new (vm.runInContext('Error', context))(outcome.error))
  else resolve(outcome.value)
}

const PENDING = 'new Promise((resolve, reject) => hold(resolve, reject))'

const turn = () => new Promise((resolve) => setTimeout(resolve, 20))

/** `send` for `evaluateHeld`: a protocol error rejects, as it does over the socket. */
const sender = (page) => async (method, params) => {
  const body = await page.command(method, params)
  if (body.error) throw new Error(body.error.message)
  return body.result
}

test('the fake page loses an awaited promise the page no longer refers to', async () => {
  const page = new WeakPage()
  const answer = page.command('Runtime.evaluate', { expression: PENDING, awaitPromise: true, returnByValue: true })
  page.settleLater()
  assert.deepEqual(await answer, { error: { code: -32000, message: 'Promise was collected' } })
})

test('a held evaluation answers the promise a collection would have taken, then releases it', async () => {
  const page = new WeakPage()
  const answer = evaluateHeld(sender(page), PENDING)
  page.settleLater()
  assert.deepEqual(await answer, { result: { value: 42 } })
  await turn()
  assert.equal(page.groups.size, 0)
})

test('a held evaluation answers every kind of expression as the bare one does', async () => {
  const page = new WeakPage()
  const send = sender(page)
  const value = async (expression) => (await evaluateHeld(send, expression)).result.value
  assert.equal(await value('1 + 2'), 3)
  assert.equal(await value('globalThis.a = 1; true'), true)
  assert.equal(await value('7;'), 7)
  assert.equal(await value('var b = 2\nb * 3 // a trailing comment'), 6)
  assert.equal(await value('b'), 2)
  assert.deepEqual(await value('({ a: 1 })'), { a: 1 })
  assert.deepEqual(await value('({ then: 1 })'), { then: 1 })
  assert.equal(await value('undefined'), undefined)
  assert.match((await evaluateHeld(send, 'throw new Error("boom")')).exceptionDetails.exception.description, /Error: boom/)
  const rejected = evaluateHeld(send, PENDING)
  page.settleLater({ error: 'nope' })
  assert.match((await rejected).exceptionDetails.exception.description, /Error: nope/)
  await turn()
  assert.equal(page.groups.size, 0)
})

test('the desk driver answers a promise a collection would otherwise have taken', async (t) => {
  const page = new WeakPage()
  const original = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { setTimeout(() => this.onopen?.(), 0) }
    send(text) {
      const { id, method, params } = JSON.parse(text)
      page.command(method, params).then((body) => this.onmessage?.({ data: JSON.stringify({ id, ...body }) }))
      if (method === 'Runtime.evaluate') page.settleLater()
    }
    close() {}
  }
  t.after(() => { globalThis.WebSocket = original })
  const cdp = await Cdp.open('ws://desk.test/page')
  assert.equal(await cdp.eval(PENDING), 42)
  assert.equal(await cdp.json(PENDING), 42)
  assert.equal(await cdp.eval('globalThis.c = 1; "a statement list"'), 'a statement list')
  cdp.close()
  await turn()
  assert.equal(page.groups.size, 0)
})

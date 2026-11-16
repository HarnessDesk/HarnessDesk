import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownedResumePreparation } from '../src/session-resume.js'

const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

test('retirement during preparation prevents adapter open after the await', async () => {
  const hold = gate<void>(); let starts = 0
  const attempt = ownedResumePreparation(async (start, check) => { await hold.promise; check(); return start({}) }, () => { starts++; return { result: Promise.resolve({}), retire: async () => {} } })
  const rejected = assert.rejects(attempt.result, /earlier open/)
  const retirement = attempt.retire({ published: false }); hold.resolve(); await Promise.all([rejected, retirement])
  assert.equal(starts, 0)
})

test('retirement after adapter start delegates to the exact attempt', async () => {
  const result = gate<object>(), entered = gate<void>(), done = gate<void>(); let published: boolean | undefined
  const attempt = ownedResumePreparation(async start => { const value = start({}); entered.resolve(); return value }, () => ({ result: result.promise, retire: async state => { published = state.published; await done.promise } }))
  await entered.promise
  const retirement = attempt.retire({ published: true }); assert.equal(published, true)
  const rejected = assert.rejects(attempt.result, /earlier open/)
  done.resolve(); result.resolve({}); await Promise.all([rejected, retirement])
})

test('retirement waits for host preparation after the adapter returned', async () => {
  const afterAdapter = gate<void>(), entered = gate<void>(), finish = gate<void>()
  const attempt = ownedResumePreparation(async (start, check) => {
    await start({}); entered.resolve(); await afterAdapter.promise; check(); finish.resolve(); return {}
  }, () => ({ result: Promise.resolve({}), retire: async () => {} }))
  const rejected = assert.rejects(attempt.result, /earlier open/)
  await entered.promise
  let retired = false
  const retirement = attempt.retire({ published: false }).then(() => { retired = true })
  await Promise.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(retired, false, 'pending host effects remain inside retirement barrier')
  afterAdapter.resolve(); await Promise.all([rejected, retirement])
})

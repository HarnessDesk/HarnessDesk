import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AGENT = join(root, 'script/shots/agent.mjs')

/**
 * The camera agent, spoken to directly over its pipes.
 *
 * The scenes that photograph an agent whose history misbehaves flip a file
 * beside its store while the app runs. Nothing in a frame says the file did
 * what it was meant to, so this asks the agent itself: a listing, and what it
 * answered.
 */
const desk = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-agent-'))
  const store = join(dir, 'agent.json')
  const rows = ['a', 'b', 'c'].map((id) => [id, { sessionId: id, cwd: '/w', title: id, updatedAt: '2026-01-01T00:00:00Z', turns: [] }])
  writeFileSync(store, JSON.stringify(Object.fromEntries(rows)))
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, SHOT_STORE: store }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  })
  t.after(() => {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  })
  let next = 0
  return {
    /** The whole JSON-RPC answer, result or error. */
    ask: (method, params = {}) =>
      new Promise((done) => {
        next += 1
        waiting.set(next, done)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`)
      }),
    /** A switch is a file beside the store, named for it: `agent.json` has `agent.page`. */
    switchFile: (suffix) => join(dir, `agent.${suffix}`),
  }
}
const ids = (answer) => answer.result.sessions.map((row) => row.sessionId)

test('a page file beside the store pages the listing, and taking it away ends the paging', async (t) => {
  const { ask, switchFile } = desk(t)
  // The control: with no file one answer holds every row and names no next page.
  const whole = await ask('session/list')
  assert.deepEqual(ids(whole), ['a', 'b', 'c'])
  assert.equal(whole.result.nextCursor, undefined)

  writeFileSync(switchFile('page'), '2')
  const first = await ask('session/list')
  assert.deepEqual(ids(first), ['a', 'b'])
  assert.equal(first.result.nextCursor, '2')
  const last = await ask('session/list', { cursor: first.result.nextCursor })
  assert.deepEqual(ids(last), ['c'])
  assert.equal(last.result.nextCursor, undefined, 'the last page names no next one')

  // Read on every listing rather than at start: taken away, the listing is whole again.
  rmSync(switchFile('page'))
  assert.deepEqual(ids(await ask('session/list')), ['a', 'b', 'c'])
})

test('a list-fails file beside the store fails the listing as a locked index does, for as long as it is there', async (t) => {
  const { ask, switchFile } = desk(t)
  assert.equal((await ask('session/list')).error, undefined, 'the control: no file, no failure')

  writeFileSync(switchFile('list-fails'), '')
  const failed = await ask('session/list')
  assert.equal(failed.error.code, -32603)
  assert.equal(failed.error.message, 'Internal error')
  assert.equal(failed.error.data.details, 'the index is locked')

  rmSync(switchFile('list-fails'))
  assert.deepEqual(ids(await ask('session/list')), ['a', 'b', 'c'])
})

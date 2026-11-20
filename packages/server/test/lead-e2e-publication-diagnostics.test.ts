import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'
import { publicationStages } from './fixtures/publication-stages.js'

test('publication receipts identify a blocked failed-check intake and abort before the enclosing deadline', { timeout: 5_000 }, async () => {
  const controller = new AbortController(), receipts: string[] = []
  const stages = publicationStages(controller.signal, phase => receipts.push(phase))
  let release!: () => void
  const intake = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { entered = resolve })
  let polled = false
  const walk = (async () => {
    await stages.run('forge-read', async () => ({ pulls: [{}] }))
    await stages.run('failed-checks', () => { entered(); return intake })
    await stages.run('failed-check-poll', async () => { polled = true })
  })()
  try {
    // Reach the controlled unresolved intake operation without a sleep or live rig.
    await blocked
    assert.deepEqual(receipts, ['forge-read:begin', 'forge-read:end', 'failed-checks:begin'])
    assert.equal(polled, false)
    // Deliberately abort while the operation is unresolved, before this test's deadline.
    controller.abort()
    assert.equal(receipts.at(-1), 'abort:failed-checks:begin')
    assert.equal(polled, false, 'receipts do not release or cancel the held operation')
  } finally { release(); await walk; stages.dispose() }
  assert.deepEqual(receipts.slice(-3), ['failed-checks:end', 'failed-check-poll:begin', 'failed-check-poll:end'])
})

test('publication receipts preserve returned values, failures and listener cleanup', async () => {
  const controller = new AbortController(), receipts: string[] = []
  const stages = publicationStages(controller.signal, phase => receipts.push(phase))
  const result = { head: 'synthetic-reviewed-head' }, failure = new Error('synthetic poll failure')
  assert.equal(await stages.run('reviewed-push', async () => result), result)
  await assert.rejects(stages.run('failed-check-poll', async () => { throw failure }), error => error === failure)
  assert.deepEqual(receipts, ['reviewed-push:begin', 'reviewed-push:end', 'failed-check-poll:begin'])
  stages.dispose()
  controller.abort()
  assert.equal(receipts.length, 3, 'cleanup removes the abort listener')
})

test('the Node test runner emits the active publication stage when a held intake reaches its unchanged fixture deadline', { timeout: 10_000 }, async () => {
  const helper = new URL('./fixtures/publication-stages.js', import.meta.url).href
  const source = `
    import test from 'node:test'
    import { writeSync } from 'node:fs'
    import { publicationStages } from ${JSON.stringify(helper)}
    test('held synthetic intake', { timeout: 100 }, async t => {
      const stages = publicationStages(t.signal, phase => writeSync(2, phase + '\\n'))
      t.after(() => stages.dispose())
      await stages.run('failed-checks', () => new Promise(() => {}))
    })
  `
  // Keep the child's loop alive so node:test's case deadline, rather than loop
  // exhaustion, cancels the deliberately unresolved Promise.
  const code = `const keepAlive = setInterval(() => {}, 20);\n${source}\nsetTimeout(() => clearInterval(keepAlive), 200);`
  const env = { ...process.env }
  delete env['NODE_TEST_CONTEXT'] // This child owns its reporter, not the parent's IPC stream.
  let output = ''
  try {
    await promisify(execFile)(process.execPath, ['--test-reporter=tap', '--input-type=module', '-e', code], { timeout: 5_000, env })
    assert.fail('the deliberately held case must be cancelled')
  } catch (error) {
    const cancelled = error as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string }
    assert.equal(cancelled.code, 1)
    assert.notEqual(cancelled.killed, true, 'the parent process watchdog did not fire')
    output = `${cancelled.stdout}\n${cancelled.stderr}`
  }
  assert.match(output, /test timed out after 100ms/)
  assert.match(output, /failed-checks:begin\nabort:failed-checks:begin/)
  assert.doesNotMatch(output, /failed-checks:end/)
})

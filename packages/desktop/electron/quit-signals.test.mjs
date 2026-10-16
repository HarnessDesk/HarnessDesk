import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { attachQuitSignals } from './quit-signals.mjs'

test('termination signals request normal quit once while async disposal is pending', () => {
  const app = new EventEmitter()
  const signals = new EventEmitter()
  let quits = 0
  app.quit = () => { quits += 1; app.emit('before-quit') }
  attachQuitSignals(app, signals)
  signals.emit('SIGTERM')
  signals.emit('SIGTERM')
  signals.emit('SIGINT')
  assert.equal(quits, 1)
})

test('a signal does not overtake disposal already started by a menu quit', () => {
  const app = new EventEmitter()
  const signals = new EventEmitter()
  let quits = 0
  app.quit = () => { quits += 1 }
  attachQuitSignals(app, signals)
  app.emit('before-quit')
  signals.emit('SIGTERM')
  assert.equal(quits, 0)
})

test('signal-driven quit can reap a detached runtime and exit naturally', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const source = `
    import { spawn } from 'node:child_process'
    import { once, EventEmitter } from 'node:events'
    import { attachQuitSignals } from ${JSON.stringify(new URL('./quit-signals.mjs', import.meta.url).href)}
    const runtime = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    await once(runtime, 'spawn')
    const app = new EventEmitter()
    app.quit = () => app.emit('before-quit')
    app.on('before-quit', async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      const closed = once(runtime, 'close')
      process.kill(-runtime.pid, 'SIGTERM')
      await closed
      console.log('runtime-disposed')
    })
    attachQuitSignals(app)
    console.log('runtime:' + runtime.pid)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let runtime
  child.stderr.on('data', chunk => { stderr += chunk })
  const ready = new Promise(resolve => child.stdout.on('data', chunk => {
    stdout += chunk
    runtime = Number(/runtime:(\d+)/.exec(stdout)?.[1]) || runtime
    if (runtime) resolve()
  }))
  const closed = once(child, 'close')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8000)
  t.after(() => {
    clearTimeout(deadline)
    if (runtime) {
      try { process.kill(-runtime, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  })
  await ready
  child.kill('SIGTERM')
  const [code, signal] = await closed
  assert.equal(signal, null, stderr)
  assert.equal(code, 0, stderr)
  assert.match(stdout, /runtime-disposed/)
  assert.throws(() => process.kill(runtime, 0), { code: 'ESRCH' })
})

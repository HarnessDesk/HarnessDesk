import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { closeDesk, connectDesk, selectMainPage, waitForDebugger, waitForSnapshot } from './lib/desk.mjs'

test('debugger discovery trusts only the endpoint announced by its own child', async () => {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  const ready = waitForDebugger(child)
  child.stderr.emit('data', Buffer.from('DevTools listening on ws://127.0.0.1:'))
  child.stderr.emit('data', Buffer.from('43210/devtools/browser/owned-browser\n'))
  assert.equal(await ready, 'ws://127.0.0.1:43210/devtools/browser/owned-browser')
})

test('debugger discovery refuses a child that exits without binding', async () => {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  const ready = waitForDebugger(child)
  child.emit('exit', 1)
  await assert.rejects(ready, /exited before announcing/)
})

test('connectDesk refuses a foreign HarnessDesk before opening its renderer', async () => {
  let opened = false
  await assert.rejects(connectDesk({
    child: { exitCode: 1 }, port: 9123,
    browserUrl: 'ws://127.0.0.1:9123/devtools/browser/owned',
    fetchImpl: async () => ({ json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9123/devtools/browser/foreign' }) }),
    openCdp: async () => { opened = true },
    sleepImpl: async () => {}, discoveryAttempts: 1,
  }), /debugger ownership mismatch/)
  assert.equal(opened, false)
})

test('waitForSnapshot re-reads rendered appearance after the store has hydrated', async () => {
  const snapshots = [
    { theme: 'dark', background: 'rgb(255, 255, 255)' },
    { theme: 'dark', background: 'rgb(38, 38, 36)' },
  ]
  let reads = 0
  const result = await waitForSnapshot(
    async () => snapshots[reads++],
    snapshot => snapshot.background === 'rgb(38, 38, 36)',
    { attempts: 2, sleepImpl: async () => {} },
  )
  assert.deepEqual(result, snapshots[1])
  assert.equal(reads, 2)
})

test('waitForSnapshot fails on persistent appearance divergence rather than accepting it', async () => {
  await assert.rejects(waitForSnapshot(async () => ({ theme: 'light' }), snapshot => snapshot.theme === 'dark', {
    attempts: 2, sleepImpl: async () => {},
  }), /snapshot did not converge.*light/)
})

const page = (title, url, id) => ({ type: 'page', title, url, webSocketDebuggerUrl: `ws://${id}` })

test('selectMainPage prefers the exact main window over auxiliary pages', () => {
  const main = page('HarnessDesk', 'http://127.0.0.1:8123/?token=desk', 'main')
  assert.equal(selectMainPage([
    page('About HarnessDesk', 'file:///app/about.html', 'about'),
    main,
  ]), main)
})

test('selectMainPage accepts the booting token-gated renderer and ignores browser guests', () => {
  const main = page('127.0.0.1:8123/?token=desk', 'http://127.0.0.1:8123/?token=desk', 'main')
  assert.equal(selectMainPage([
    page('Synthetic website', 'http://127.0.0.1:9000/', 'guest'),
    main,
  ]), main)
})

test('selectMainPage does not guess when only an auxiliary or guest page exists', () => {
  assert.equal(selectMainPage([
    page('About HarnessDesk', 'file:///app/about.html', 'about'),
    page('Synthetic website', 'http://127.0.0.1:9000/', 'guest'),
  ]), undefined)
})

test('closeDesk waits for Electron to exit before its isolated profile can be removed', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    queueMicrotask(() => {
      child.signalCode = signal
      child.emit('exit', null, signal)
    })
    return true
  }
  let closed = false

  await closeDesk({
    child,
    cdp: { close: () => { closed = true } },
  })

  assert.equal(closed, true)
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(child.signalCode, 'SIGTERM')
})

test('connectDesk cleans up when a renderer target appears but its store never mounts', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    queueMicrotask(() => {
      child.signalCode = signal
      child.emit('exit', null, signal)
    })
    return true
  }
  let cdpClosed = false
  let sinkEnded = false

  await assert.rejects(
    connectDesk({
      child,
      sink: { writableEnded: false, end: (done) => { sinkEnded = true; done() } },
      port: 9123,
      browserUrl: 'ws://127.0.0.1:9123/devtools/browser/owned',
      fetchImpl: async url => ({ json: async () => url.endsWith('/json/version')
        ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9123/devtools/browser/owned' }
        : [page('HarnessDesk', 'http://127.0.0.1:9123/?token=desk', 'main')] }),
      openCdp: async () => ({
        eval: async () => false,
        close: () => { cdpClosed = true },
      }),
      sleepImpl: async () => {},
      discoveryAttempts: 1,
      storeAttempts: 1,
    }),
    /renderer came up without a store/,
  )

  assert.equal(cdpClosed, true)
  assert.equal(sinkEnded, true)
  assert.deepEqual(child.signals, ['SIGTERM'])
})

// Run cleanup outside node:test: a returned promise is insufficient evidence
// that Node can exit. Inherited output pipes kept the old implementation alive.
for (const mode of ['normal-helper', 'stubborn-helper', 'exited-launcher', 'discovery-failure', 'connected']) {
  test(`desk cleanup permits natural process termination: ${mode}`, {
    skip: process.platform === 'win32' ? 'POSIX process groups' : false,
    timeout: 15_000,
  }, async t => {
    const { spawn } = await import('node:child_process')
    const { once } = await import('node:events')
    const runner = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/desk-exit.mjs', import.meta.url)), mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    t.after(async () => {
      const closed = once(unrelated, 'close')
      unrelated.kill('SIGKILL')
      await closed
    })
    let stdout = ''
    let stderr = ''
    let group
    runner.stdout.on('data', chunk => {
      stdout += chunk
      group = Number(/group:(\d+)/.exec(stdout)?.[1]) || group
    })
    runner.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => runner.kill('SIGKILL'), 12_000)
    t.after(() => {
      clearTimeout(timer)
      // Always reclaim this fixture's group, including when testing old code.
      if (group) {
        try { process.kill(-group, 'SIGKILL') } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    })
    const [code, signal] = await once(runner, 'close')
    assert.equal(signal, null, `${stdout}\n${stderr}`)
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.equal(unrelated.exitCode, null)
    assert.equal(unrelated.signalCode, null)
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
    if (mode === 'normal-helper') assert.doesNotMatch(stderr, /escalating/)
    else assert.match(stderr, /escalating.*stdoutOpen.*true/)
    assert.match(stdout, /cleanup-complete/)
    assert.match(stdout, /"stdoutClosed":true,"stderrClosed":true,"logFinished":true/)
  })
}

test('cleanup reports CDP failures after still terminating the child and finishing its log', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = signal => {
    queueMicrotask(() => {
      child.signalCode = signal
      child.emit('exit', null, signal)
    })
  }
  let logFinished = false
  await assert.rejects(closeDesk({
    child,
    cdp: { close: async () => { throw new Error('CDP close failed') } },
    sink: { writableEnded: false, end: done => { logFinished = true; done() } },
  }), error => error instanceof AggregateError && error.errors[0].message === 'CDP close failed')
  assert.equal(child.signalCode, 'SIGTERM')
  assert.equal(logFinished, true)
})

test('cleanup fails if SIGKILL does not close the child instead of reporting success', { timeout: 10_000 }, async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  const signals = []
  child.kill = signal => { signals.push(signal); return true }
  let logFinished = false
  await assert.rejects(closeDesk({
    child,
    sink: { writableEnded: false, end: done => { logFinished = true; done() } },
  }), error => error instanceof AggregateError && /did not close/.test(error.errors[0].message))
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(logFinished, true)
  assert.equal(child.listenerCount('exit'), 0)
})

test('connection failure retains its cause when cleanup also fails', async () => {
  await assert.rejects(connectDesk({
    child: { exitCode: 1 },
    cdp: null,
    sink: { writableEnded: false, end: done => done(new Error('log flush failed')) },
    discoveryAttempts: 0,
    browserUrl: 'ws://owned',
    port: 1,
  }), error => error instanceof AggregateError
    && /no renderer appeared/.test(error.errors[0].message)
    && /log flush failed/.test(error.errors[1].errors[0].message))
})

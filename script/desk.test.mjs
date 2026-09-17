import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

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

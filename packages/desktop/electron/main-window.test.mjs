import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { attachAppUpdateBridge } from './app-updates.mjs'
import { attachAppProtocol, loadMainWindow } from './main-window.mjs'

const protocolRig = ({ packaged = true, lock = true, platform = 'darwin' } = {}) => {
  const app = new EventEmitter(), calls = []
  let current = null
  app.isPackaged = packaged
  app.requestSingleInstanceLock = () => { calls.push('lock'); return lock }
  app.quit = () => calls.push('quit')
  app.setAsDefaultProtocolClient = scheme => calls.push(['protocol', scheme])
  app.focus = options => calls.push(['app-focus', options])
  const attached = attachAppProtocol({ app, platform, currentWindow: () => current })
  const window = ({ destroyed = false, minimized = false } = {}) => ({
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('window-focus'),
    loadURL: () => assert.fail('protocol URLs must not navigate the renderer'),
    webContents: { send: () => assert.fail('protocol URLs must not reach the renderer') },
  })
  return { app, calls, attached, window, setWindow: value => { current = value } }
}

test('the primary packaged app registers its protocol; development leaves the installed handler alone', () => {
  const packaged = protocolRig()
  assert.equal(packaged.attached, true)
  assert.deepEqual(packaged.calls, ['lock', ['protocol', 'harnessdesk']])
  const development = protocolRig({ packaged: false })
  assert.equal(development.attached, true)
  assert.deepEqual(development.calls, ['lock'])
})

test('a secondary instance quits without acquiring protocol or window authority', () => {
  const rig = protocolRig({ lock: false })
  assert.equal(rig.attached, false)
  assert.deepEqual(rig.calls, ['lock', 'quit'])
  assert.equal(rig.app.listenerCount('second-instance'), 0)
  assert.equal(rig.app.listenerCount('open-url'), 0)
})

test('a macOS protocol URL only restores and focuses the current main window, ignoring all URL data', () => {
  const rig = protocolRig()
  rig.setWindow(rig.window({ minimized: true }))
  rig.calls.length = 0
  let prevented = 0
  // A URL-shaped value cannot be parsed, inspected, logged or passed on.
  const ignored = new Proxy({}, { get: () => assert.fail('incoming URL data was inspected') })
  rig.app.emit('open-url', { preventDefault: () => { prevented += 1 } }, ignored)
  assert.equal(prevented, 1)
  assert.deepEqual(rig.calls, [['app-focus', { steal: true }], 'restore', 'show', 'window-focus'])
})

test('second-instance arguments are ignored and focus follows the current window lifecycle', () => {
  const rig = protocolRig()
  rig.calls.length = 0
  rig.app.emit('second-instance', {}, ['harnessdesk://return?token=ignored'])
  assert.deepEqual(rig.calls, [], 'startup has no existing window to bring forward')
  rig.setWindow(rig.window({ destroyed: true }))
  rig.app.emit('second-instance')
  assert.deepEqual(rig.calls, [], 'a closed window has no focus authority')
  rig.setWindow(rig.window())
  rig.app.emit('second-instance', {}, ['harnessdesk://return?token=ignored'])
  assert.deepEqual(rig.calls, [['app-focus', { steal: true }], 'show', 'window-focus'])
})

test('an early macOS protocol URL is consumed without creating a window; other platforms use second-instance', () => {
  const rig = protocolRig()
  rig.calls.length = 0
  let prevented = false
  rig.app.emit('open-url', { preventDefault: () => { prevented = true } }, 'harnessdesk://return')
  assert.equal(prevented, true)
  assert.deepEqual(rig.calls, [])
  assert.equal(protocolRig({ platform: 'win32' }).app.listenerCount('open-url'), 0)
})

const rig = () => {
  let current = null
  const handlers = new Map(), menu = { label: 'Check for Updates…', enabled: true, click: () => {} }
  attachAppUpdateBridge({ ipcMain: { handle: (name, run) => handlers.set(name, run), on: () => {} },
    currentWindow: () => current, currentMenu: () => menu })
  const read = window => handlers.get('harnessdesk:app-update-read')({ sender: window.webContents })
  const create = () => {
    const window = new EventEmitter()
    window.webContents = { send: () => {} }
    window.isDestroyed = () => false
    let resolve, reject
    window.loadURL = url => {
      assert.equal(url, 'http://127.0.0.1:4400/')
      return new Promise((done, fail) => { resolve = done; reject = fail })
    }
    return { window, finish: () => resolve(), fail: error => reject(error) }
  }
  return { current: () => current, read, create,
    load: window => loadMainWindow({ window, url: 'http://127.0.0.1:4400/',
      currentWindow: () => current, setCurrentWindow: value => { current = value } }) }
}

test('startup and replacement expose the current native update fact during renderer loading', async () => {
  const host = rig(), first = host.create()
  const initial = host.load(first.window)
  assert.equal(host.current(), first.window)
  assert.deepEqual(host.read(first.window), { label: 'Check for Updates…', enabled: true })
  first.finish(); await initial
  const next = host.create(), replacement = host.load(next.window)
  assert.equal(host.current(), next.window)
  assert.deepEqual(host.read(next.window), { label: 'Check for Updates…', enabled: true })
  assert.throws(() => host.read(first.window), /Only the app window/)
  first.window.emit('closed')
  assert.equal(host.current(), next.window, 'a replaced window cannot clear replacement authority')
  next.finish(); await replacement
  next.window.emit('closed')
  assert.equal(host.current(), null)
})

test('an older loading window cannot reclaim or clear a newer window when it settles', async () => {
  const host = rig(), first = host.create(), old = host.load(first.window)
  const next = host.create(), replacement = host.load(next.window)
  next.finish(); await replacement
  first.finish(); await old
  assert.equal(host.current(), next.window)
  first.window.emit('closed')
  assert.equal(host.current(), next.window)
  const failed = host.create(), failure = host.load(failed.window)
  const newest = host.create(), newestLoad = host.load(newest.window)
  failed.fail(new Error('load failed'))
  await assert.rejects(failure, /load failed/)
  assert.equal(host.current(), newest.window)
  newest.finish(); await newestLoad
})

test('a failed current load releases only its own authority', async () => {
  const host = rig(), one = host.create(), loading = host.load(one.window)
  one.fail(new Error('load failed'))
  await assert.rejects(loading, /load failed/)
  assert.equal(host.current(), null)
})

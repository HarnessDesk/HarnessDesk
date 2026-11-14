import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { attachAppUpdateBridge } from './app-updates.mjs'
import { attachAppProtocol, loadMainWindow } from './main-window.mjs'
import { createPromptLinkInbox } from './prompt-link.mjs'

const protocolRig = ({ packaged = true, lock = true, platform = 'darwin', argv = [] } = {}) => {
  const app = new EventEmitter(), calls = []
  let current = null
  app.isPackaged = packaged
  app.requestSingleInstanceLock = () => { calls.push('lock'); return lock }
  app.quit = () => calls.push('quit')
  app.setAsDefaultProtocolClient = scheme => calls.push(['protocol', scheme])
  app.focus = options => calls.push(['app-focus', options])
  const promptLinks = createPromptLinkInbox({ currentWindow: () => current })
  const attached = attachAppProtocol({ app, platform, argv, promptLinks, currentWindow: () => current })
  const window = ({ destroyed = false, minimized = false } = {}) => {
    const nudges = []
    return {
      nudges,
      isDestroyed: () => destroyed,
      isMinimized: () => minimized,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('window-focus'),
      loadURL: () => assert.fail('protocol URLs must not navigate the renderer'),
      // Only a prompt link may nudge the renderer, and the nudge carries no data.
      webContents: { send: (channel, payload) => {
        assert.equal(channel, 'harnessdesk:prompt-link')
        assert.equal(payload, null)
        nudges.push(channel)
      } },
    }
  }
  return { app, calls, attached, window, promptLinks, setWindow: value => { current = value } }
}

const NEW = 'harnessdesk://new?repo=acme.dev%2Fwidgets&prompt=Fix+the+build'

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
  assert.equal(rig.promptLinks.pending, null, 'a return URL never reaches the prompt-link inbox')
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

test('a macOS prompt link is queued for the renderer and still only focuses the window', () => {
  const rig = protocolRig()
  const window = rig.window()
  rig.setWindow(window)
  rig.calls.length = 0
  let prevented = 0
  rig.app.emit('open-url', { preventDefault: () => { prevented += 1 } }, NEW)
  assert.equal(prevented, 1)
  assert.deepEqual(rig.calls, [['app-focus', { steal: true }], 'show', 'window-focus'])
  assert.deepEqual(window.nudges, ['harnessdesk:prompt-link'])
  assert.deepEqual({ ...rig.promptLinks.take(window.webContents) },
    { repo: 'acme.dev/widgets', prompt: 'Fix the build', pr: null, flow: null })
  assert.equal(rig.promptLinks.take(window.webContents), null)
})

test('every other protocol URL stays a focus hint, even next to a prompt link', () => {
  const rig = protocolRig()
  const window = rig.window()
  rig.setWindow(window)
  for (const url of ['harnessdesk://return?token=t&code=c', 'harnessdesk://new/send?repo=a/b&prompt=x',
    'harnessdesk://NEW?repo=a/b&prompt=x', 'harnessdesk://new?repo=a/b&prompt=x&prompt=y']) {
    rig.app.emit('open-url', { preventDefault: () => {} }, url)
  }
  rig.app.emit('second-instance', {}, ['app', 'harnessdesk://return?token=ignored'])
  assert.deepEqual(window.nudges, [])
  assert.equal(rig.promptLinks.pending, null)
})

test('a cold-start prompt link waits for the window and is delivered once', () => {
  const rig = protocolRig()
  rig.calls.length = 0
  rig.app.emit('open-url', { preventDefault: () => {} }, NEW)
  assert.deepEqual(rig.calls, [], 'no window yet: nothing to focus, nothing to nudge')
  assert.ok(rig.promptLinks.pending, 'kept until the renderer asks')
  const window = rig.window()
  assert.equal(rig.promptLinks.take(window.webContents), null, 'a window that is not the app window cannot take it')
  rig.setWindow(window)
  assert.equal(rig.promptLinks.take(window.webContents)?.prompt, 'Fix the build')
  assert.equal(rig.promptLinks.take(window.webContents), null, 'a reload does not deliver it again')
})

test('Windows: the first instance reads its own argv, a second instance its argv, each once', () => {
  const rig = protocolRig({ platform: 'win32', argv: ['HarnessDesk.exe', NEW] })
  assert.equal(rig.app.listenerCount('open-url'), 0)
  assert.equal(rig.promptLinks.pending?.prompt, 'Fix the build', 'the cold-start argv is queued')
  const window = rig.window()
  rig.setWindow(window)
  assert.equal(rig.promptLinks.take(window.webContents)?.prompt, 'Fix the build')
  rig.calls.length = 0
  const again = 'harnessdesk://new?repo=acme.dev%2Fwidgets&prompt=Second'
  rig.app.emit('second-instance', {}, ['HarnessDesk.exe', again, again])
  assert.deepEqual(window.nudges, ['harnessdesk:prompt-link'], 'one launch, one link, one nudge')
  assert.deepEqual(rig.calls, [['app-focus', { steal: true }], 'show', 'window-focus'])
  assert.equal(rig.promptLinks.take(window.webContents)?.prompt, 'Second')
  assert.equal(rig.promptLinks.take(window.webContents), null)
  assert.equal(rig.promptLinks.pending, null, 'the first instance argv is never read again')
})

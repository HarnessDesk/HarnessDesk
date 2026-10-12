import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { attachAppUpdateBridge } from './app-updates.mjs'
import { loadMainWindow } from './main-window.mjs'

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

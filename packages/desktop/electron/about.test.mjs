import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('concurrent About requests share one window after asynchronous preferences load', async () => {
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
  const showAboutSource = source.slice(source.indexOf('const showAbout ='), source.indexOf('\n/**', source.indexOf('const showAbout =')))
  const pending = []
  const windows = []
  class Window {
    constructor() { windows.push(this) }
    isDestroyed() { return false }
    show() {}
    focus() {}
    setMenuBarVisibility() {}
    webContents = { setWindowOpenHandler() {} }
    once() {}
    on() {}
    loadFile() { return Promise.resolve() }
  }
  const open = new Function('app', 'host', 'BrowserWindow', 'join', 'assetsDir', 'process', `let aboutWindow = null; ${showAboutSource}; return showAbout`)(
    { focus() {}, getVersion: () => 'test' },
    { call: () => new Promise(resolve => pending.push(resolve)) },
    Window, (...parts) => parts.join('/'), '/assets', { versions: {} },
  )
  const first = open()
  const second = open()
  pending.forEach(resolve => resolve({}))
  await Promise.all([first, second])
  assert.equal(windows.length, 1)
  await open()
  assert.equal(windows.length, 1)
})

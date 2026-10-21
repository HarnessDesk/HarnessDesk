import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
test('Command-G in a native guest uses the menu to reach only the app renderer', () => {
  const calls = []
  const sandbox = { mainWindow: { webContents: { send: (...args) => calls.push(args) } },
    updateMenuItem: null, commandLineTool: { available: false }, showAbout() {}, menuBarVisible: false,
    Menu: { buildFromTemplate: template => template, setApplicationMenu: template => { sandbox.menu = template } } }
  const menu = source.slice(source.indexOf('const buildMenu = () => {'), source.indexOf('/**', source.indexOf('const buildMenu = () => {')))
  const send = source.slice(source.indexOf('const sendShortcut = (name) => {'), source.indexOf('/**', source.indexOf('const sendShortcut = (name) => {')))
  vm.runInNewContext(`${send}\n${menu}\nbuildMenu()`, sandbox)
  const view = sandbox.menu.find(item => item.label === 'View')
  const mode = view.submenu.find(item => item.accelerator === 'Cmd+G')
  assert.ok(mode, 'the global menu must claim Command-G even when the browser guest has focus')
  mode.click()
  assert.deepEqual(calls, [['harnessdesk:shortcut', 'toggle-editor-mode']])
  sandbox.mainWindow = null
  assert.doesNotThrow(() => mode.click())
})

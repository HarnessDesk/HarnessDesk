import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { trayMenuTemplate } from './tray-menu.mjs'

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))

test('View restores the menu bar item without requiring the missing item itself', () => {
  const choices = []
  const sandbox = {
    menuBarVisible: false, setMenuBarVisible: value => choices.push(value),
    updateMenuItem: null, commandLineTool: { available: false },
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { sandbox.menu = value } },
  }
  vm.runInNewContext(`${section('const buildMenu = () => {', '/**')}\nbuildMenu()`, sandbox)
  const choice = sandbox.menu.find(item => item.label === 'View').submenu.find(item => item.label === 'Show Menu Bar Icon')
  assert.ok(choice)
  assert.equal(choice.type, 'checkbox')
  assert.equal(choice.checked, false)
  choice.click({ checked: true })
  assert.deepEqual(choices, [true])
})

test('changing menu bar visibility saves the choice, disposes the item and refreshes the menu', () => {
  const calls = []
  const sandbox = {
    menuBarVisible: true, menuBarPreferenceFile: '/synthetic/menu-bar.json',
    tray: { destroy: () => calls.push('destroy') },
    writeMenuBarPreference: (_file, value) => calls.push(['save', value]),
    createTray: () => calls.push('create'), buildMenu: () => calls.push('menu'),
    logger: { warn: () => calls.push('warn') },
  }
  vm.runInNewContext(`${section('const setMenuBarVisible = (visible) => {', 'const createTray =')}\nsetMenuBarVisible(false)\nsetMenuBarVisible(true)`, sandbox)
  assert.equal(sandbox.menuBarVisible, true)
  assert.equal(sandbox.tray, null)
  assert.deepEqual(calls, [['save', false], 'destroy', 'menu', ['save', true], 'create', 'menu'])
})


test('native usage rows use a standard icon column with or without a reading', () => {
  const small = { getSize: () => ({ width: 16, height: 16 }) }
  const wide = { getSize: () => ({ width: 95, height: 16 }) }
  const sandbox = {
    Menu: { buildFromTemplate: value => value }, trayMenuTemplate,
    traySummary: { agents: [
      { id: 'signin', name: 'Workspace', detail: 'Sign in', needsSignIn: true, left: null, brand: 'agent' },
      { id: 'reading', name: 'Review', detail: '71% left', needsSignIn: false, left: 71, brand: 'agent' },
    ] },
    glyph: () => small, markFor: () => small, meterIcon: () => wide,
  }
  vm.runInNewContext(`${section('const buildTrayMenu = () =>', 'const setMenuBarVisible =')}\nresult = buildTrayMenu()`, sandbox)
  const usage = sandbox.result.find(item => item.label === 'Usage').submenu
  const rows = usage.filter(item => item.icon)
  assert.equal(rows.length, 3)
  for (const row of rows) assert.equal(row.icon.getSize().width, 16, row.label)
})

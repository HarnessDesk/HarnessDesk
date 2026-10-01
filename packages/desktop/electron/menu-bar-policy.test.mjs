import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { showsMenuBarItem } from './menu-bar-policy.mjs'

const defaultDir = join(homedir(), '.harnessdesk')
const otherDir = join(tmpdir(), 'harnessdesk-isolated-home')

test('shows the menu bar item for the default home', () => {
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: {} }), true)
})

test('hides the menu bar item for another home', () => {
  assert.equal(showsMenuBarItem({ stateDir: otherDir, defaultDir, env: {} }), false)
})

test('recognizes an explicit default home with a trailing slash', () => {
  assert.equal(showsMenuBarItem({ stateDir: `${defaultDir}/`, defaultDir, env: {} }), true)
})

test('the on override shows the item for another home', () => {
  assert.equal(showsMenuBarItem({ stateDir: otherDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'on' } }), true)
  assert.equal(showsMenuBarItem({ stateDir: otherDir, defaultDir, env: { HARNESSDESK_MENU_BAR: '1' } }), true)
})

test('the off override hides the item for the default home', () => {
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'off' } }), false)
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: '0' } }), false)
})

test('ignores an unrecognized override', () => {
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'yes' } }), true)
  assert.equal(showsMenuBarItem({ stateDir: otherDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'yes' } }), false)
})

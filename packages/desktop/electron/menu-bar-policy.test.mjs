import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { menuBarItemDecision, showsMenuBarItem } from './menu-bar-policy.mjs'

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

test('recognizes a home that is a symlink to the default home', () => {
  const root = mkdtempSync(join(tmpdir(), 'harnessdesk-menu-bar-'))
  try {
    const ownHome = join(root, 'own-home')
    const linkedHome = join(root, 'linked-home')
    mkdirSync(ownHome)
    symlinkSync(ownHome, linkedHome, 'dir')
    assert.equal(showsMenuBarItem({ stateDir: linkedHome, defaultDir: ownHome, env: {} }), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('falls back to resolved paths when neither home exists yet', () => {
  const root = mkdtempSync(join(tmpdir(), 'harnessdesk-menu-bar-'))
  try {
    const missingHome = join(root, 'not-created', '..', 'own-home')
    const defaultHome = join(root, 'own-home')
    assert.equal(showsMenuBarItem({ stateDir: missingHome, defaultDir: defaultHome, env: {} }), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the on override shows the item for another home', () => {
  assert.equal(showsMenuBarItem({ stateDir: otherDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'on' } }), true)
  assert.equal(showsMenuBarItem({ stateDir: otherDir, defaultDir, env: { HARNESSDESK_MENU_BAR: '1' } }), true)
})

test('the off override hides the item for the default home', () => {
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'off' } }), false)
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: '0' } }), false)
  assert.deepEqual(menuBarItemDecision({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'off' } }), {
    show: false,
    reason: 'disabled by HARNESSDESK_MENU_BAR',
  })
})

test('ignores an unrecognized override', () => {
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'yes' } }), true)
  assert.equal(showsMenuBarItem({ stateDir: otherDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'yes' } }), false)
})

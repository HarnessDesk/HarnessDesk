import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { menuBarItemDecision, showsMenuBarItem, readMenuBarPreference, writeMenuBarPreference } from './menu-bar-policy.mjs'

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

test('an explicit user choice restores a hidden isolated desk and survives its launch defaults', () => {
  assert.deepEqual(menuBarItemDecision({ stateDir: otherDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'off' }, preference: true }), {
    show: true, reason: 'saved user choice',
  })
  assert.equal(showsMenuBarItem({ stateDir: defaultDir, defaultDir, env: { HARNESSDESK_MENU_BAR: 'on' }, preference: false }), false)
})

test('menu bar visibility persists both choices and ignores missing or malformed preferences', () => {
  const root = mkdtempSync(join(tmpdir(), 'harnessdesk-menu-preference-'))
  const file = join(root, 'desk', 'menu-bar.json')
  try {
    assert.equal(readMenuBarPreference(file), undefined)
    for (const visible of [true, false]) {
      writeMenuBarPreference(file, visible)
      assert.equal(readMenuBarPreference(file), visible)
    }
    for (const raw of ['{', 'null', '{"visible":"yes"}', '{}']) {
      writeFileSync(file, raw)
      assert.equal(readMenuBarPreference(file), undefined)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

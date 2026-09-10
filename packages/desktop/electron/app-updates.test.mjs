import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { attachAppUpdates, feedOverride, updatesAllowed } from './app-updates.mjs'

/**
 * The updater's decisions, exercised against a fake electron-updater. What is
 * pinned here is the behaviour the shell promises: background checks that
 * never interrupt, dialogs only for checks the person asked for, one menu
 * item whose words follow the phase, and downgrade left open as the rollback
 * path.
 */

/** An electron-updater-shaped fake: the same events, recorded calls. */
const fakeUpdater = () => {
  const updater = new EventEmitter()
  updater.calls = { checks: 0, installs: 0, feeds: [] }
  updater.checkForUpdates = () => {
    updater.calls.checks += 1
    return Promise.resolve(null)
  }
  updater.quitAndInstall = () => {
    updater.calls.installs += 1
  }
  updater.setFeedURL = (options) => {
    updater.calls.feeds.push(options)
  }
  return updater
}

/** Attach with recording callbacks; dialogs answer with `answer`. */
const rig = ({ env = {}, packaged = true, answer = 0 } = {}) => {
  const updater = fakeUpdater()
  const menus = []
  const dialogs = []
  const flow = attachAppUpdates({
    updater,
    env,
    packaged,
    version: '0.1.0',
    onMenu: (item) => menus.push(item),
    showDialog: (request) => {
      dialogs.push(request)
      return Promise.resolve(answer)
    },
  })
  return { updater, menus, dialogs, flow }
}

test('checks are for packaged apps, the kill switch wins, a feed opens the dev door', () => {
  assert.equal(updatesAllowed({ packaged: true, env: {} }), true)
  assert.equal(updatesAllowed({ packaged: false, env: {} }), false)
  assert.equal(updatesAllowed({ packaged: true, env: { HARNESSDESK_NO_UPDATE_CHECK: '1' } }), false)
  assert.equal(
    updatesAllowed({ packaged: false, env: { HARNESSDESK_UPDATE_FEED: 'http://127.0.0.1:9000' } }),
    true,
  )
  assert.equal(feedOverride({ HARNESSDESK_UPDATE_FEED: '  ' }), null)
  assert.equal(feedOverride({ HARNESSDESK_UPDATE_FEED: ' http://x ' }), 'http://x')
})

test('disallowed means no menu item and never a network call', () => {
  const { updater, menus, flow } = rig({ packaged: false })
  assert.deepEqual(menus, [null])
  flow.check(true)
  assert.equal(updater.calls.checks, 0)
  flow.dispose()
})

test('the one menu item follows the phase from check to restart', () => {
  const { updater, flow } = rig()
  assert.equal(flow.menu().label, 'Check for Updates…')

  flow.check(false)
  updater.emit('checking-for-update')
  assert.equal(flow.menu().label, 'Checking for Updates…')
  assert.equal(flow.menu().enabled, false)

  updater.emit('update-available', { version: '0.2.0' })
  assert.equal(flow.menu().label, 'Downloading Update…')

  updater.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(flow.menu().label, 'Restart to Update (0.2.0)')
  assert.equal(flow.menu().enabled, true)

  // The ready item installs rather than re-checking.
  flow.menu().click()
  assert.equal(updater.calls.installs, 1)
  flow.dispose()
})

test('a background check stays out of the way, ready or not', () => {
  const { updater, dialogs, flow } = rig()
  flow.check(false)
  updater.emit('checking-for-update')
  updater.emit('update-not-available')
  updater.emit('checking-for-update')
  updater.emit('update-available', { version: '0.2.0' })
  updater.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(dialogs, [])
  flow.dispose()
})

test('an asked-for check answers: up to date, restart offer, or the error', async () => {
  const { updater, dialogs, flow } = rig({ answer: 0 })

  flow.check(true)
  updater.emit('checking-for-update')
  updater.emit('update-not-available')
  assert.equal(dialogs.length, 1)
  assert.match(dialogs[0].detail, /0\.1\.0/)

  flow.check(true)
  updater.emit('checking-for-update')
  updater.emit('update-available', { version: '0.2.0' })
  updater.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(dialogs.length, 2)
  assert.deepEqual(dialogs[1].buttons, ['Restart Now', 'Later'])
  // `answer: 0` chose Restart Now; the install call follows the promise.
  await Promise.resolve()
  assert.equal(updater.calls.installs, 1)

  flow.dispose()
})

test('errors end quietly in the background and out loud when asked', () => {
  const background = rig()
  background.flow.check(false)
  background.updater.emit('checking-for-update')
  background.updater.emit('error', new Error('feed unreachable'))
  assert.deepEqual(background.dialogs, [])
  assert.equal(background.flow.menu().label, 'Check for Updates…')
  background.flow.dispose()

  const asked = rig()
  asked.flow.check(true)
  asked.updater.emit('checking-for-update')
  asked.updater.emit('error', new Error('feed unreachable'))
  assert.equal(asked.dialogs.length, 1)
  assert.match(asked.dialogs[0].detail, /feed unreachable/)
  asked.flow.dispose()
})

test('an error after download keeps the downloaded update', () => {
  const { updater, flow } = rig()
  flow.check(false)
  updater.emit('checking-for-update')
  updater.emit('update-available', { version: '0.2.0' })
  updater.emit('update-downloaded', { version: '0.2.0' })
  updater.emit('error', new Error('a later background check failed'))
  assert.equal(flow.menu().label, 'Restart to Update (0.2.0)')
  flow.dispose()
})

test('rollback stays open: downgrade allowed, installs on quit, feed overridable', () => {
  const { updater, flow } = rig({
    env: { HARNESSDESK_UPDATE_FEED: 'http://127.0.0.1:9000/feed' },
    packaged: false,
  })
  assert.equal(updater.allowDowngrade, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.forceDevUpdateConfig, true)
  assert.deepEqual(updater.calls.feeds, [
    { provider: 'generic', url: 'http://127.0.0.1:9000/feed' },
  ])
  flow.dispose()
})

test('no double-check while one is running', () => {
  const { updater, flow } = rig()
  flow.check(false)
  updater.emit('checking-for-update')
  flow.check(true)
  assert.equal(updater.calls.checks, 1)
  flow.dispose()
})

test('a check once the update is downloaded keeps it, and an asked-for one offers the restart', async () => {
  // #48: the four-hourly check ran with an update ready, and the menu went back to Check for Updates.
  const { updater, dialogs, flow } = rig({ answer: 1 })
  flow.check(false)
  updater.emit('checking-for-update')
  updater.emit('update-available', { version: '0.2.0' })
  updater.emit('update-downloaded', { version: '0.2.0' })
  const checks = updater.calls.checks
  flow.check(false)
  assert.equal(updater.calls.checks, checks, 'the background check did not run')
  assert.equal(flow.menu().label, 'Restart to Update (0.2.0)')
  flow.check(true)
  assert.equal(updater.calls.checks, checks, 'nor the asked-for one')
  assert.equal(dialogs.at(-1)?.message, 'HarnessDesk 0.2.0 is ready')
  await Promise.resolve()
  assert.equal(updater.calls.installs, 0, 'Later leaves it for the next quit')
  flow.dispose()
})

test('the restart offer answers Escape with Later, and Restart Now from it installs', async () => {
  // Round 1 of #165: with no cancel button named, Electron answers 0 for Escape, and 0 was Restart Now.
  const later = rig({ answer: 1 })
  later.updater.emit('update-downloaded', { version: '0.2.0' })
  later.flow.check(true)
  const offer = later.dialogs.at(-1)
  assert.equal(offer?.buttons[offer.cancelId], 'Later')
  later.flow.dispose()

  const now = rig({ answer: 0 })
  now.updater.emit('update-downloaded', { version: '0.2.0' })
  now.flow.check(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(now.updater.calls.installs, 1)
  now.flow.dispose()
})

test('a dialog that fails is logged, not left to crash the shell', async () => {
  // Round 1 of #165: the shell reads an unhandled rejection as a crash and relaunches.
  const updater = fakeUpdater()
  const logged = []
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const flow = attachAppUpdates({
      updater,
      env: {},
      packaged: true,
      version: '0.1.0',
      onMenu: () => {},
      showDialog: () => Promise.reject(new Error('the window closed')),
      log: (message) => logged.push(message),
    })
    updater.emit('update-downloaded', { version: '0.2.0' })
    flow.check(true)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
    assert.ok(logged.includes('app update dialog failed'))
    assert.equal(updater.calls.installs, 0)
    flow.dispose()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

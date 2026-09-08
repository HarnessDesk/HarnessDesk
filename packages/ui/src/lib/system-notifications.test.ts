import { expect, it } from 'vitest'

import {
  readSystemNotifications,
  SYSTEM_NOTIFICATION_KINDS,
  systemNotificationOn,
} from './system-notifications'

/**
 * The settings side of macOS notifications. The desktop shell's decider
 * (`packages/desktop/electron/notifications.mjs`) keeps the same four ids and
 * the same defaults-on reading; its own test pins the same set, so a drift
 * between the two lists fails a suite on whichever side moved.
 */

it('names exactly the four kinds the desktop decider knows', () => {
  expect(SYSTEM_NOTIFICATION_KINDS.map((entry) => entry.kind).sort()).toEqual([
    'approvals',
    'failures',
    'needsYou',
    'turns',
  ])
})

it('everything defaults on, each switch is its own, and the master wins', () => {
  expect(systemNotificationOn({}, 'turns')).toBe(true)
  expect(systemNotificationOn({ turns: false }, 'turns')).toBe(false)
  expect(systemNotificationOn({ turns: false }, 'failures')).toBe(true)
  expect(systemNotificationOn({ enabled: false, turns: true }, 'turns')).toBe(false)
})

it('reads stored switches defensively', () => {
  expect(readSystemNotifications(null)).toEqual({})
  expect(readSystemNotifications('nonsense')).toEqual({})
  expect(readSystemNotifications({ turns: false, junk: 'yes' })).toEqual({ turns: false })
})

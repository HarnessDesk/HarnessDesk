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

it('names exactly the eight kinds the desktop decider knows, Intake’s two included', () => {
  expect(SYSTEM_NOTIFICATION_KINDS.map((entry) => entry.kind).sort()).toEqual([
    'approvals',
    'failures',
    'goalNeedsYou',
    'goalReadyToWrap',
    'needsYou',
    'triggerAttention',
    'triggerSkipped',
    'turns',
  ])
})

it('a trigger notification is silenced the same way as every other kind: by itself, or by the master', () => {
  expect(systemNotificationOn({}, 'triggerSkipped')).toBe(true)
  expect(systemNotificationOn({ triggerSkipped: false }, 'triggerSkipped')).toBe(false)
  expect(systemNotificationOn({ triggerSkipped: false }, 'triggerAttention')).toBe(true)
  expect(systemNotificationOn({ enabled: false }, 'triggerAttention')).toBe(false)
})

it('everything defaults on, each switch is its own, and the master wins', () => {
  expect(systemNotificationOn({}, 'turns')).toBe(true)
  expect(systemNotificationOn({ turns: false }, 'turns')).toBe(false)
  expect(systemNotificationOn({ turns: false }, 'failures')).toBe(true)
  expect(systemNotificationOn({ enabled: false, turns: true }, 'turns')).toBe(false)
  expect(systemNotificationOn({}, 'goalNeedsYou')).toBe(true)
  expect(systemNotificationOn({ goalReadyToWrap: false }, 'goalReadyToWrap')).toBe(false)
})

it('reads stored switches defensively', () => {
  expect(readSystemNotifications(null)).toEqual({})
  expect(readSystemNotifications('nonsense')).toEqual({})
  expect(readSystemNotifications({ turns: false, junk: 'yes' })).toEqual({ turns: false })
})

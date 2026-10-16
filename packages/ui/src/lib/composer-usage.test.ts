import { expect, it } from 'vitest'
import { sessionKey, type Session, type UsageReport } from '@harnessdesk/protocol'
import { emptySnapshot } from '../state/snapshot'
import { composerPaceVisible } from './composer-usage'

const key = sessionKey('demo', 'work')
const snapshot = (left: number, turns: number) => ({
  ...emptySnapshot(),
  sessions: new Map([[key, { turns: Array.from({ length: turns }, () => ({})) } as unknown as Session]]),
  usage: [{ runtime: 'demo', lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 100 - left, usageKnown: true }] } as unknown as UsageReport],
})
it.each([0, 14, 15, 60])('keeps a fresh desk quiet at %s percent left', left => {
  expect(composerPaceVisible(snapshot(left, 0), 'demo')).toBe(false)
})
it.each([[14, true], [14.99, true], [15, false], [60, false]])('after work, %s percent left draws: %s', (left, visible) => {
  expect(composerPaceVisible(snapshot(left as number, 1), 'demo')).toBe(visible)
})
it('does not count a history preview or an empty conversation as work in the desk', () => {
  const state = snapshot(14, 1)
  state.previewSessions = new Set([key])
  expect(composerPaceVisible(state, 'demo')).toBe(false)
})

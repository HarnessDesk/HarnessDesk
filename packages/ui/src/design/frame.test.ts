import { describe, expect, test } from 'vitest'
import { FRAME, FRAME_TOKENS } from './frame'

describe('the frame contract', () => {
  test('a default sits inside its drag limits', () => {
    expect(FRAME.sidebar.width).toBeGreaterThanOrEqual(FRAME.sidebar.min)
    expect(FRAME.sidebar.width).toBeLessThanOrEqual(FRAME.sidebar.max)
    expect(FRAME.rightPanel.width).toBeGreaterThanOrEqual(FRAME.rightPanel.min)
    expect(FRAME.rightPanel.width).toBeLessThanOrEqual(FRAME.rightPanel.max)
  })

  test('a menu row is the surface radius less its padding', () => {
    expect(FRAME.menu.rowRadius).toBe(FRAME.menu.radius - FRAME.menu.padding)
  })

  test('each fold leaves main its minimum', () => {
    expect(FRAME.fold.panelFloats).toBeGreaterThanOrEqual(FRAME.sidebar.width + FRAME.rightPanel.width + FRAME.main.min)
    expect(FRAME.fold.sidebarFloats).toBeGreaterThanOrEqual(FRAME.sidebar.width + FRAME.main.min)
  })

  test('every token resolves to a whole pixel', () => {
    for (const [token, px] of Object.entries(FRAME_TOKENS)) {
      expect(token.startsWith('--hd-')).toBe(true)
      expect(Number.isInteger(px)).toBe(true)
    }
  })
})

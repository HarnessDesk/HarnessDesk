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

  test('D1 floats the sidebar and replaces main with its pane below 1000', () => {
    // D1 fixes this boundary at 1000; above it the pane clamps to the
    // remaining width instead of requiring all three default widths.
    expect(FRAME.fold.panelFloats).toBe(1000)
    expect(FRAME.fold.sidebarFloats).toBe(1000)
    expect(FRAME.fold.sidebarFloats).toBeGreaterThanOrEqual(FRAME.sidebar.width + FRAME.main.min)
  })

  test('every token resolves to a whole pixel', () => {
    for (const [token, px] of Object.entries(FRAME_TOKENS)) {
      expect(token.startsWith('--hd-')).toBe(true)
      expect(Number.isInteger(px)).toBe(true)
    }
  })
})

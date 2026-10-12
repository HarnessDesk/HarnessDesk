import { FRAME } from '../frame'

/** The reading floor yields only enough to keep the tool's minimum usable. */
export const frameReadingFloor = (windowWidth: number, standingSidebar = 0, seam = 1): number =>
  Math.min(FRAME.main.min, Math.max(0, windowWidth - standingSidebar - FRAME.rightPanel.min - 2 * seam))

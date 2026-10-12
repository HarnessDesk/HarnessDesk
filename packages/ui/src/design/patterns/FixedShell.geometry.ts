import { FRAME } from '../frame'

/** Below the reading floor, an open tool keeps the existing viewport gutter. */
export const frameReadingFloor = (windowWidth: number, seam = 1): number =>
  windowWidth > FRAME.main.min + 2 * seam ? FRAME.main.min : Math.max(0, FRAME.page.canvasGutter - 2 * seam)


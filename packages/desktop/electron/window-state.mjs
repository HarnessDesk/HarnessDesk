import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Window geometry persistence.
 *
 * Restoring a window off-screen is worse than not restoring it — an external
 * display that is no longer attached would otherwise leave the app invisible —
 * so a saved rectangle is only used when it still intersects a live display.
 */

export const DEFAULT_BOUNDS = { width: 1280, height: 840 }

/** The top strip of a window, where it is grabbed to be moved. */
const TITLE_BAR = 40

export const isVisibleOn = (bounds, displays) => {
  if (!bounds) return false
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return false
  if (width < 480 || height < 400) return false
  // At least a reasonable slice of the title bar has to land on some display,
  // or the user cannot grab the window to move it.
  return displays.some((display) => {
    const area = display.workArea ?? display.bounds
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x)
    /* The strip that has to be on a display is the title bar, not the window:
       measured over the whole window, one far above the display passed on
       the part of it hanging below the top edge (#50). */
    const barBottom = y + Math.min(TITLE_BAR, height)
    const overlapY = Math.min(barBottom, area.y + area.height) - Math.max(y, area.y)
    return overlapX > 120 && overlapY >= TITLE_BAR / 2
  })
}

export const readWindowState = async (file, displays) => {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const bounds = raw?.bounds
    if (isVisibleOn(bounds, displays)) {
      return { bounds, maximized: Boolean(raw.maximized) }
    }
  } catch {
    // No saved state, or it was unusable. Either way, fall back to defaults.
  }
  return { bounds: { ...DEFAULT_BOUNDS }, maximized: false }
}

export const writeWindowState = async (file, state) => {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    // Losing geometry is not worth surfacing to the user.
  }
}

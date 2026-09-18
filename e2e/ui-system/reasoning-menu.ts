import type { Page } from '@playwright/test'

/* The composer's model menu and its "Reasoning effort" flyout, as the two
   flyout specs reach them in the preview. */

export const modelControl = (page: Page) => page.locator('button[title$="odel and reasoning"]')
export const reasoningRow = (page: Page) => page.getByRole('menuitem', { name: /^Reasoning effort/ })
export const level = (page: Page, name: RegExp) => page.getByRole('menuitemradio', { name })

/**
 * From a point on the row to a level in its flyout, the short way: sideways
 * out of the row at the row's own height — which the flyout always spans —
 * and into the flyout, then along the flyout to the level.
 *
 * Not the straight diagonal a hand might take. That spends its middle over
 * the menu's other rows, outside both the row and the flyout, where Base UI
 * closes a flyout the pointer has not reached within 40ms of its last move:
 * a hand that pauses there loses it, and so did CI, whose pointer steps came
 * 26ms apart on average. Sideways, the gap between row and flyout is Base
 * UI's trough, where no such clock runs — and the row is still left, which
 * is the step that used to close the flyout.
 */
export async function pointAtLevel(page: Page, from: { x: number; y: number }, name: RegExp) {
  const placed = await level(page, name).evaluate((node) => {
    const flyout = node.closest('[data-slot="dropdown-menu-sub-content"]')!.getBoundingClientRect()
    const item = node.getBoundingClientRect()
    return { left: flyout.left, right: flyout.right, x: item.x, y: item.y, height: item.height }
  })
  const inside = Math.min(Math.max(from.x, placed.left + 24), placed.right - 24)
  await page.mouse.move(inside, from.y, { steps: 8 })
  await page.mouse.move(placed.x + 40, placed.y + placed.height / 2, { steps: 8 })
}

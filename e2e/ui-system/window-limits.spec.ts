import { expect, test, type Locator, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

// Actual painted limits complement the pure FRAME state checks.
const MIN_READING = FRAME.main.min
const SIDEBAR = FRAME.sidebar.width
const SEAM = 1

const main = (page: Page): Locator => page.locator('[data-slot="workbench-main"]')
// A dock's `data-edge` is the edge its rule is drawn on: the right panel's left.
const rightPanel = (page: Page): Locator => page.locator('[data-frame-region="right"]')
const seam = (page: Page): Locator => page.getByRole('separator', { name: 'Resize the right panel' })
const widthOf = (locator: Locator): Promise<number> => locator.evaluate((node) => node.getBoundingClientRect().width)

/**
 * The whole of a box lies inside a window `width` wide — once it has settled:
 * the sidebar slides in and the columns trade width over a transition, and the
 * suite's reduced motion is what makes that instant, not this spec. A poll
 * accepts the first sample that matches, so the box is let settle and read
 * again: one that is only inside on its way somewhere else is not.
 */
const insideWindow = async (locator: Locator, width: number, what: string): Promise<void> => {
  const where = async (): Promise<string> => {
    const box = await locator.boundingBox()
    if (box === null) return 'not on screen'
    return box.x >= 0 && box.x + box.width <= width ? 'inside' : `x ${box.x}, width ${box.width}`
  }
  await expect.poll(where, `${what} lies inside a ${width}px window`).toBe('inside')
  await settled(locator)
  expect(await where(), `${what} lies inside a ${width}px window (once settled)`).toBe('inside')
}

/** Two reads of a box, a poll apart, agree: whatever was sliding has stopped. */
const settled = async (locator: Locator): Promise<void> => {
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(await locator.boundingBox())
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
}

/**
 * A box's width comes to rest at `want`. Reading it once is not enough while
 * the columns trade width over a transition: a poll accepts the first sample
 * that matches, and a width that only passes through `want` on its way to
 * another would be taken for it. So it is let settle, and read again.
 */
const widthRestsAt = async (locator: Locator, want: number, what: string): Promise<void> => {
  await expect.poll(() => widthOf(locator), what).toBe(want)
  await settled(locator)
  expect(await widthOf(locator), `${what} (once settled)`).toBe(want)
}

const scrollsSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)

/** A pointer drag from the seam to `x`, the way a hand does it: down, several moves, up. */
const dragSeamTo = async (page: Page, x: number): Promise<void> => {
  await settled(seam(page))
  const box = await seam(page).boundingBox()
  expect(box, 'the right panel has a seam to drag').not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(x, 400, { steps: 6 })
  await page.mouse.up()
}

const shell = (page: Page) => page.locator('[data-slot="fixed-shell"]')
const open = async (page: Page, width = 1440) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/narrow-overlay.html')
  await expect(page.locator('[data-slot="work-tools"]')).toBeVisible()
}

test('the narrow panel floats within the window and only sidebar makes main inert', async ({ page }) => {
  for (const width of [720, 600, 480, 360]) {
    await open(page, width)
    await expect(shell(page)).toHaveAttribute('data-panel-floats', 'true')
    await expect(shell(page)).toHaveAttribute('data-left-floats', 'true')
    await insideWindow(rightPanel(page), width, 'floating right tool')
    expect(await main(page).evaluate(node => node.closest('[inert]') !== null)).toBe(false)
    await page.getByPlaceholder('Filter steps').focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-slot="work-tools"]')).toBeHidden()
    await widthRestsAt(main(page), width, 'conversation retains the window')
    const show = page.getByRole('button', { name: 'Show sidebar', exact: true })
    await show.click()
    const sidebar = page.getByRole('dialog', { name: 'Sidebar' })
    await expect(sidebar).toBeVisible()
    await insideWindow(sidebar, width, 'floating sidebar')
    expect(await main(page).evaluate(node => node.closest('[inert]') !== null)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(sidebar).toHaveCount(0)
    await expect(show).toBeFocused()
    expect(await main(page).evaluate(node => node.closest('[inert]') !== null)).toBe(false)
    expect(await scrollsSideways(page)).toBe(false)
  }
})

test('sidebar stands at exactly 1000 and floats at 999 independently of requested right width', async ({ page }) => {
  await open(page)
  await dragSeamTo(page, 0)
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.max, 'requested maximum')
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect(shell(page)).toHaveAttribute('data-left-floats', 'false')
  await expect(shell(page)).toHaveAttribute('data-panel-floats', 'true')
  await widthRestsAt(main(page), 1000 - SIDEBAR - FRAME.rightPanel.min, 'standing sidebar yields only at the tool minimum')
  await page.setViewportSize({ width: 999, height: 900 })
  await expect(shell(page)).toHaveAttribute('data-left-floats', 'true')
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeVisible()
  await widthRestsAt(main(page), MIN_READING + 2 * SEAM, 'floating sidebar takes no column')
})

test('right folds at 1280 independently of sidebar and restores requested width after passive clamping', async ({ page }) => {
  await open(page)
  await dragSeamTo(page, 0)
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.max, 'requested maximum')
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(shell(page)).toHaveAttribute('data-panel-floats', 'false')
  await widthRestsAt(rightPanel(page), 1280 - SIDEBAR - MIN_READING - 2 * SEAM, 'effective clamp')
  expect(await widthOf(main(page))).toBeGreaterThanOrEqual(MIN_READING)
  await page.setViewportSize({ width: 1279, height: 900 })
  await expect(shell(page)).toHaveAttribute('data-panel-floats', 'true')
  await widthRestsAt(rightPanel(page), 1279 - SIDEBAR - MIN_READING - 2 * SEAM, 'float preserves the reading floor')
  await page.setViewportSize({ width: 1440, height: 900 })
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.max, 'wide restores request')
  expect(await widthOf(main(page))).toBeGreaterThanOrEqual(MIN_READING)
})

test('real right seam obeys floor ceiling current viewport landing and double-click default', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await dragSeamTo(page, 0)
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.max, 'ceiling')
  await dragSeamTo(page, 1440)
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.min, 'floor')
  const box = (await seam(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(0, 400, { steps: 6 })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.mouse.up()
  await widthRestsAt(rightPanel(page), 1280 - SIDEBAR - MIN_READING - 2 * SEAM, 'current viewport landing')
  expect(await widthOf(main(page))).toBeGreaterThanOrEqual(MIN_READING)
  await page.setViewportSize({ width: 1440, height: 900 })
  await seam(page).dblclick()
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.width, 'default')
  await seam(page).focus()
  for (let i = 0; i < 40; i++) await seam(page).press('ArrowRight')
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.min, 'keyboard floor')
})

test('a live sidebar seam preserves main480 and restores the requested right width', async ({ page }) => {
  await open(page)
  await dragSeamTo(page, 0)
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.max, 'requested right maximum')
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  const left = page.locator('[data-frame-region="left"]')
  const firstTool = page.locator('[data-work-tool="details"]')
  const more = page.getByRole('button', { name: 'More', exact: true })
  const moreX = (await more.boundingBox())!.x
  const handle = page.getByRole('separator', { name: 'Resize the sidebar', exact: true })
  const box = (await handle.boundingBox())!
  const start = box.x + box.width / 2
  await page.mouse.move(start, 400)
  await page.mouse.down()
  await page.mouse.move(start + FRAME.sidebar.max - FRAME.sidebar.width, 400, { steps: 8 })
  await widthRestsAt(left, FRAME.sidebar.max, 'live sidebar maximum')
  console.log('Live sidebar geometry', JSON.stringify({ left: await widthOf(left), right: await widthOf(rightPanel(page)), main: await widthOf(main(page)) }))
  expect(await widthOf(main(page)), 'standing main keeps its reading floor during the drag').toBeGreaterThanOrEqual(FRAME.main.min)
  await widthRestsAt(rightPanel(page), 1440 - FRAME.sidebar.max - MIN_READING - 2 * SEAM, 'right follows live sidebar')
  expect((await firstTool.boundingBox())!.x - (await page.locator('[data-slot="work-tools"]').boundingBox())!.x).toBe(FRAME.bar.pad)
  expect((await more.boundingBox())!.x).toBe(moreX)
  await page.mouse.up()
  expect(await widthOf(main(page))).toBeGreaterThanOrEqual(FRAME.main.min)
  const landed = (await handle.boundingBox())!
  await page.mouse.move(landed.x + landed.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(landed.x + landed.width / 2 - FRAME.sidebar.max + FRAME.sidebar.width, 400, { steps: 8 })
  await page.mouse.up()
  await widthRestsAt(rightPanel(page), FRAME.rightPanel.max, 'requested right maximum returns')
})

import { expect, test, type Locator, type Page } from '@playwright/test'

/*
 * What jsdom cannot see: the window's own width against the layout it draws.
 * `workbench.test.ts` holds the arithmetic (`sidebarCannotHaveColumn`,
 * `rightPanelOverlays`, the seam's ceiling); this holds it to the pixels —
 * the divider between two columns is a pixel of one of them, and a sum that
 * forgets it left the conversation at 398px beside a panel that promised 400.
 *
 * Same fixture as `narrow-right-panel-overlay.spec.ts`: a conversation with a
 * 460px Trajectory panel docked on the right, and the sidebar put away.
 */

const MIN_READING = 400
const SIDEBAR = 240
const SEAM = 1

const main = (page: Page): Locator => page.locator('[data-slot="workbench-main"]')
// A dock's `data-edge` is the edge its rule is drawn on: the right panel's left.
const rightPanel = (page: Page): Locator => page.locator('[data-slot="dock-panel"][data-edge="left"]')
const seam = (page: Page): Locator => page.getByRole('separator', { name: 'Resize the right panel' })
const widthOf = (locator: Locator): Promise<number> => locator.evaluate((node) => node.getBoundingClientRect().width)

/**
 * The whole of a box lies inside a window `width` wide — once it has settled:
 * the sidebar slides in and the columns trade width over a transition, and the
 * suite's reduced motion is what makes that instant, not this spec.
 */
const insideWindow = async (locator: Locator, width: number, what: string): Promise<void> => {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox()
      if (box === null) return 'not on screen'
      return box.x >= 0 && box.x + box.width <= width ? 'inside' : `x ${box.x}, width ${box.width}`
    }, `${what} lies inside a ${width}px window`)
    .toBe('inside')
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

test('below 720px the panel covers the window, the sidebar floats and nothing runs off the edge', async ({ page }) => {
  for (const width of [600, 480, 360]) {
    await page.goto('/narrow-overlay.html')
    await page.setViewportSize({ width, height: 800 })
    const shell = page.locator('[data-narrow]')
    const hide = page.getByRole('button', { name: 'Hide this panel' })

    // The panel is the window: no column of it beside anything, and its own
    // controls are still inside the edge it was clipped to.
    await expect(shell, `${width}px: the sidebar has given up its column`).toHaveCount(1)
    await expect(main(page)).toHaveAttribute('data-right-panel-overlay', '')
    await expect
      .poll(async () => {
        const box = await rightPanel(page).boundingBox()
        return box === null ? 'not on screen' : `x ${box.x}, width ${box.width}`
      }, `${width}px: the panel fills the window`)
      .toBe(`x 0, width ${width}`)
    await insideWindow(hide, width, `${width}px: the panel's hide control`)
    expect(await scrollsSideways(page), `${width}px: the covered window scrolls sideways`).toBe(false)

    // Put away, the conversation is the whole window — not a sliver beside
    // a sidebar that has nowhere to stand.
    await hide.click()
    await expect(main(page)).not.toHaveAttribute('inert', '')
    await widthRestsAt(main(page), width, `${width}px: the conversation takes the window`)
    await insideWindow(page.locator('textarea').first(), width, `${width}px: the composer`)
    expect(await scrollsSideways(page), `${width}px: the conversation scrolls sideways`).toBe(false)

    // The sidebar comes over it, whole, and Escape gives the conversation back.
    const show = page.getByRole('button', { name: 'Show sidebar' })
    await show.click()
    const sidebar = page.getByRole('dialog', { name: 'Sidebar' })
    await expect(sidebar).toBeVisible()
    await insideWindow(sidebar, width, `${width}px: the floating sidebar`)
    expect(await main(page).evaluate((node) => node.closest('[inert]') !== null), `${width}px: what it covers is out of reach`).toBe(true)
    await page.keyboard.press('Escape')
    await expect(sidebar).toHaveCount(0)
    expect(await main(page).evaluate((node) => node.closest('[inert]') !== null), `${width}px: the conversation is back`).toBe(false)
    await expect(show, `${width}px: focus returns to what opened the sidebar`).toBeFocused()
    expect(await scrollsSideways(page), `${width}px: the window scrolls sideways`).toBe(false)
  }
})

test('the sidebar keeps its column at exactly 720px and gives it up at 719px', async ({ page }) => {
  await page.goto('/narrow-overlay.html')
  await page.setViewportSize({ width: 720, height: 800 })
  await page.getByRole('button', { name: 'Hide this panel' }).click()
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect(page.locator('[data-narrow]')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toHaveCount(0)
  await widthRestsAt(main(page), 720 - SIDEBAR - SEAM, 'a column and the conversation beside it')

  await page.setViewportSize({ width: 719, height: 800 })
  await expect(page.locator('[data-narrow]')).toHaveCount(1)
  await widthRestsAt(main(page), 719, 'no column left to take a share of the window')
})

test('the right seam stops where the conversation would fall under its reading width', async ({ page }) => {
  await page.goto('/narrow-overlay.html')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect(page.locator('[data-narrow]')).toHaveCount(0)

  // A drag as far left as the pointer goes: the ceiling, to the pixel. The
  // panel beside a sidebar column leaves 1440 - 241 - 1 - 400.
  await dragSeamTo(page, 0)
  const ceiling = 1440 - (SIDEBAR + SEAM) - SEAM - MIN_READING
  await widthRestsAt(rightPanel(page), ceiling, 'the right panel at its ceiling')
  await widthRestsAt(main(page), MIN_READING, 'the conversation is exactly its reading width')
  // And that is the very line the sidebar keeps its column on: the drag must
  // not have flipped anything under the pointer.
  await expect(page.locator('[data-narrow]')).toHaveCount(0)
  await expect(main(page)).not.toHaveAttribute('data-right-panel-overlay', '')

  // The line is a pixel wide in both directions, for each thing that gives way.
  // One pixel less and the sidebar floats, the conversation keeping what the
  // column gave up…
  await page.setViewportSize({ width: 1439, height: 900 })
  await expect(page.locator('[data-narrow]')).toHaveCount(1)
  await expect(main(page)).not.toHaveAttribute('data-right-panel-overlay', '')
  await widthRestsAt(main(page), 1439 - ceiling - SEAM, 'the conversation with the sidebar floating')
  // …until the panel itself would leave less than the reading width: at 1199 it
  // still leaves exactly 400, at 1198 it covers the conversation.
  await page.setViewportSize({ width: ceiling + SEAM + MIN_READING, height: 900 })
  await expect(main(page)).not.toHaveAttribute('data-right-panel-overlay', '')
  await widthRestsAt(main(page), MIN_READING, 'the conversation at its reading width')
  await page.setViewportSize({ width: ceiling + SEAM + MIN_READING - 1, height: 900 })
  await expect(main(page)).toHaveAttribute('data-right-panel-overlay', '')
})

test('the right seam has a ceiling and a floor with the sidebar in a column and without it', async ({ page }) => {
  // At 1000px the default 460px panel leaves no room for a sidebar column
  // (240 + 460 + 400 + 2 dividers is 1102), so the sidebar is simply away and
  // the same drag has its share to spend.
  for (const { width, column } of [
    { width: 1200, column: true },
    { width: 1000, column: false },
  ]) {
    await page.goto('/narrow-overlay.html')
    await page.setViewportSize({ width, height: 900 })
    if (column) await page.getByRole('button', { name: 'Show sidebar' }).click()
    const ceiling = width - (column ? SIDEBAR + SEAM : 0) - SEAM - MIN_READING
    const what = `${width}px${column ? ' with a sidebar column' : ''}`

    await dragSeamTo(page, 0)
    await widthRestsAt(rightPanel(page), ceiling, `${what}: the ceiling`)
    await widthRestsAt(main(page), MIN_READING, `${what}: the conversation`)
    await expect(main(page)).not.toHaveAttribute('data-right-panel-overlay', '')
    if (column) await expect(page.locator('[data-narrow]'), `${what}: nothing flipped under the pointer`).toHaveCount(0)

    // The floor is the panel's own minimum, wherever the pointer goes.
    await dragSeamTo(page, width)
    await widthRestsAt(rightPanel(page), 280, `${what}: the floor`)
  }
})

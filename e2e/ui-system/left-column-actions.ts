import { expect, type Page } from '@playwright/test'

/** Usage is an independent menu level, so account choices never displace its facts. */
export const openAccountUsage = async (page: Page) => {
  const root = page.locator('[data-slot="popover-popup"]:visible')
  const trigger = root.getByRole('menuitem', { name: /^Usage/ })
  await page.evaluate(async () => { await document.fonts.ready })
  const before = (await root.boundingBox())!
  await trigger.focus()
  await page.keyboard.press('ArrowRight')
  const usage = page.locator('[data-slot="dropdown-menu-sub-content"]:visible')
  await expect(usage).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const after = (await root.boundingBox())!
  expect(after.width, 'usage facts must not widen their parent menu').toBe(before.width)
  expect(after.height, 'usage facts must not grow their parent menu').toBe(before.height)
  return usage
}

/** Left-column probes use the current shell and popup APIs until B/C land. */
export const applyLeftColumnActions = async (page: Page, actions: {
  readonly leftWidth?: number
  readonly leftOpen?: boolean
  readonly leftPopup?: string
  readonly leftHeading?: 'hover-open' | 'folded'
}) => {
  if (!actions.leftOpen && actions.leftWidth === undefined) return
  const column = page.locator('[data-left-column]:visible')
  if (!await column.count() && await page.getByRole('button', { name: 'Return to main', exact: true }).count()) await page.getByRole('button', { name: 'Return to main', exact: true }).click()
  if (!await column.count()) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await expect(column).toHaveCount(1)
  if (actions.leftWidth !== undefined) {
    await page.evaluate(width => {
      (window as Window & { __hdFrameWall: { resizeLeft: (width: number) => void } }).__hdFrameWall.resizeLeft(width)
    }, actions.leftWidth)
  }
  if (actions.leftPopup === 'inbox') await column.locator('[data-slot="inbox-button"]').locator('..').click()
  if (actions.leftPopup === 'account' || actions.leftPopup === 'usage') await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
  if (actions.leftPopup === 'usage') await openAccountUsage(page)
  if (actions.leftPopup === 'start') await column.getByRole('button', { name: 'More ways to start', exact: true }).click()
  if (actions.leftPopup === 'project') {
    await column.locator('[data-project-root] button[data-draggable]').first().focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu')).toBeVisible()
  }
  if (actions.leftPopup === 'session') {
    await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().focus()
    await page.keyboard.press('ContextMenu')
    await expect(page.getByRole('menu')).toBeVisible()
  }
  if (actions.leftPopup === 'card') {
    const trigger = column.locator('[data-region="session-row"] [data-slot="hover-card-trigger"]').first()
    // Real App can publish a later rail layout after the initial hover.
    // Follow only a moved target; its unchanged hover delay still applies.
    let target = await trigger.boundingBox()
    await trigger.hover()
    await expect.poll(async () => {
      const current = await trigger.boundingBox()
      if (current && target && (current.x !== target.x || current.y !== target.y)) {
        await trigger.hover()
        target = current
      }
      return page.locator('[data-slot="hover-card-content"]:visible').isVisible()
    }).toBe(true)
    await expect(page.locator('[data-slot="hover-card-content"]:visible')).toBeVisible()
  }
  if (actions.leftPopup && ['inbox', 'account', 'start'].includes(actions.leftPopup)) await expect(page.locator('[data-slot="popover-popup"]:visible')).toBeVisible()
  if (actions.leftHeading) {
    const heading = column.locator('[data-project-root] button[data-draggable]').first()
    const expanded = actions.leftHeading === 'hover-open'
    if ((await heading.getAttribute('aria-expanded') === 'true') !== expanded) await heading.click()
    await expect(heading).toHaveAttribute('aria-expanded', String(expanded))
    if (expanded) {
      await heading.hover()
      const chevron = heading.locator('[data-slot="disclosure-chevron"]')
      // The floating rail can finish moving the heading after hover scrolls it
      // into view. Keep the pointer on its current box until the hover-owned
      // disclosure is actually painted.
      await expect.poll(async () => {
        const box = await heading.boundingBox()
        if (!box) return false
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        return chevron.evaluate(node => getComputedStyle(node).visibility === 'visible')
      }).toBe(true)
    }
    else {
      await heading.evaluate(node => (node as HTMLElement).blur())
      await page.mouse.move(page.viewportSize()!.width - 1, 899)
    }
    await expect(heading.locator('[data-slot="disclosure-chevron"]')).toBeVisible()
  }
}

/** Exercise the actual controlled Settings search in its visual wall. */
export const applySettingsNavigationActions = async (page: Page, actions: {
  readonly settingsQuery?: string
  readonly query?: string
}) => {
  if (actions.settingsQuery !== undefined) {
    await page.locator('[data-left-settings]').getByRole('searchbox', { name: 'Search settings' }).fill(actions.settingsQuery)
  }
}

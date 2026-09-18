import { expect, test, type Locator, type Page } from '@playwright/test'

import { level, modelControl, reasoningRow } from './reasoning-menu'

/*
  Tab and Shift+Tab leave a menu and close every level of it (WAI-ARIA APG,
  menu pattern). A Popover's menu stands in the tab order where Base UI puts
  the Popover — just after its trigger — so Tab moves on to whatever follows
  the trigger, and Shift+Tab comes back to the trigger itself.

  Every menu level here is a Base UI Menu.Root with no Menu.Trigger: its
  Popover opens it. Base UI's way out of a menu on Tab is the focus guard
  after it, which sends the focus on to the menu's trigger — and with none to
  send it to, the focus stayed on the guard, an invisible span, with the menu
  still open. Shift+Tab, which Base UI answers by closing the menu for its
  trigger, did nothing at all.
*/

const onFocusGuard = (page: Page) =>
  page.evaluate(() => document.activeElement?.hasAttribute('data-base-ui-focus-guard') ?? false)

/** The element Tab reaches from `from` while nothing is open — marked, so it can be found again. */
async function stopAfter(page: Page, from: Locator): Promise<Locator> {
  await from.focus()
  await page.keyboard.press('Tab')
  const found = await page.evaluate(() => {
    const next = document.activeElement
    if (!(next instanceof HTMLElement) || next === document.body) return false
    next.dataset.nextStop = ''
    return true
  })
  expect(found).toBe(true)
  return page.locator('[data-next-stop]')
}

async function openModelMenu(page: Page) {
  const trigger = modelControl(page)
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(reasoningRow(page)).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menu').getByRole('menuitemradio').first()).toBeFocused()
}

async function stepToReasoning(page: Page) {
  for (let step = 0; step < 12; step += 1) {
    if (await reasoningRow(page).evaluate((node) => node === document.activeElement)) return
    await page.keyboard.press('ArrowDown')
  }
  await expect(reasoningRow(page)).toBeFocused()
}

test.describe('a Popover’s menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 })
    await page.goto('/preview.html')
    const trigger = modelControl(page)
    await trigger.scrollIntoViewIfNeeded()
    await trigger.evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().bottom - (window.innerHeight - 24)))
  })

  test('Tab from a row closes it and moves on to what follows its trigger', async ({ page }) => {
    const next = await stopAfter(page, modelControl(page))
    await openModelMenu(page)

    await page.keyboard.press('Tab')
    expect(await onFocusGuard(page)).toBe(false)
    await expect(next).toBeFocused()
    await expect(modelControl(page)).not.toHaveAttribute('data-open', '')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('Tab from inside a flyout closes both levels and moves on the same way', async ({ page }) => {
    const next = await stopAfter(page, modelControl(page))
    await openModelMenu(page)
    await stepToReasoning(page)
    await page.keyboard.press('ArrowRight')
    await expect(level(page, /^Low/)).toBeFocused()

    await page.keyboard.press('Tab')
    expect(await onFocusGuard(page)).toBe(false)
    await expect(next).toBeFocused()
    await expect(modelControl(page)).not.toHaveAttribute('data-open', '')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('Shift+Tab from a row closes it and gives its trigger the focus', async ({ page }) => {
    await openModelMenu(page)

    await page.keyboard.press('Shift+Tab')
    expect(await onFocusGuard(page)).toBe(false)
    await expect(modelControl(page)).toBeFocused()
    await expect(modelControl(page)).not.toHaveAttribute('data-open', '')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('Tab walks a panel’s own buttons first, and past the last one leaves the same way', async ({ page }) => {
    // The plan meters' "other agents" menu holds plain buttons, not rows, and
    // Tab is how the keyboard gets from one to the next.
    const trigger = page.locator('[data-slot="popover-trigger"][title*="other agents"]')
    await trigger.scrollIntoViewIfNeeded()
    const next = await stopAfter(page, trigger)
    await trigger.focus()
    await page.keyboard.press('Enter')
    const buttons = page.getByRole('menu').getByRole('button')
    const count = await buttons.count()
    expect(count).toBeGreaterThan(1)
    for (let index = 0; index < count; index += 1) {
      await expect(buttons.nth(index)).toBeFocused()
      await page.keyboard.press('Tab')
    }
    expect(await onFocusGuard(page)).toBe(false)
    await expect(next).toBeFocused()
    await expect(trigger).not.toHaveAttribute('data-open', '')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('with nothing after its trigger, Tab still closes it and leaves the focus on the page', async ({ page }) => {
    // Nothing tabbable follows the model control. Base UI leaves a Popover by
    // wrapping round in that case, and that is its rule; what this holds is
    // that the focus is not left on a guard, nor in the menu that is going.
    await modelControl(page).evaluate((trigger) => {
      for (const stop of document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')) {
        if (trigger.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) stop.tabIndex = -1
      }
    })
    await openModelMenu(page)

    await page.keyboard.press('Tab')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(modelControl(page)).not.toHaveAttribute('data-open', '')
    expect(await onFocusGuard(page)).toBe(false)
    expect(
      await page.evaluate(() => {
        const held = document.activeElement
        return (
          held === document.body ||
          (held instanceof HTMLElement && held.isConnected && !held.closest('[data-base-ui-portal],[role="menu"]'))
        )
      }),
    ).toBe(true)
  })
})

test.describe('a context menu', () => {
  // A context menu opens at a point, not from a place in the tab order, so
  // leaving it goes back to where the focus was. Before, Tab stopped on the
  // guard after it; Shift+Tab and Escape dropped the focus on the page.
  const sessionRow = (page: Page) =>
    page.locator('[class*="sidebar_"]').getByRole('button', { name: /^Duplicate Codex accounts/ })

  test('Tab, Shift+Tab and Escape each close it and give the focus back to its row', async ({ page }) => {
    await page.goto('/preview.html')
    const session = sessionRow(page)
    await session.scrollIntoViewIfNeeded()
    for (const key of ['Tab', 'Shift+Tab', 'Escape']) {
      await session.focus()
      await page.keyboard.press('ContextMenu')
      await expect(page.getByRole('menuitem', { name: 'Pin' })).toBeFocused()

      await page.keyboard.press(key)
      expect(await onFocusGuard(page)).toBe(false)
      await expect(session).toBeFocused()
      await expect(page.getByRole('menu')).toHaveCount(0)
    }
  })

  test('opened with the pointer, it gives the focus back the same way', async ({ page }) => {
    // The press that opens it has already put the focus on the row.
    await page.goto('/preview.html')
    const session = sessionRow(page)
    await session.scrollIntoViewIfNeeded()
    for (const key of ['Tab', 'Shift+Tab', 'Escape']) {
      await session.click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: 'Pin' })).toBeFocused()

      await page.keyboard.press(key)
      expect(await onFocusGuard(page)).toBe(false)
      await expect(session).toBeFocused()
      await expect(page.getByRole('menu')).toHaveCount(0)
    }
  })
})

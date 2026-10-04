import { expect, test } from '@playwright/test'

test('the sidebar list is one keyboard stop with row navigation and row menus', async ({ page }) => {
  await page.goto('/preview.html')
  const tree = page.locator('[data-region="session-tree"]')
  const rows = tree.locator('[data-slot="sidebar-menu-button"]')
  await expect(rows.first()).toBeVisible()
  await expect.poll(() => rows.evaluateAll((entries) => entries.filter((entry) => (entry as HTMLElement).tabIndex === 0).length)).toBe(1)
  await expect(tree.locator('[data-slot="sidebar-menu-action"][tabindex="0"]')).toHaveCount(0)

  const first = rows.first()
  await first.focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(first).toBeFocused()
  await page.keyboard.press('End')
  await expect(rows.last()).toBeFocused()

  const group = tree.locator('[data-slot="sidebar-menu-button"][aria-expanded]').first()
  await group.focus()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  const groupIndex = await group.evaluate((item) =>
    [...item.closest('[data-region="session-tree"]')!.querySelectorAll('[data-slot="sidebar-menu-button"]')].indexOf(item),
  )
  const child = rows.nth(groupIndex + 1)
  await page.keyboard.press('ArrowRight')
  await expect(child).toBeFocused()

  // A loose conversation is a direct project child, outside any Team's list.
  const session = tree.locator('[data-virtual-project] > [data-region="session-row"] [data-slot="sidebar-menu-button"]').first()
  const project = session.locator('xpath=ancestor::*[@data-project-root]')
  const parent = project.locator('[data-slot="sidebar-menu-button"][data-draggable][aria-expanded]')
  await expect(parent).toHaveCount(1)
  await expect(parent).toHaveAttribute('aria-expanded', 'true')
  await session.focus()
  await expect(session).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(parent).toBeFocused()

  await session.focus()
  await page.keyboard.press('ContextMenu')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(session).toBeFocused()

  await session.focus()
  await page.keyboard.press('Tab')
  await expect.poll(() => tree.evaluate((node) => node.contains(document.activeElement))).toBe(false)
})

test('ArrowLeft from a nested Seat focuses its owning Team', async ({ page }) => {
  await page.goto('/preview.html')
  const tree = page.locator('[data-region="session-tree"]')
  const disclosure = tree.getByRole('button', { name: /^Show the agents in / }).first()
  // Teams start folded; expand through the real control before testing Seats.
  await disclosure.evaluate(node => (node as HTMLButtonElement).click())
  const seat = tree.locator('[data-nested="true"] [data-region="session-row"] [data-slot="sidebar-menu-button"]').first()
  await expect(seat).toBeVisible()

  // The nested list belongs to the Team row; neither row order nor the
  // project's expanded state identifies this Seat's parent.
  const teamRow = seat.locator('xpath=ancestor::ul[@data-nested="true"]/..')
  const opener = teamRow.locator(':scope > div > [data-slot="sidebar-menu-button"]')
  await expect(opener).toHaveCount(1)
  const name = await opener.getAttribute('aria-label')
  expect(name).toMatch(/^Room /)
  // ArrowLeft folds the Seat's list, so keep the parent's exact name rather
  // than resolving it through a child that is about to be unmounted.
  const parent = tree.getByRole('button', { name: name!, exact: true })
  await expect(parent).toHaveCount(1)
  await parent.focus()
  await page.keyboard.press('ArrowRight')
  await expect(seat).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(parent).toBeFocused()
})

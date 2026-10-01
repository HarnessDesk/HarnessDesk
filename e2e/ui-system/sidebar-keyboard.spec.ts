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

  const session = tree.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first()
  const parent = await session.evaluate((item) => {
    const rows = [...item.closest('[data-region="session-tree"]')!.querySelectorAll<HTMLElement>('[data-slot="sidebar-menu-button"]')]
    const before = rows.slice(0, rows.indexOf(item as HTMLElement)).reverse()
    return before.find((row) => row.getAttribute('aria-expanded') === 'true')?.textContent?.trim()
  })
  expect(parent).toBeTruthy()
  await session.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tree.locator('[data-slot="sidebar-menu-button"]').filter({ hasText: parent! }).first()).toBeFocused()

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

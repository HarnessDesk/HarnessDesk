import { expect, test } from '@playwright/test'

test('the sidebar list is one keyboard stop with row navigation and row menus', async ({ page }) => {
  await page.goto('/preview.html')
  const tree = page.locator('[data-region="session-tree"]')
  const rows = tree.locator('[data-slot="sidebar-menu-button"]')
  await expect(rows.first()).toBeVisible()
  await expect.poll(() => rows.evaluateAll((entries) => entries.filter((entry) => (entry as HTMLElement).tabIndex === 0).length)).toBe(1)
  await expect(tree.locator('[data-slot="sidebar-menu-action"][aria-label^="Actions for"][tabindex="0"]')).toHaveCount(0)

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

test('a Team is one keyboard row whose parent is its project', async ({ page }) => {
  await page.goto('/preview.html?sidebar-structure')
  const tree = page.locator('#sidebar-structure [data-region="session-tree"]')
  const team = tree.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
  await team.focus()
  await page.keyboard.press('ArrowRight')
  await expect(team).toBeFocused()
  await expect(tree.locator('[data-nested="true"]')).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await expect(tree.locator('[data-project-root="/work/atlas"] button[data-draggable]')).toBeFocused()
})

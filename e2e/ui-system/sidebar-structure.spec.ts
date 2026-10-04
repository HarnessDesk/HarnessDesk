import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`project / Team / Seat hierarchy and row states — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?sidebar-structure')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const tree = fixture.locator('[data-region="session-tree"]')
    await expect(tree.locator('[data-project-root]')).toHaveCount(3)
    await expect(tree.locator('[data-tone="waiting"], [data-tone="working"]')).toHaveCount(0)
    await expect(tree.locator('[data-sidebar-band="pinned"]')).toContainText('Pinned plan')
    const team = tree.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await expect(team).toContainText('Needs you')
    await expect(tree.getByRole('button', { name: 'Show the agents in Ship checkout retry' })).toHaveAttribute('aria-expanded', 'false')
    await expect(tree.locator('[data-nested="true"]')).toHaveCount(0)
    const project = team.locator('xpath=ancestor::*[@data-project-root]')
    const projectHead = project.locator('[data-draggable]')
    const position = (row: typeof team) => row.locator('[data-slot="sidebar-menu-icon"]').evaluate(node => node.getBoundingClientRect().x)
    expect(await position(team)).toBeGreaterThan(await position(projectHead))

    await team.focus()
    await page.keyboard.press('ArrowRight')
    const seats = team.locator('xpath=ancestor::li').locator('[data-nested="true"] [data-region="session-row"]')
    await expect(seats).toHaveCount(3)
    const writer = seats.first().locator('[data-slot="sidebar-menu-button"]')
    await expect(writer).toBeFocused()
    expect(await position(writer)).toBeGreaterThan(await position(team))
    await expect(seats.nth(1).locator('[data-slot="sidebar-menu-state"]')).toHaveAttribute('aria-label', 'Needs you')
    const busy = project.locator('[data-region="session-row"]').filter({ hasText: 'Check build' })
    await expect(busy.locator('[data-slot="dot"]')).toBeVisible()

    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.locator('body').click({ position: { x: 1000, y: 1 } })
      const state = team.locator('[data-sidebar-menu-state-full]')
      await expect(state).toBeVisible()
      const box = await state.boundingBox()
      const row = await team.boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(row!.x + row!.width)
      expect(await fixture.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await writer.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(team).toBeFocused()
    await expect(seats).toHaveCount(0)
  })
}

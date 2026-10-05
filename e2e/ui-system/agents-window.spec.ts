import { expect, test } from '@playwright/test'

test('the sidebar and Agents window mark agents and align names with their section', async ({ page }) => {
  await page.goto('/preview.html')

  const sidebarAgents = page.locator('[data-frame-id="sidebar-column"]').getByRole('button', { name: 'Agents', exact: true })
  await expect(sidebarAgents.locator('[data-slot="sidebar-menu-icon"] svg')).toHaveClass(/lucide-bot/)

  const frame = page.locator('[data-frame-id="agents-roster"]')
  await expect(frame).toBeVisible()

  const allAgents = frame.getByRole('button', { name: 'All Agents' })
  await expect(allAgents.locator('[data-slot="sidebar-menu-icon"] svg')).toHaveClass(/lucide-bot/)

  const nav = frame.getByRole('navigation', { name: 'Window navigation' })
  const builtIn = nav.locator('[data-slot="sidebar-group"]').filter({ hasText: 'Built in' })
  const agent = builtIn.getByRole('button', { name: 'Implementer' })
  await expect(agent.locator('[data-slot="sidebar-menu-icon"]')).toHaveCount(0)

  const textStart = async (locator: typeof builtIn) =>
    locator.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect().x
    })
  const heading = await textStart(builtIn.locator(':scope > [data-slot="group-label"]'))
  const label = await textStart(agent.locator('[data-slot="sidebar-menu-label"]'))
  expect(Math.abs(label - heading)).toBeLessThan(1)
})

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

for (const theme of ['light', 'dark'] as const) {
  test(`icon meanings stay distinct in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?icon-followups')
    const settings = page.locator('[data-frame-id="icon-settings"]')
    await expect(settings.getByRole('button', { name: /^Runtimes/ }).locator('svg')).toHaveClass(/lucide-server/)
    await settings.getByRole('button', { name: /^Alpha/ }).first().click()
    const alice = settings.getByRole('button', { name: /^alice/ })
    const amy = settings.getByRole('button', { name: /^amy/ })
    await expect(alice.locator('[data-slot="face-badge"]')).toHaveText('AL')
    await expect(amy.locator('[data-slot="face-badge"]')).toHaveText('AM')
    const subagents = page.locator('[data-frame-id="icon-subagents"]')
    await expect(subagents.locator('[data-slot="face-badge"]')).toHaveCount(3)
    await expect(subagents.locator('svg.lucide-bot')).toHaveCount(3)
    await expect(subagents.locator('[data-slot="face-badge"]').first()).toHaveText('↳')
    await expect(subagents.locator('[data-slot="icon-tile"]').first()).toHaveAttribute('title', /Sub-agent of/)
    const select = page.locator('[data-frame-id="icon-select"]')
    await select.getByRole('combobox').click()
    const up = page.locator('[data-slot="select-scroll-up-button"]')
    const down = page.locator('[data-slot="select-scroll-down-button"]')
    await expect(up).toBeVisible()
    await expect(down).toBeVisible()
    await expect(up.locator('svg')).toHaveClass(/lucide-chevron-down rotate-180/)
    await expect(down.locator('svg')).toHaveClass(/lucide-chevron-down/)
  })
}

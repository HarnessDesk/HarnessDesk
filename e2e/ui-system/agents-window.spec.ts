import { expect, test } from '@playwright/test'

test('the sidebar and Agents window mark agents and align names with their section', async ({ page }) => {
  await page.goto('/preview.html')

  const sidebarAgents = page.locator('[data-frame-id="sidebar-column"]').getByRole('button', { name: 'Agents', exact: true })
  await expect(sidebarAgents.locator('[data-slot="sidebar-menu-icon"] svg')).toHaveClass(/lucide-bot/)

  const frame = page.locator('[data-frame-id="agents-roster"]')
  await expect(frame).toBeVisible()

  await expect(frame.locator('[data-topbar-title]')).toHaveCount(0)
  await expect(frame.getByRole('heading', { name: 'Agents', level: 1, exact: true })).toBeVisible()
  await expect(frame.getByRole('navigation', { name: 'Window navigation' })).toHaveCount(0)
  const builtIn = frame.getByRole('region', { name: 'Built in', exact: true })
  const agent = builtIn.getByRole('button', { name: /Implementer/ }).first()
  await expect(agent.locator('[data-slot="sidebar-menu-icon"]')).toHaveCount(0)
  await expect(agent.locator('[data-slot="agent-card-face"]')).toBeVisible()
  const edges = await builtIn.evaluate(section => {
    const title = section.querySelector('[data-section-name]')!
    const cards = [...section.querySelectorAll('[data-slot="agent-card"]')]
    return { heading: title.getBoundingClientRect().left, page: section.getBoundingClientRect().left,
      labels: cards.map(card => card.querySelector('[data-slot="agent-card-title"]')!.getBoundingClientRect().left - card.getBoundingClientRect().left),
      faces: cards.map(card => card.querySelector('[data-slot="agent-card-face"]')!.getBoundingClientRect().left - card.getBoundingClientRect().left) }
  })
  expect(Math.abs(edges.heading - edges.page)).toBeLessThan(1)
  expect(edges.labels.length).toBeGreaterThan(0)
  for (const label of edges.labels) expect(Math.abs(label - edges.labels[0]!)).toBeLessThan(1)
  for (const face of edges.faces) expect(Math.abs(face - edges.faces[0]!)).toBeLessThan(1)

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

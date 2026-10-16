import { test, expect } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) test(`one Permissions slot and separate collaboration — ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.setViewportSize({ width: 1600, height: 1200 })
  await page.goto('/preview.html?composer-slots')
  const fixture = page.locator('[data-composer-permissions]')
  await expect(fixture).toBeVisible()
  for (const name of ['Codex', 'Claude Code', 'Cursor']) {
    const composer = fixture.locator(`[data-permissions-agent="${name}"]`)
    // ResizeObserver folds the toolbar after its content has been measured.
    await expect(async () => {
      const bounds = await fixture.boundingBox()
      expect(bounds).not.toBeNull()
      for (const element of [composer, composer.locator('[data-composer-track="model"]'), composer.getByRole('button', { name: 'Send', exact: true })]) {
        const box = await element.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x)
        expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
      }
    }).toPass()
    await expect(composer.locator('[data-composer-track="permissions"]')).toHaveCount(1)
    await expect(composer.locator('[title="This agent has no permission setting"]')).toHaveCount(0)
    await expect(composer.locator('[data-composer-track="mode"]')).toHaveCount(name === 'Cursor' ? 0 : 1)
    const model = composer.locator('[data-composer-track="model"] [data-slot="text"]')
    await expect(model.first()).toBeVisible()
    expect(await model.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true)
  }
  const mixed = fixture.locator('[data-permissions-agent="Claude Code"]')
  await mixed.getByRole('button', { name: 'Permissions — Accept edits' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Plan', exact: true })).toHaveCount(0)
  await page.getByRole('menuitemradio', { name: 'Manual', exact: true }).click()
  await expect(mixed.getByRole('button', { name: 'Permissions — Manual' })).toContainText('Manual')
  await mixed.getByRole('button', { name: 'Collaboration mode — Act' }).click()
  await page.getByRole('menuitemradio', { name: 'Plan', exact: true }).click()
  await expect(mixed.getByRole('button', { name: 'Collaboration mode — Plan' })).toContainText('Plan')
  await mixed.getByRole('button', { name: 'Permissions — Manual' }).click()
  await expect(page.getByText('plan — Unavailable', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: 'Manual', exact: true })).toBeChecked()
})

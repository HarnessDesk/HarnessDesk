import { expect, test } from '@playwright/test'

test('a narrow pane replaces main and its return control restores Chat and the bar', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 })
  await page.goto('/narrow-overlay.html')
  const main = page.locator('[data-frame-region="main"]')
  const panel = page.locator('[data-frame-region="right"]')
  const composer = page.locator('[data-pane-id] textarea').first()
  await expect(panel).toBeVisible()
  await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-panel-floats', 'true')
  await expect(main).toHaveAttribute('inert', '')
  await expect(main).toBeHidden()
  const box = (await panel.boundingBox())!
  expect(box).toMatchObject({ x: 0, y: 0, width: 720, height: 900 })
  await page.getByRole('button', { name: 'Return to main', exact: true }).click()
  await expect(panel).toBeHidden()
  await expect(main).not.toHaveAttribute('inert', '')
  await composer.click()
  await expect(composer).toBeFocused()

  const show = page.getByRole('button', { name: 'Show sidebar', exact: true })
  await show.click()
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeVisible()
  expect(await page.locator('[data-slot="workbench-main"]').evaluate(node => node.closest('[inert]') !== null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toHaveCount(0)
  await expect(show).toBeFocused()
  await expect(main).not.toHaveAttribute('inert', '')
})

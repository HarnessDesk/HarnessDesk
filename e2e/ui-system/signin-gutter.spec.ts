import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`the sign-in roster keeps the rail gutter in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/preview.html')
    await page.getByLabel('theme').first().selectOption(theme)
    await page.getByLabel('dialog').selectOption('sign in')
    await page.evaluate(async () => { await document.fonts.ready })
    const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true })
    await expect(dialog).toBeVisible()
    const edges = await dialog.locator('[data-slot="sign-in-list"]').evaluate(list => {
      const rail = list.closest('nav')!
      const head = list.querySelector('[data-section-head], [data-slot="fieldset-legend"]')!
      return {
        inset: Number.parseFloat(getComputedStyle(rail).getPropertyValue('--hd-rail-inset')),
        left: head.getBoundingClientRect().left - rail.getBoundingClientRect().left,
        right: rail.getBoundingClientRect().right - head.getBoundingClientRect().right,
      }
    })
    if (process.env.SIGNIN_FRAME_DIR) await dialog.screenshot({ path: `${process.env.SIGNIN_FRAME_DIR}/roster-${theme}.png` })
    expect(edges.left).toBeGreaterThanOrEqual(edges.inset)
    expect(edges.right).toBeGreaterThanOrEqual(edges.inset)
  })
}

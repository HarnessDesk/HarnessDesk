import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) test(`Dashboard measure stays visibly selected in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
  await page.evaluate(async () => {
    const { mountDashboardD10 } = await import('/src/preview/dashboard-d10-fixture.tsx' as string)
    const container = document.createElement('div')
    container.id = 'root'
    document.body.replaceChildren(container)
    mountDashboardD10(container)
  })
  const overview = page.locator('[aria-label="What it cost, in brief"]')
  const measures = overview.getByRole('button', { pressed: false })
  const selected = overview.getByRole('button', { pressed: true })
  await expect(selected).toContainText('Usage cost')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: `/tmp/dashboard-d10/selection-${process.env.D10_SELECTION_FRAME ?? 'after'}-${theme}.png` })

  for (const label of ['Usage cost', 'Turns', 'Tokens', 'Usage cost']) {
    const measure = overview.getByRole('button', { name: new RegExp(`^${label}`) })
    await measure.click()
    await page.mouse.move(0, 0)
    await expect(selected).toHaveCount(1)
    await expect(measure).toHaveAttribute('aria-pressed', 'true')
    await expect(selected.getByText('Selected', { exact: true })).toHaveCount(0)
    // Read the actual rendered state after hover ends, rather than testing
    // only ARIA or a class name that might have no matching CSS.
    await expect.poll(async () => {
      const chosenFill = await selected.evaluate(button => getComputedStyle(button).backgroundColor)
      const idleFill = await measures.first().evaluate(button => getComputedStyle(button).backgroundColor)
      return chosenFill !== 'rgba(0, 0, 0, 0)' && chosenFill !== idleFill
    }, { message: `${label} keeps a visible fill after the pointer leaves` }).toBe(true)
  }
})

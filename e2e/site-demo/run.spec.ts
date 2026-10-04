import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 390]) {
  test(`Overview, person answer and Run Flow in ${theme} at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/?view=flow&stage=you&theme=${theme}`)
    await expect(page.getByText('The numbers are staged; the surface is not.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeVisible()
    await expect(page.getByText('Posted to #42', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Merged', exact: true }).click()
    await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'done')
    await expect(page.getByRole('button', { name: 'Merged', exact: true })).toHaveCount(0)
    // The Run link on the Overview works without the rail at narrow widths.
    await page.getByRole('button', { name: 'Write, review, land', exact: true }).click()
    for (const round of [3, 6]) await expect(page.locator(`[data-kind="card"][data-row^="card-${round}-"]`).filter({ hasText: 'Posted to #42' })).toHaveCount(2)
    await page.getByRole('radio', { name: 'Flow', exact: true }).click()
    await expect(page.locator('[data-slot="flow-graph"]')).toBeVisible()
    await expect(page.locator('[data-step-row="you"]')).toContainText('Done')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
  test(`poster in ${theme} at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 720 })
    await page.goto(`/?view=poster&theme=${theme}`)
    await expect(page.locator('[data-slot="run-time-bar"]')).toBeVisible()
    expect(await page.locator('[data-slot="run-time-bar"] [data-ms]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-ms'))))).toEqual([660000, 180000, 360000, 120000])
    if (width === 390) await expect(page.locator('[data-step-row="fix"]')).toContainText('Working')
    else await expect(page.locator('[data-slot="flow-step"][data-step="fix"]')).toHaveAttribute('data-state', 'working')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('body').evaluate(body => body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
    expect(errors).toEqual([])
  })
}

test('reduced motion waits for Next step; the posted review survives the fix loop', async ({ page }) => {
  await page.goto('/?view=flow')
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'write')
  await page.waitForTimeout(3800)
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'write')
  for (const stage of ['check', 'changes', 'fix', 'check-again', 'approve', 'land', 'you']) {
    await page.getByRole('button', { name: 'Next step', exact: true }).click()
    await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', stage)
  }
  await expect(page.getByText('Posted to #42', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeVisible()
})

test('the poster keeps its text alternative between the page and graph breakpoints', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 })
  await page.goto('/?view=poster&theme=light')
  await expect(page.locator('[data-step-row="fix"]')).toBeVisible()
})

test('the embedding page can change either scene’s theme', async ({ page }) => {
  for (const view of ['flow', 'poster']) {
    await page.goto(`/?view=${view}&theme=light`)
    await expect(page.locator('[data-slot="site-run-demo"]')).toBeVisible()
    await page.evaluate(() => window.postMessage({ hdTheme: 'dark' }, '*'))
    await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    await page.evaluate(() => window.postMessage({ hdTheme: 'light' }, '*'))
    await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme')
  }
})

test('visible playback advances and can be paused and resumed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/?view=flow')
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click()
  await page.waitForTimeout(3800)
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check')
  await page.getByRole('button', { name: 'Play demo', exact: true }).click()
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'changes', { timeout: 10_000 })
})

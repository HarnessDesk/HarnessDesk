import { expect, test } from '@playwright/test'
import { selectRunView } from './run-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`publication words and the read-only recovery action in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?review-publication&publication-scene=kept&theme=${theme}`)
    const run = page.locator('#review-publication-kept')
    await selectRunView(run, 'Timeline')
    await expect(run.locator('[data-row="card-3-3"]')).toContainText('Judge')
    await expect(run.locator('[data-row="card-3-3"]')).toContainText('This desk only')
    await expect(page.locator('#review-publication-overview')).toContainText('This desk only')

    await page.goto(`/preview.html?findings=rail&theme=${theme}`)
    const finding = page.getByRole('button', { name: /finding-not-kept-1/ })
    await expect(finding).toContainText('Not published')
    await expect(finding).toContainText('Open')
    await finding.click()
    await expect(page.getByRole('dialog')).toContainText('Not published')

    await page.goto(`/preview.html?team-start=comparison&unheld-read&theme=${theme}`)
    const judge = page.getByRole('combobox', { name: 'Runtime for Judge', exact: true })
    await expect(judge.locator('option:checked')).toHaveText('You')
    await judge.selectOption('windsurf')
    await expect(page.getByRole('dialog')).toContainText('Runtime 3 can be asked to stay read-only here but cannot be held to it. Choose another agent, or start from /race.')
    await page.getByRole('button', { name: 'Use Runtime 1', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Runtime for Judge', exact: true })).toHaveValue('codex')
    await expect(page.getByRole('dialog')).not.toContainText('cannot be held to it')
    await expect(page.getByRole('button', { name: 'Use Runtime 1', exact: true })).toHaveCount(0)
  })
}

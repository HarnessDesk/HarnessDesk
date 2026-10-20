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
    const dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
    const details = dialog.getByRole('button', { name: 'Details', exact: true })
    await expect(details).toHaveAttribute('aria-expanded', 'false')
    await details.click()
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    const configure = page.getByRole('button', { name: 'Configure Judge', exact: true })
    await expect(configure).toHaveText('You')
    await configure.click()
    const judge = page.getByRole('button', { name: 'Runtime for Judge', exact: true })
    await expect(judge).toHaveText('You')
    await judge.click()
    await page.getByRole('menuitemradio', { name: 'Runtime 3', exact: true }).click()
    await expect(configure).toContainText('Runtime 3')
    // Enabling Judge moves its control into the graph and closes the old
    // popover. Escape here would dismiss the New Team form itself.
    await expect(judge).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText('Runtime 3 can be asked to stay read-only here but cannot be held to it. Choose another runtime, or start from /race.')
    await page.getByRole('button', { name: 'Use Runtime 1', exact: true }).click()
    await expect(configure).toContainText('Runtime 1')
    await expect(page.getByRole('dialog')).not.toContainText('cannot be held to it')
    await expect(page.getByRole('button', { name: 'Use Runtime 1', exact: true })).toHaveCount(0)
  })
}

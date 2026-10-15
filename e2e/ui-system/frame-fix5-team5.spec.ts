import { expect, test } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const theme of ['light', 'dark'] as const) {
  test(`member Chat returns to the Team tab it came from in ${theme}`, async ({ page }) => {
    await installFramePreviewFixture(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=member-chat&theme=${theme}`)

    const overview = page.getByRole('tab', { name: 'Overview 1' })
    const back = page.getByRole('button', { name: 'Back', exact: true })
    await overview.click()
    await page.getByRole('button', { name: 'Open Beta' }).click()
    await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('The request helper makes one attempt. I am tracing where transient failures are returned.')).toBeVisible()
    await expect(back).toBeEnabled()

    await back.click()
    await expect(overview).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'Open Beta' })).toBeVisible()
  })

  test(`Team start names the automatic role result in ${theme}`, async ({ page }) => {
    await installFramePreviewFixture(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-start=fix-and-review&theme=${theme}`)

    const writes = page.getByRole('combobox', { name: 'Agent for Writes' })
    const reviews = page.getByRole('combobox', { name: 'Agent for Reviews' })
    await expect(writes).toHaveValue('')
    await expect(writes.locator('option:checked')).toHaveText('Automatic · Nothing can run')
    await expect(reviews).toHaveValue('')
    await expect(reviews.locator('option:checked')).toHaveText('Automatic · Nothing can run')
    const roles = page.getByRole('region', { name: 'Who does what' })
    await expect(roles.getByText('Runtime 2 is not added to HarnessDesk', { exact: true })).toBeVisible()
    await expect(roles.getByText('Runtime 3 is signed out', { exact: true })).toBeVisible()
  })

  test(`Team board keeps empty columns full width and scrolls at 1280 in ${theme}`, async ({ page }) => {
    await installFramePreviewFixture(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=board&theme=${theme}`)
    const board = page.locator('[data-slot="board"]')
    await expect(board).toBeVisible()

    const geometry = await board.evaluate(element => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      columns: [...element.querySelectorAll<HTMLElement>('[data-slot="board-column"]')].map(column => ({
        id: column.dataset.column,
        width: column.getBoundingClientRect().width,
        collapsed: column.hasAttribute('data-collapsed'),
      })),
    }))
    expect(geometry.columns.find(column => column.id === 'todo')?.collapsed).toBe(false)
    expect(geometry.columns.find(column => column.id === 'ready')?.collapsed).toBe(false)
    expect(geometry.columns.find(column => column.id === 'todo')?.width).toBeGreaterThanOrEqual(220)
    expect(geometry.columns.find(column => column.id === 'ready')?.width).toBeGreaterThanOrEqual(220)
    expect(geometry.columns.every(column => column.width >= 220 && !column.collapsed)).toBe(true)
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.width)
  })

  test(`Team Findings uses one empty state in ${theme}`, async ({ page }) => {
    await installFramePreviewFixture(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=empty-findings&theme=${theme}`)
    const findings = page.getByRole('region', { name: 'Findings' })
    await expect(findings.getByText('No findings recorded', { exact: true })).toBeVisible()
    await expect(findings.locator('[aria-label="Findings summary"]')).toHaveCount(0)
    await expect(findings.locator('[aria-label="This round"]')).toHaveCount(0)
    await expect(findings.getByText(/Local findings/)).toHaveCount(0)
    await expect(findings.getByText(/^(Open|Blocking|All|Open findings)\s+0$/)).toHaveCount(0)
  })
}

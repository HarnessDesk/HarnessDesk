import { teamSeats } from './team-frame-actions'
import { expect, test } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const theme of ['light', 'dark'] as const) {
  test(`member Chat returns to the Team tab it came from in ${theme}`, async ({ page }) => {
    await installFramePreviewFixture(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=member-chat&theme=${theme}`)

    const overview = page.getByRole('tab', { name: 'Work', exact: true })
    const frame = page.locator('[data-frame-id="team-frame"]')
    const back = page.getByRole('button', { name: 'Back', exact: true })
    await overview.click()
    await (await teamSeats(frame)).getByRole('group', { name: /Beta/ }).click()
    await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('The request helper makes one attempt. I am tracing where transient failures are returned.')).toBeVisible()
    await expect(back).toBeEnabled()

    await back.click()
    await expect(overview).toHaveAttribute('aria-selected', 'true')
    await expect((await teamSeats(frame)).getByRole('group', { name: /Beta/ })).toBeVisible()
  })

  test(`Team start names the automatic role result in ${theme}`, async ({ page }) => {
    await installFramePreviewFixture(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-start=fix-and-review&theme=${theme}`)

    const writes = page.getByRole('button', { name: 'Configure Writes', exact: true })
    const reviews = page.getByRole('button', { name: 'Configure Reviews', exact: true })
    await expect(writes).toHaveAttribute('aria-expanded', 'false')
    await expect(writes).toHaveText('Nothing can run')
    await expect(reviews).toHaveAttribute('aria-expanded', 'false')
    await expect(reviews).toHaveText('Nothing can run')
    await expect(page.getByRole('button', { name: 'Runtime for Writes', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Model for Writes', exact: true })).toHaveCount(0)
    const writerBounds = await writes.boundingBox()
    const reviewerBounds = await reviews.boundingBox()
    const writerCard = await page.locator('.react-flow__node').filter({ has: writes }).boundingBox()
    const reviewerCard = await page.locator('.react-flow__node').filter({ has: reviews }).boundingBox()
    expect(writerBounds).not.toBeNull()
    expect(reviewerBounds).not.toBeNull()
    expect(writerCard).not.toBeNull()
    expect(reviewerCard).not.toBeNull()
    // Parallel graph cards share a row; each control starts at the same inset inside its card.
    expect(Math.abs(writerCard!.y - reviewerCard!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(writerCard!.width - reviewerCard!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(writerCard!.height - reviewerCard!.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(writerBounds!.x - writerCard!.x - (reviewerBounds!.x - reviewerCard!.x))).toBeLessThanOrEqual(1)
    expect(Math.abs(writerBounds!.width - reviewerBounds!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(writerBounds!.height - reviewerBounds!.height)).toBeLessThanOrEqual(1)
    const roles = page.getByRole('region', { name: 'Who does what' })
    for (const reason of ['Runtime 2 is not added to HarnessDesk', 'Runtime 3 is signed out']) {
      const issue = roles.getByRole('img', { name: reason, exact: true })
      await expect(issue).toBeVisible()
      await expect(issue).toHaveAttribute('title', reason)
    }
  })

  test(`Team board folds empty columns and scrolls when expanded at 1280 in ${theme}`, async ({ page }) => {
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
        empty: !column.querySelector('[data-slot="board-card"]'),
      })),
    }))
    expect(geometry.columns.map(column => column.id)).toEqual(['needs', 'working', 'review', 'todo', 'ready'])
    expect(geometry.columns.find(column => column.id === 'todo')?.collapsed).toBe(true)
    expect(geometry.columns.find(column => column.id === 'ready')?.collapsed).toBe(true)
    expect(geometry.columns.find(column => column.id === 'todo')?.width).toBe(44)
    expect(geometry.columns.find(column => column.id === 'ready')?.width).toBe(44)
    expect(geometry.columns.every(column => column.empty
      ? column.width === 44 && column.collapsed
      : column.width >= 220 && !column.collapsed)).toBe(true)

    // Opening the empty rails restores the wide row this frame's scroll contract protects.
    for (const column of await board.locator('[data-slot="board-column"]').all()) {
      const rail = column.getByRole('button', { name: /0 — Open column/ })
      if (await rail.count()) await rail.click()
    }
    await expect(board.locator('[data-slot="board-column"][data-collapsed]')).toHaveCount(0)
    expect(await board.locator('[data-slot="board-column"]').evaluateAll(columns =>
      columns.every(column => column.getBoundingClientRect().width >= 220))).toBe(true)
    expect(await board.evaluate(element => element.scrollWidth)).toBeGreaterThan(geometry.width)
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

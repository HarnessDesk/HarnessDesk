import { expect, test } from '@playwright/test'
import path from 'node:path'

for (const theme of ['light', 'dark'] as const) {
  test(`Run inspector beside the timeline and pushed detail in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-inspector&theme=${theme}`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    const frame = page.locator('#run-inspector-run')
    const timeline = frame.locator('[data-slot="run-view"]')
    const inspector = frame.locator('[data-slot="run-inspector"]')
    await expect(inspector).toContainText('Brief')
    await expect(inspector.getByRole('progressbar', { name: 'Budget', exact: true })).toHaveAttribute('aria-valuemax', '5')
    await expect(inspector.getByRole('progressbar', { name: 'Without progress', exact: true })).toHaveAttribute('aria-valuenow', '1')
    await expect(inspector).toContainText('3 of 5 rounds')
    await expect(inspector).toContainText('1 of 2 rounds')
    await expect(inspector).toContainText('Authorized after round 3: 2 more rounds')
    await expect(inspector).toContainText('Finish the bounded retry repair.')
    const card = page.locator('#run-inspector-card [data-slot="run-inspector"]')
    await expect(card).toContainText('From #1')
    await expect(card).not.toContainText('From #2')
    for (const kind of ['card', 'person']) {
      const detail = page.locator(`#run-inspector-${kind} [data-slot="run-inspector"]`)
      await expect(detail).toContainText('Keep the retry bounded and the last failure visible.')
      await expect(detail).not.toContainText('complete_claim')
    }
    // A finding that is not read yet is not none: the card says it is reading, or that it could not read.
    for (const [kind, words] of [['findings-reading', 'Reading findings…'], ['findings-failed', 'Findings could not be read']] as const) {
      const unread = page.locator(`#run-inspector-${kind} [data-slot="run-inspector"]`)
      await expect(unread).toContainText(words)
      await expect(unread).not.toContainText('No findings recorded')
    }
    await expect(page.locator('#run-inspector-card [data-slot="run-inspector"]')).toContainText('Cap the attempts.')
    // A Run that recorded no budget says so; it never borrows a limit it was not given.
    for (const kind of ['empty', 'pending', 'failed', 'team']) {
      const summary = page.locator(`#run-inspector-${kind} [data-slot="run-inspector"]`)
      await expect(summary.locator('[data-slot="run-recording-gaps"]')).toContainText('This Run did not record:')
      await expect(summary.locator('[data-slot="run-recording-gaps"]')).toContainText('budget')
      await expect(summary).not.toContainText(/Rounds: \d+ of \d+/)
    }
    const a = await timeline.boundingBox()
    const b = await inspector.boundingBox()
    expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.width)
    for (const kind of ['run', 'card', 'check', 'person', 'findings', 'findings-reading', 'findings-failed', 'empty', 'pending', 'failed', 'team']) {
      const detail = page.locator(`#run-inspector-${kind} [data-slot="run-inspector"]`)
      await expect(detail).toBeVisible()
      expect(await detail.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      if (process.env.RUN_INSPECTOR_FRAMES_DIR) await page.locator(`#run-inspector-${kind}`).screenshot({ path: path.join(process.env.RUN_INSPECTOR_FRAMES_DIR, `${kind}-${theme}.png`) })
    }
    const narrow = page.locator('#run-inspector-narrow')
    await expect(narrow.locator('[data-slot="run-inspector"]')).toBeHidden()
    if (process.env.RUN_INSPECTOR_FRAMES_DIR) await narrow.screenshot({ path: path.join(process.env.RUN_INSPECTOR_FRAMES_DIR, `narrow-timeline-${theme}.png`) })
    await narrow.locator('[data-row="card-3-3"]').click()
    await expect(narrow.locator('[data-slot="run-view"]')).toBeHidden()
    await expect(narrow.locator('[data-slot="run-inspector"]')).toBeVisible()
    await expect(narrow.locator('[data-slot="run-inspector"]')).toContainText('Cap the attempts.')
    if (process.env.RUN_INSPECTOR_FRAMES_DIR) await narrow.screenshot({ path: path.join(process.env.RUN_INSPECTOR_FRAMES_DIR, `narrow-detail-${theme}.png`) })
    await narrow.getByRole('button', { name: 'Run timeline', exact: true }).click()
    await expect(narrow.locator('[data-slot="run-view"]')).toBeVisible()
    await expect(narrow.locator('[data-slot="run-inspector"]')).toBeHidden()
    await narrow.getByRole('button', { name: 'Run details', exact: true }).click()
    await expect(narrow.locator('[data-slot="run-inspector"]')).toContainText('Brief')
    const body = narrow.locator('[data-slot="inspector-body"]')
    expect(await body.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(frame.locator('[data-slot="run-inspector"]')).toBeHidden()
    await frame.locator('[data-row="check-2-2"]').click()
    await expect(inspector).toContainText('Latest result')
    expect(await inspector.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  })
}

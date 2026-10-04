import { expect, test } from '@playwright/test'
import path from 'node:path'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

const states = [
  ['posted', 'Posted to #128', false],
  ['pending', 'Waiting to post', false],
  ['partial', 'Partly posted', true],
  ['uncertain', 'Not confirmed', true],
  ['local', 'Not posted', true],
  ['kept', 'Kept on the desk', false],
  ['unbound', 'Kept on the desk', false],
] as const

for (const theme of ['light', 'dark'] as const) {
  test(`Publication states and their doors fit the Run in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?review-publication&theme=${theme}`)
    await expect(page.locator('#review-publication-posted [data-slot="run-header"]')).toContainText('Posted to #128')
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    // This route mounts only the synthetic publication frames, so the rig's full-document audit applies.
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    for (const [state, words, canPost] of states) {
      const frame = page.locator(`#review-publication-${state}`)
      const header = frame.locator('[data-slot="run-header"]')
      await expect(header).toContainText(words)
      if (['local', 'partial', 'uncertain'].includes(state)) await expect(header).toContainText('Needs you')
      const round = frame.locator('[data-row="findings-3"]')
      await expect(round).toContainText(words)
      await expect(frame.locator('[data-row="end"] [data-slot="chip-words"]').filter({ hasText: words })).toHaveCount(1)
      const inspector = frame.locator('[data-slot="run-inspector"]')
      await expect(inspector.getByRole('button', { name: 'Copy review', exact: true })).toBeEnabled()
      const post = inspector.getByRole('button', { name: 'Post to pull request', exact: true })
      if (canPost) await expect(post).toBeEnabled()
      else await expect(post).toBeDisabled()
      expect(await inspector.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await round.scrollIntoViewIfNeeded()
      if (process.env.REVIEW_PUBLICATION_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `${state}-${theme}.png`) })
    }
    const none = page.locator('#review-publication-none')
    await expect(none.locator('[data-slot="run-header"]')).not.toContainText(/Posted|Waiting to post|Kept on the desk|Not confirmed/)
    const emptyRelease = page.locator('#review-publication-empty-release')
    await expect(emptyRelease.locator('[data-slot="run-header"]')).not.toContainText(/Needs you|Not posted|Kept on the desk/)
    await expect(emptyRelease.locator('[data-row="check-2-2"]')).not.toContainText(/Not posted|Kept on the desk/)
    const missing = page.locator('#review-publication-missing-round')
    await expect(missing.locator('[data-slot="run-header"]')).toContainText('Posted to #128')
    await expect(missing.locator('[data-row="findings-3"]')).not.toContainText('Posted to #128')
    if (process.env.REVIEW_PUBLICATION_FRAMES_DIR) {
      await none.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `none-${theme}.png`) })
      await emptyRelease.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `empty-release-${theme}.png`) })
      await missing.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `missing-round-${theme}.png`) })
    }
    const refused = page.locator('#review-publication-refused')
    await expect(refused.getByRole('button', { name: 'Post to pull request', exact: true })).toBeDisabled()
    await expect(refused.locator('[data-slot="run-inspector"]')).toContainText('The pull request moved past this review.')
    if (process.env.REVIEW_PUBLICATION_FRAMES_DIR) await refused.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `refused-${theme}.png`) })
    for (const surface of ['overview', 'summary', 'teams']) {
      const frame = page.locator(`#review-publication-${surface}`)
      await expect(frame).toContainText(surface === 'teams' ? 'Needs you' : 'Not posted')
      if (process.env.REVIEW_PUBLICATION_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `${surface}-${theme}.png`) })
    }
    // Observe a synthetic copy sink; the browser test never touches the machine's clipboard.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { document.body.dataset.copiedReview = text },
    } }))
    const local = page.locator('#review-publication-local')
    await local.getByRole('button', { name: 'Copy review', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-copied-review', 'Cap the retry attempts and keep the last failure visible.')
    await local.getByRole('button', { name: 'Post to pull request', exact: true }).click()
    const confirmation = page.getByRole('alertdialog', { name: 'Post earlier rounds', exact: true })
    await expect(confirmation).toContainText('Round 3: 1 finding and 1 review')
    if (process.env.REVIEW_PUBLICATION_FRAMES_DIR) await confirmation.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `backfill-${theme}.png`) })
    await confirmation.getByRole('button', { name: 'Post to #128', exact: true }).click()
    await expect(local.getByRole('button', { name: 'Post to pull request', exact: true })).toBeDisabled()
    const narrow = page.locator('#review-publication-narrow')
    await narrow.locator('[data-row="card-3-3"]').click()
    await expect(narrow.locator('[data-slot="run-view"]')).toBeHidden()
    const detail = narrow.locator('[data-slot="run-inspector"]')
    await expect(detail.getByRole('button', { name: 'Post to pull request', exact: true })).toBeEnabled()
    expect(await detail.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    if (process.env.REVIEW_PUBLICATION_FRAMES_DIR) await narrow.screenshot({ path: path.join(process.env.REVIEW_PUBLICATION_FRAMES_DIR, `narrow-${theme}.png`) })
  })
}

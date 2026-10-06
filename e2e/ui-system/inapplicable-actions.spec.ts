import { expect, test } from '@playwright/test'
import path from 'node:path'

// Historical records and lost-card races use the production surfaces with synthetic data.
for (const theme of ['light', 'dark'] as const) {
  for (const scene of ['receipt', 'check', 'review', 'missing'] as const) {
    test(`${scene} keeps its explanation without an inapplicable action in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 720, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?inapplicable-actions=${scene}&theme=${theme}`)
      const frame = page.locator('#inapplicable-action-frame')
      if (scene === 'receipt') {
        await expect(frame).toContainText('Keep the last failure visible')
        await expect(frame).toContainText('Card title not recorded')
      } else if (scene === 'check') {
        await expect(frame).toContainText('This run is settled. Start a new run to run this check again.')
        await expect(frame.getByRole('button', { name: 'Run again…' })).toHaveCount(0)
      } else if (scene === 'review') {
        await expect(frame).toContainText('No review recorded')
        await expect(frame.getByRole('button', { name: 'Copy review' })).toHaveCount(0)
        await expect(frame.getByRole('button', { name: 'Post to pull request' })).toHaveCount(0)
      } else {
        await frame.getByRole('button', { name: 'Abandon card…' }).click()
        await page.getByRole('alertdialog').getByRole('button', { name: 'Abandon card', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Card #4 is no longer available' })
        await expect(dialog).toContainText('There is no card #4 on this board.')
        await expect(dialog).not.toContainText('holds this card now')
        await expect(dialog.getByRole('button', { name: 'Abandon card', exact: true })).toHaveCount(0)
        if (process.env.INAPPLICABLE_ACTIONS_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.INAPPLICABLE_ACTIONS_FRAMES_DIR, `after-missing-${theme}.png`) })
        // The trigger disappeared; both Escape and Close must give the explanation focus.
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await expect(frame.locator('[tabindex="-1"]', { hasText: 'There is no card #4 on this board.' })).toBeFocused()
        await expect(frame.getByRole('button', { name: 'Abandon card…' })).toHaveCount(0)
      }
      expect(await frame.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      if (process.env.INAPPLICABLE_ACTIONS_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.INAPPLICABLE_ACTIONS_FRAMES_DIR, `after-${scene === 'missing' ? 'missing-closed' : scene}-${theme}.png`) })
    })
  }
}

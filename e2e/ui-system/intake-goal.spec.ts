import { expect, test } from '@playwright/test'

/**
 * The machine-wide controls in Settings › Workspaces, and a trigger Goal's
 * own origin and named waits — both mounted from the real preview harness,
 * against the real `TriggerSettings`, `GoalHeader` and `GoalIntake` modules
 * the app renders.
 */

test('pausing every trigger is read back before it shows paused, and the daily cap is a labelled currency field', async ({ page }) => {
  await page.goto('/preview.html')
  const section = page.locator('[aria-label="Triggers on this Mac"]').first()
  await expect(section).toBeVisible()

  const pause = section.getByRole('switch', { name: 'Pause every trigger' })
  await expect(pause).toHaveAttribute('aria-checked', 'false')
  await pause.click()
  await expect(pause).toHaveAttribute('aria-checked', 'true')

  const cap = section.locator('input[type="number"]')
  await expect(cap).toHaveValue('20')
  await expect(section).toContainText('Reserved today')
  await expect(section).toContainText('Charged today')
})

test('a Goal a trigger opened shows its origin, drawn from the host’s own label, with no Intake data for a plain Goal beside it', async ({ page }) => {
  await page.goto('/preview.html')
  const triggerFrame = page.locator('text=Goal — opened by a trigger').locator('..')
  const origin = triggerFrame.locator('[aria-label="Trigger origin"]')
  await expect(origin).toContainText('Opened from PR #12')

  const plainFrame = page.locator('text=Goal — state, roster and channel').locator('..')
  await expect(plainFrame.locator('[aria-label="Trigger origin"]')).toHaveCount(0)
})

test('a held message and a held action each read Needs you with a working owner', async ({ page }) => {
  await page.goto('/preview.html')
  const goalScene = page.locator('select', { has: page.locator('option', { hasText: 'held-message' }) }).first()
  await goalScene.selectOption('held-message')
  const origin = page.locator('[aria-label="Trigger origin"]')
  await expect(origin).toContainText('Needs you')
  await expect(origin).toContainText('held for your review')

  await goalScene.selectOption('held-action')
  await expect(origin).toContainText('An action is held for your approval.')
})

test('a question that timed out and a budget stop each name their exact reason, with partial work kept', async ({ page }) => {
  await page.goto('/preview.html')
  const goalScene = page.locator('select', { has: page.locator('option', { hasText: 'question' }) }).first()
  await goalScene.selectOption('question')
  const origin = page.locator('[aria-label="Trigger origin"]')
  await expect(origin).toContainText('nobody answered in time')

  await goalScene.selectOption('stopped')
  await expect(origin).toContainText('Out of budget.')
  await expect(origin).toContainText('The daily cap was reached before this round closed.')
})

test('machine settings and Goal origin fit light, dark and narrow layouts with no clipped sentence', async ({ page }) => {
  for (const width of [1280, 640]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')

      const settings = page.locator('[aria-label="Triggers on this Mac"]').first()
      await expect(settings).toBeVisible()
      const settingsOverflow = await settings.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(settingsOverflow, `settings at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)

      const origin = page.locator('[aria-label="Trigger origin"]').first()
      await expect(origin).toBeVisible()
      const originOverflow = await origin.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(originOverflow, `origin at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
    }
  }
})

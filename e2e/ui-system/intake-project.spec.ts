import { expect, test } from '@playwright/test'

/**
 * A project's Triggers section and the arming review, mounted from the real
 * preview harness's own interactive fixture (`main.tsx`'s mutable
 * `previewTriggers`) — arming and disarming here call the same
 * `ProjectTriggers`/`TriggerArm` production modules the real app renders,
 * against a store that actually remembers the result, the way the capture
 * switch beside it does.
 */

test('keyboard arming resists a held Return and restores focus on cancel; only a chosen Arm arms it', async ({ page }) => {
  await page.goto('/preview.html')

  const section = page.locator('[aria-label="Triggers"]').first()
  await expect(section).toBeVisible()

  const toggle = section.getByRole('switch', { name: 'Arm review-pr' })
  await toggle.focus()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('alertdialog', { name: 'Arm this trigger' })
  await expect(dialog).toBeVisible()

  // Nothing is focused the instant the dialog opens, so a Return held from
  // the keypress that opened it must not land on a button that arms — the
  // dialog is still up, and the switch behind it stays inert either way.
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  // Reopening and choosing Arm explicitly is the only thing that arms it —
  // once.
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  const arm = dialog.getByRole('button', { name: 'Arm' })
  await arm.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
})

test('turning an armed trigger off disarms it and returns focus to its own switch', async ({ page }) => {
  await page.goto('/preview.html')
  const section = page.locator('[aria-label="Triggers"]').first()
  const toggle = section.getByRole('switch', { name: 'Arm nightly-sweep' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toBeFocused()
})

test('History expands in place and always names an exact duplicate', async ({ page }) => {
  await page.goto('/preview.html')
  const section = page.locator('[aria-label="Triggers"]').first()
  await section.getByRole('button', { name: 'History' }).first().click()
  await expect(section.getByText('Already recorded')).toBeVisible()
})

test('project trigger states fit light, dark and narrow layouts with no clipped sentence', async ({ page }) => {
  for (const width of [1280, 640]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')

      const section = page.locator('[aria-label="Triggers"]').first()
      await expect(section).toBeVisible()
      await section.getByRole('button', { name: 'History' }).first().click()

      const overflow = await section.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(overflow, `at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
    }
  }
})

import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`preview runtime accounts expose only supported gateway actions in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.locator('[data-frame-id="runtimes-status"]')
    const row = (name: string) => frame.locator('[data-slot="agent-row"]').filter({ has: page.locator('[data-slot="runtime-name"]', { hasText: name }) })
    await row('Codex').click()
    await expect(frame.getByText('Not answered yet', { exact: true })).toBeVisible()
    await expect(frame.getByRole('button', { name: 'Add gateway account…' })).toBeVisible()
    await frame.getByRole('button', { name: 'Add gateway account…' }).click()
    await expect(page.getByRole('dialog', { name: 'Add a gateway account' })).toBeVisible()
    await page.keyboard.press('Escape')
    await frame.getByRole('button', { name: /Codex actions/ }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await frame.getByRole('button', { name: 'Back to Runtimes' }).click()
    await row('Claude Code').click()
    await expect(frame.getByRole('heading', { name: 'Accounts' })).toBeVisible()
    await expect(frame.getByRole('button', { name: 'Add gateway account…' })).toHaveCount(0)
  })
}

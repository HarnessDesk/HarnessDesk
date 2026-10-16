import { test, expect } from '@playwright/test'

for (const theme of ['light', 'dark']) for (const scene of ['run', 'wrap'] as const) {
  test(`Team run words and Wrap ${scene} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 850 })
    await page.goto(`/preview.html?shape-graph&theme=${theme}`)
    await page.evaluate(async scene => {
      const fixture = await import('/src/preview/team-words-fixture.tsx')
      fixture.mountTeamWordsPreview(scene)
    }, scene)
    const before = process.env.TEAM_WORDS_BEFORE === '1'
    if (scene === 'wrap') {
      await expect(page.getByRole('dialog')).toBeVisible()
      if (!before) {
        await expect(page.getByRole('textbox', { name: 'What finished' })).toHaveValue(/#1.*Merged\n#2.*Not kept/)
        await expect(page.getByRole('combobox', { name: 'Disposition for #2 · Improve the session store' })).toHaveValue('dropped')
        await page.getByRole('textbox', { name: 'What finished' }).fill('An editable wrap summary')
        await expect(page.getByRole('button', { name: 'Review receipt', exact: true })).toBeEnabled()
        await page.getByRole('textbox', { name: 'What finished' }).fill('#1 · Improve the session store — Merged\n#2 · Improve the session store — Not kept')
      }
    } else {
      await expect(page.locator('[data-team-words]')).toBeVisible()
      if (!before) {
        await expect(page.getByText('2 attempts · Referee picked', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: /Pick up a task/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Check who is editing these files/ })).toBeVisible()
        await expect(page.locator('[data-testid="turn-work"]')).not.toHaveAttribute('data-trouble')
        await expect(page.locator('[data-slot="room-composer-notice"]')).toContainText('Agents cannot message each other')
        await expect(page.locator('[data-slot="room-composer-notice"]')).not.toContainText('Board-only is on')
      }
    }
    if (process.env.TEAM_WORDS_FRAMES) await page.screenshot({ path: `${process.env.TEAM_WORDS_FRAMES}/${scene}-${before ? 'before' : 'after'}-${theme}.png` })
  })
}

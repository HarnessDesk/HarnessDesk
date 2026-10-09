import { expect, test } from '@playwright/test'

/** The Run owns its refusal; the other Team destinations lead there. */
test('a stopped Team keeps its full reason on Run and a recovery link on the other pages', async ({ page }, info) => {
  await page.goto('/design.html?view=group')
  await page.evaluate(async () => { await document.fonts.ready })
  const wrap = page.locator('[data-testid="group-run-stalled-on-a-seat"]')
  await expect(wrap).toBeVisible()
  await wrap.scrollIntoViewIfNeeded()
  await expect(wrap.locator('header').filter({ hasText: 'Needs you' }).first()).toBeVisible()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.body.toggleAttribute('data-hd-dark-theme', value === 'dark'); document.documentElement.style.colorScheme = value }, theme)
    for (const name of ['Overview', 'Board', 'Chat', 'Run']) {
      await wrap.getByRole('tab', { name: new RegExp(`^${name}\\b`) }).click()
      if (name === 'Run') {
        const reason = wrap.locator('[data-slot="run-need"]')
        await expect(reason).toContainText('The Seat for card #1 could not be opened')
        await expect(reason).toContainText('card #2 was not started either')
        await expect(reason).toContainText('Next: fix what stopped card #1, then choose Run again.')
        await expect(wrap.getByText(/The Seat for card #1 could not be opened/)).toHaveCount(1)
        await expect(wrap.getByRole('button', { name: 'Run again…', exact: true })).toBeVisible()
      } else {
        await expect(wrap.getByText(/The Seat for card #1 could not be opened/)).toHaveCount(0)
        const recovery = wrap.getByRole('button', { name: 'Review stopped Run', exact: true })
        await expect(recovery).toBeVisible()
        await recovery.click()
        await expect(wrap.locator('[data-slot="run-need"]')).toContainText('The Seat for card #1 could not be opened')
        await wrap.getByRole('tab', { name: new RegExp(`^${name}\\b`) }).click()
      }
      await expect(wrap).not.toContainText('wrap this Goal')
      await info.attach(`stopped-${name.toLowerCase()}-${theme}`, { body: await wrap.screenshot(), contentType: 'image/png' })
    }
  }
})

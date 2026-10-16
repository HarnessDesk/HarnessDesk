import { selectTeamPage } from './team-frame-actions'
import { expect, test } from '@playwright/test'

/** The Run owns its refusal; the other Team destinations lead there. */
{

  for (const [themeItem, theme] of (['light', 'dark']).entries()) {

    for (const [item0, name] of (['Overview', 'Board', 'Chat', 'Run']).entries()) test(`a stopped Team keeps its full reason on Run and a recovery link on the other pages [item ${[themeItem].join('-')}] [item ${[item0].join('-')}]`, async ({ page }, info) => {
      await page.goto('/design.html?view=group')
      await page.evaluate(async () => { await document.fonts.ready })
      const wrap = page.locator('[data-testid="group-run-stalled-on-a-seat"]')
      await expect(wrap).toBeVisible()
      await wrap.scrollIntoViewIfNeeded()
      await expect(wrap.locator('[data-topbar="state"] [aria-label="Needs you"]')).toBeVisible()
      await page.evaluate(value => { document.body.toggleAttribute('data-hd-dark-theme', value === 'dark'); document.documentElement.style.colorScheme = value }, theme)
      await selectTeamPage(wrap, { Overview: 'overview', Board: 'board', Chat: 'room', Run: 'run' }[name]!)
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
        await selectTeamPage(wrap, { Overview: 'overview', Board: 'board', Chat: 'room', Run: 'run' }[name]!)
      }
      await expect(wrap).not.toContainText('wrap this Goal')
      await info.attach(`stopped-${name.toLowerCase()}-${theme}`, { body: await wrap.screenshot(), contentType: 'image/png' })


    })
  }
}

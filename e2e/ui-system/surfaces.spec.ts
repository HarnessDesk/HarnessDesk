import { expect, test } from '@playwright/test'

import { PRODUCT_SURFACES } from '../../packages/ui/src/design/catalog/manifest'

/**
 * Every whole-screen surface mounts without an error of any kind.
 *
 * A page-level check is not enough, and the #762 review showed why: the
 * terminal pane catches a failed attach and prints the exception in its own
 * body, so the page's boundary never trips and the console stays quiet. A
 * sweep of every tab passed while two of them displayed "Cannot read
 * properties of null (reading 'scrollback')". So there are three nets here —
 * an uncaught error, a logged one, and the words an exception is made of
 * appearing anywhere on the page, which no product copy ever says.
 *
 * The list is the catalogue's own, so a surface added to the manifest is
 * checked the day it is added.
 */
const EXCEPTION_WORDS =
  /Cannot read properties of|is not a function|is not defined|undefined is not|threw while rendering|Maximum update depth/

for (const [id, view] of PRODUCT_SURFACES) {
  test(`${id} mounts with no error on the page, in the console, or in its own body`, async ({ page }) => {
    const problems: string[] = []
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`logged: ${message.text().slice(0, 200)}`)
    })

    await page.goto(`/design.html?view=${view}`)
    // A surface loads behind a split; wait for the screen, not for the page.
    await expect(page.getByText('Mounting the screen…')).toHaveCount(0)
    await expect(page.locator('h1').first()).toBeVisible()
    // Let the screen's own first requests answer — the terminal's attach is
    // one, and the failure this exists for arrives with it.
    await page.waitForLoadState('networkidle')

    const said = (await page.locator('body').innerText()).match(EXCEPTION_WORDS)
    if (said) problems.push(`printed: "${said[0]}" — a component caught an exception and showed it`)

    expect(problems, `${view}: ${problems.join('\n')}`).toEqual([])
  })
}

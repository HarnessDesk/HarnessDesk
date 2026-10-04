import { expect, test, type Locator } from '@playwright/test'

/**
 * What waits on a person, answered from the Overview. The unit tests hold what
 * each button sends; what only a browser can see is held here, on the
 * production rows: the choices read in the order the docked card puts them, the
 * one filled answer is the plain yes, a sentence arrives whole, nothing
 * reaches past its row, and a refused answer keeps its reason beside it.
 */
const frame = (id: string) => `#team-overview-answer-${id}`

/** Every control and line of a row sits inside the row, and the row inside its pane. */
const within = (row: Locator) => row.evaluate((element) => {
  const box = element.getBoundingClientRect()
  const stray = [...element.querySelectorAll('button, input, [data-slot="approval-code"], [role="alert"], [data-slot="text"]')].filter((child) => {
    const rect = child.getBoundingClientRect()
    return rect.width > 0 && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)
  })
  return { stray: stray.length, scrolls: element.scrollWidth > element.clientWidth + 1 }
})

/** A line of words, as the engine laid it out: it fits its box and is not cut by an ellipsis. */
const arrivesWhole = (line: Locator) => line.evaluate((element) => {
  const style = getComputedStyle(element)
  return { ellipsis: style.textOverflow === 'ellipsis' && style.overflow !== 'visible', fits: element.scrollWidth <= element.clientWidth + 1 }
})

for (const theme of ['light', 'dark'] as const) {
  test(`an approval is answered from its Needs-you row with the choices in the docked card's order in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    const row = page.locator(`${frame('approval')} [aria-label="Needs you"] [data-slot="list-row"]`)
    await expect(row).toHaveCount(1)
    const buttons = row.locator('button')
    expect(await buttons.evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Deny', 'Allow for this session', 'Allow once'])
    // One filled answer, the plain yes; the choice that also says yes next time is not the easy target.
    expect(await buttons.evaluateAll((all) => all.map((one) => one.hasAttribute('data-filled')))).toEqual([false, false, true])
    const order = await buttons.evaluateAll((all) => all.map((one) => Math.round(one.getBoundingClientRect().left)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // What is approved is shown whole, in the code face, and the reason beside it.
    const code = row.locator('[data-slot="approval-code"]')
    await expect(code).toHaveText('pnpm verify')
    expect(await code.evaluate((one) => getComputedStyle(one).fontFamily)).toMatch(/mono|Menlo|Consolas|Courier/i)
    await expect(row).toContainText('The check needs a clean checkout of the branch.')
    expect(await within(row)).toEqual({ stray: 0, scrolls: false })
    for (const button of await buttons.all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(24)
  })

  test(`an access request says what it would open before it can be allowed in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const row = page.locator(`${frame('access')} [aria-label="Needs you"] [data-slot="list-row"]`)
    await expect(row).toContainText('Installing the checkout dependencies needs the network.')
    await expect(row).toContainText('Folders')
    await expect(row).toContainText('/work/storefront/node_modules')
    await expect(row).toContainText('registry.example.com')
    expect(await row.locator('button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Deny', 'Allow once'])
    expect(await within(row)).toEqual({ stray: 0, scrolls: false })
  })

  test(`a person's step reads what each answer does, whole, and takes a note in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    const row = page.locator(`${frame('step')} [aria-label="Needs you"] [data-slot="list-row"]`)
    const effect = row.locator('[data-slot="step-effect"] [data-slot="text"]')
    await expect(effect).toHaveText('Approved opens the verify check. Request changes opens a fixer round.')
    expect(await arrivesWhole(effect)).toEqual({ ellipsis: false, fits: true })
    expect(await row.locator('[role="group"] button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Approved', 'Request changes'])
    await expect(row.locator('input[aria-label="Note"]')).toHaveAttribute('placeholder', 'Add a note (optional)')
    // The group is described by the sentence, so a screen reader hears what the answers do.
    const described = await row.locator('[role="group"]').getAttribute('aria-describedby')
    expect(described).toBe(await row.locator('[data-slot="step-effect"]').getAttribute('id'))
    expect(await within(row)).toEqual({ stray: 0, scrolls: false })
  })

  test(`a question is answered with its options, and one that needs a form leaves for its conversation in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const question = page.locator(`${frame('question')} [aria-label="Needs you"] [data-slot="list-row"]`)
    expect(await question.locator('button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Payments', 'Inventory', 'Cancel'])
    expect(await question.locator('button').evaluateAll((all) => all.some((one) => one.hasAttribute('data-filled')))).toBe(false)
    const form = page.locator(`${frame('form')} [aria-label="Needs you"] [data-slot="list-row"]`)
    expect(await form.locator('button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Cancel', 'Answer in the conversation'])
    expect(await form.locator('button').evaluateAll((all) => all.map((one) => one.hasAttribute('data-filled')))).toEqual([false, true])
    const review = page.locator(`${frame('review')} [aria-label="Needs you"] [data-slot="list-row"]`)
    expect(await review.locator('button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Pick an attempt on the board'])
    await expect(review.locator('input')).toHaveCount(0)
  })

  test(`a refused answer keeps the host's reason on screen beside the answer it refused in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    const row = page.locator(`${frame('refused')} [aria-label="Needs you"] [data-slot="list-row"]`)
    const alert = row.locator('[role="alert"]')
    await expect(alert).toHaveText('This card was already answered.')
    const approved = row.getByRole('button', { name: 'Approved', exact: true })
    await expect(approved).toBeDisabled()
    await expect(row.getByRole('button', { name: 'Request changes', exact: true })).toBeEnabled()
    // The reason is on screen, not behind a tooltip a disabled control would never raise.
    expect(await alert.isVisible()).toBe(true)
    expect(await within(row)).toEqual({ stray: 0, scrolls: false })
  })

  test(`at a narrow pane the controls wrap under their sentence and nothing scrolls sideways in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    const pane = page.locator(`${frame('narrow')} [data-slot="team-overview"]`)
    await expect(pane).toHaveAttribute('data-layout', 'narrow')
    expect(await pane.evaluate((one) => one.scrollWidth <= one.clientWidth)).toBe(true)
    for (const row of await pane.locator('[aria-label="Needs you"] [data-slot="list-row"]').all()) {
      expect(await within(row)).toEqual({ stray: 0, scrolls: false })
    }
    const step = pane.locator('[aria-label="Needs you"] [data-slot="list-row"]').nth(1)
    const input = (await step.locator('input').boundingBox())!
    const first = (await step.locator('[role="group"] button').first().boundingBox())!
    // Too narrow to share a line, the note takes its own and the answers go under it.
    expect(first.y).toBeGreaterThan(input.y + input.height - 1)
    const effect = step.locator('[data-slot="step-effect"] [data-slot="text"]')
    expect(await arrivesWhole(effect)).toEqual({ ellipsis: false, fits: true })
    expect(await effect.evaluate((one) => one.getBoundingClientRect().height)).toBeGreaterThan(20)
  })
}

import { expect, test, type Locator, type Page } from '@playwright/test'
import path from 'node:path'

/*
 * A check run again, in the browser: where *Run again…* sits on a check's row,
 * how its attempts read under the row and in the inspector, and that a Run
 * that cannot run it again says why instead of offering it. jsdom does no
 * layout, so the geometry — the control clear of the row's own words, the
 * attempts under the check's title, nothing wider than its pane — is here.
 *
 * RUN_CHECK_AGAIN_FRAMES_DIR, when set, writes every frame this looks at.
 */

const frame = async (target: Locator, name: string, theme: string): Promise<void> => {
  if (process.env.RUN_CHECK_AGAIN_FRAMES_DIR) await target.screenshot({ path: path.join(process.env.RUN_CHECK_AGAIN_FRAMES_DIR, `${name}-${theme}.png`) })
}

const open = async (page: Page, theme: 'light' | 'dark'): Promise<void> => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?run-view&run-inspector&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
}

/** The union of a row's title words, as the browser laid them out, and where its control and lead sit. */
const geometry = (row: Locator) => row.evaluate((el) => {
  const control = el.querySelector('[data-slot="list-row-trail"] button') as HTMLElement
  const title = el.querySelector('[data-slot="list-row-title"]') as HTMLElement
  // The words themselves — every text node's own boxes — not the boxes of the elements around them.
  const words: DOMRect[] = []
  const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const range = document.createRange()
    range.selectNodeContents(node)
    words.push(...[...range.getClientRects()].filter((one) => one.width > 0))
  }
  const box = el.getBoundingClientRect()
  const hit = control.getBoundingClientRect()
  return {
    separateControls: el.tagName !== 'BUTTON' && control.closest('[data-slot="list-row-trail"]') !== null,
    wordsRight: Math.max(...words.map((one) => one.right)),
    controlLeft: hit.left,
    controlInside: hit.left >= box.left && hit.right <= box.right + 0.5 && hit.top >= box.top && hit.bottom <= box.bottom + 0.5,
    rowMiddle: (box.top + box.bottom) / 2,
    controlMiddle: (hit.top + hit.bottom) / 2,
    rowOverflows: el.scrollWidth > el.clientWidth + 1,
  }
})

for (const theme of ['light', 'dark'] as const) {
  test(`a check that ran twice reads under its row, and offers Run again… clear of its own words, in ${theme}`, async ({ page }) => {
    await open(page, theme)
    for (const id of ['run-view-attempts', 'run-view-narrow']) {
      const view = page.locator(`#${id} [data-slot="run-view"]`)
      const row = view.locator('[data-row="check-2-2"]')
      await expect(row).toBeVisible()
      const again = view.getByRole('button', { name: 'Run again…' })
      await expect(again).toHaveCount(1)
      const g = await geometry(row)
      expect(g.separateControls, 'the trailing control is never nested inside another button').toBe(true)
      expect(g.controlInside, 'the control stays in the row’s box').toBe(true)
      expect(g.controlLeft, 'the control sits clear of the row’s own words').toBeGreaterThan(g.wordsRight)
      expect(Math.abs(g.controlMiddle - g.rowMiddle), 'the control shares the whole row centre').toBeLessThan(1.5)
      expect(g.rowOverflows).toBe(false)
    }

    const view = page.locator('#run-view-attempts [data-slot="run-view"]')
    expect(await view.locator('[data-kind]').evaluateAll((rows) => rows.map((one) => one.getAttribute('data-kind'))))
      .toEqual(['start', 'brief', 'round', 'card', 'round', 'check', 'attempt', 'attempt', 'round', 'card', 'findings', 'round', 'card'])
    const [one, two] = ['attempt-2-2-1', 'attempt-2-2-2'].map((id) => view.locator(`[data-row="${id}"]`))
    await expect(one).toContainText('Attempt 1')
    await expect(one).toContainText('Failed')
    await expect(two).toContainText('Attempt 2')
    await expect(two).toContainText('Passed')
    // Under the check's own words, not under its tile: the title of each attempt starts where the check's title does.
    const left = (row: Locator) => row.evaluate((el) => (el.querySelector('[data-slot="list-row-title"]') as HTMLElement).getBoundingClientRect().left)
    expect(Math.abs((await left(one)) - (await left(view.locator('[data-row="check-2-2"]'))))).toBeLessThan(1.5)
    expect(Math.abs((await left(two)) - (await left(view.locator('[data-row="check-2-2"]'))))).toBeLessThan(1.5)
    // They are lines of the story, not rows to press.
    await one.click()
    await expect(view.locator('[aria-current="true"]')).toHaveCount(0)
    await frame(page.locator('#run-view-attempts'), 'timeline-attempts', theme)
    await frame(page.locator('#run-view-narrow'), 'timeline-narrow', theme)
  })

  test(`an ended Run omits check retry, while a running check keeps its explained disabled action, in ${theme}`, async ({ page }) => {
    await open(page, theme)
    for (const id of ['run-view-settled', 'run-view-stopped', 'run-view-complete']) {
      const view = page.locator(`#${id}`)
      // An ended Run may offer a fresh Run; only that ending door remains, never a check retry.
      const fresh = id === 'run-view-complete' ? 0 : 1
      await expect(view.getByRole('button', { name: 'Run again…', exact: true })).toHaveCount(fresh)
      await expect(view.locator('[data-slot="run-ending"]').getByRole('button', { name: 'Run again…', exact: true })).toHaveCount(fresh)
    }
    for (const [scene, state] of [['check-refused', 'settled'], ['check-stopped', 'stopped']] as const) {
      const refused = page.locator(`#run-inspector-${scene} [data-slot="run-inspector"]`)
      await expect(refused).toContainText(`This run is ${state}. Start a new run to run this check again.`)
      await expect(refused.getByRole('button', { name: 'Run again…' })).toHaveCount(0)
      await expect(refused.locator('[data-slot="text"]', { hasText: `This run is ${state}.` }).first()).toBeVisible()
      await frame(page.locator(`#run-inspector-${scene}`), `inspector-${state}`, theme)
    }
    const running = page.locator('#run-inspector-check-running [data-slot="run-inspector"]')
    await expect(running).toContainText('This check is not waiting to be run again.')
    await expect(running.getByRole('button', { name: 'Run again…' })).toHaveAttribute('aria-disabled', 'true')
  })

  test(`the inspector lists both attempts, newest first, and keeps an earlier output as it was, in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const frameOf = page.locator('#run-inspector-check-attempts')
    const inspector = frameOf.locator('[data-slot="run-inspector"]')
    const attempts = inspector.locator('[data-attempt]')
    await expect(attempts).toHaveCount(2)
    expect(await attempts.evaluateAll((list) => list.map((one) => one.getAttribute('data-attempt')))).toEqual(['2', '1'])
    await expect(attempts.nth(1)).toContainText('Failed')
    await expect(attempts.nth(1)).toContainText('Exit 1')
    await expect(attempts.nth(0)).toContainText('Passed')
    await expect(inspector).not.toContainText('expected 3 attempts, received 1')
    await frame(frameOf, 'inspector-attempts', theme)
    await attempts.nth(1).getByRole('button', { name: 'Show output' }).click()
    await expect(attempts.nth(1)).toContainText('expected 3 attempts, received 1')
    expect(await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await frame(frameOf, 'inspector-attempts-open', theme)
    const buttons = inspector.getByRole('button')
    await expect(buttons.last()).toHaveText('Run again…')
    await expect(buttons.last()).toBeEnabled()
  })

  test(`a check whose attempts are not here says it is reading, or that it could not read, in ${theme}`, async ({ page }) => {
    await open(page, theme)
    await expect(page.locator('#run-inspector-attempts-reading [data-slot="run-inspector"]')).toContainText('Reading attempts…')
    await expect(page.locator('#run-inspector-attempts-failed [data-slot="run-inspector"]')).toContainText('Earlier attempts could not be read')
    for (const kind of ['attempts-reading', 'attempts-failed']) {
      await expect(page.locator(`#run-inspector-${kind} [data-slot="run-inspector"]`)).not.toContainText('Attempt 1')
      await frame(page.locator(`#run-inspector-${kind}`), `inspector-${kind}`, theme)
    }
  })

  test(`a new check stays in reading state while earlier attempts remain visible, in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const frameOf = page.locator('#run-inspector-attempts-new-check-reading')
    const view = frameOf.locator('[data-slot="run-view"]')
    const inspector = frameOf.locator('[data-slot="run-inspector"]')
    await expect(inspector).toContainText('Verify the repair')
    await expect(inspector).toContainText('Reading attempts…')
    await expect(inspector).not.toContainText('No earlier attempts')
    await expect(view.locator('[data-row="attempt-2-2-1"]')).toContainText('Failed')
    await expect(view.locator('[data-row="attempt-2-2-2"]')).toContainText('Passed')
    await frame(frameOf, 'inspector-new-check-reading', theme)
  })

  test(`an incomplete history keeps its known result without inventing its attempt number, in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const frameOf = page.locator('#run-inspector-attempts-incomplete')
    const inspector = frameOf.locator('[data-slot="run-inspector"]')
    await expect(inspector.locator('[data-attempt]')).toHaveCount(1)
    await expect(inspector.locator('[data-attempt]')).toContainText('Recorded result')
    await expect(inspector).not.toContainText('Attempt 1')
    await expect(inspector).toContainText('Attempt history could not be read completely.')
    await frame(frameOf, 'inspector-attempts-incomplete', theme)
  })

  test(`the consent dialog shows the command verbatim, or the host's refusal with its answer disabled, in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?theme=${theme}`)
    for (const [option, refused] of [['retry check', false], ['retry check refused', true]] as const) {
      await page.locator('select', { has: page.locator('option', { hasText: 'retry check refused' }) }).first().selectOption(option)
      const dialog = page.getByRole('alertdialog', { name: 'Run this check again?' })
      await expect(dialog).toBeVisible()
      const confirm = dialog.getByRole('button', { name: 'Run again', exact: true })
      if (refused) {
        await expect(dialog).toContainText('This run is settled. Start a new run to run this check again.')
        await expect(confirm).toBeDisabled()
      } else {
        await expect(dialog).toContainText('pnpm')
        await expect(dialog).toContainText('/work/storefront')
        await expect(confirm).toBeEnabled()
      }
      await frame(dialog, `dialog-${refused ? 'refused' : 'command'}`, theme)
      await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
      await expect(dialog).toBeHidden()
    }
  })

  test(`the check's inspector fits a phone-width pane, with its attempts and control, in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await open(page, theme)
    const inspector = page.locator('#run-inspector-check-attempts [data-slot="run-inspector"]')
    await expect(inspector).toBeHidden()
    await page.locator('#run-inspector-check-attempts [data-row="check-2-2"]').click()
    await expect(inspector).toBeVisible()
    await expect(inspector).toContainText('Attempt 2')
    expect(await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await frame(page.locator('#run-inspector-check-attempts'), 'inspector-attempts-narrow', theme)
  })
}

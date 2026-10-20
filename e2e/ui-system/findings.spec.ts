import { expect, test } from '@playwright/test'
import { selectTeamPage } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`finding keeps its raised-by Seat facts visible inside the dialog (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/preview.html?findings=seat&theme=${theme}&guides=off`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    const group = page.getByRole('group', { name: 'Raised by', exact: true })
    const facts = group.locator('[data-slot="key-value"][aria-label="Seat facts"]')
    await expect(facts).toBeVisible()
    await expect(facts).toContainText('retry-on-502 at a1b2c3d')
    await expect(facts).toContainText('Opened')
    await expect(group.locator('[data-slot="tool-section"], [data-slot="tool-fold"]')).toHaveCount(0)
    await expect(group.locator('[data-slot="inspector-empty"]')).toHaveCount(0)
    await expect(group).toContainText('AttachmentsNot recorded')
    expect(await facts.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}

/**
 * The findings ledger, in the Goal Team page.
 *
 * Mounted from the existing preview's own Goal frame — real production
 * modules, the real `PreviewStore` findings fixture — rather than a synthetic
 * render, because the thing worth proving here is that the whole path from
 * the page tab to the detail dialog is one continuous keyboard journey with
 * nothing off-screen at the widths the app actually runs at.
 */

test('keyboard reaches the findings filters, a row’s detail, and back', async ({ page }) => {
  await page.goto('/preview.html')

  const goal = page.locator('[data-frame-id="goal-roster"]')
  await selectTeamPage(goal, 'findings')
  const view = goal.locator('[data-slot="workbench-main"]').getByRole('button', { name: 'View', exact: true })
  await view.click()
  const openFilter = page.getByRole('switch', { name: 'Open', exact: true })
  await openFilter.focus()
  await page.keyboard.press('Space')
  await expect(view).toBeVisible()
  await view.click()
  await expect(openFilter).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('switch', { name: 'All', exact: true }).click()

  const openRow = goal.getByRole('button', { name: /finding-open-1/ })
  await expect(openRow).toBeVisible()
  await openRow.focus()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog', { name: /checkout path/ })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('finding-open-1')

  // Selectable, literal id — never abbreviated into something a search cannot find.
  await expect(dialog.getByText('finding-open-1', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(openRow).toBeFocused()
})

{

  for (const [item0, width] of ([1440, 680]).entries()) test(`desktop and narrow layouts keep every sentence inside the pane [item ${[item0].join('-')}]`, async ({ page }) => {

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')

      const goal = page.locator('[data-frame-id="goal-roster"]')
      await selectTeamPage(goal, 'findings')

      // The counted icon tab also has this accessible name. Measure the
      // content pane, not the tab's hidden intrinsic-width label.
      const pane = goal.locator('[data-slot="tool-pane"][aria-label="Findings"]')
      await expect(pane).toBeVisible()

      const overflow = await pane.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(overflow, `at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)

      const openRow = goal.getByRole('button', { name: /finding-open-1/ })
      await openRow.click()
      const dialog = page.getByRole('dialog', { name: /checkout path/ })
      await expect(dialog).toBeVisible()
      const dialogOverflow = await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(dialogOverflow, `dialog at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
      await page.keyboard.press('Escape')
    }


  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`narrow findings reserve a full title line and keep literal ids and lifecycle in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 1000 })
    await page.goto(`/preview.html?theme=${theme}`)
    const goal = page.locator('[data-frame-id="goal-roster"]')
    await selectTeamPage(goal, 'findings')
    for (const id of ['finding-claim-1', 'finding-confirmed-1']) {
      const row = goal.getByRole('button', { name: new RegExp(id) })
      const geometry = await row.evaluate(el => {
        const title = el.querySelector('[data-slot="row-title"]') ?? el.querySelector('.truncate')!
        const identifier = [...el.querySelectorAll('[data-slot="code-text"]')][0]!
        const state = el.querySelector('[data-slot="chip"]')!
        const t = title.getBoundingClientRect(), i = identifier.getBoundingClientRect(), s = state.getBoundingClientRect()
        const titleRange = document.createRange()
        titleRange.selectNodeContents(title)
        const textRects = [...titleRange.getClientRects()]
        const stateOverlapsTitle = textRects.some(rect => s.left < rect.right && s.right > rect.left && s.top < rect.bottom && s.bottom > rect.top)
        return { width: t.width, idBelow: i.top >= t.bottom - 1, stateClear: !stateOverlapsTitle, fits: title.scrollWidth <= title.clientWidth }
      })
      expect(geometry).toMatchObject({ idBelow: true, stateClear: true, fits: true })
      expect(geometry.width).toBeGreaterThan(300)
      await expect(row).toContainText(id)
      await expect(row).toContainText(id.includes('claim') ? 'Repair claimed · awaiting review' : 'Repair accepted by reviewer')
    }
  })
}

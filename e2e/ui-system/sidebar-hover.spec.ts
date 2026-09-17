import { expect, test, type Locator, type Page } from '@playwright/test'

const sidebar = (page: Page) => page.locator('[class*="sidebar_"]')
const workspace = (page: Page) => sidebar(page).locator('[class*="groupHead_"]').filter({
  has: page.locator('button[aria-label="Actions for HarnessDesk"]'),
})

async function setWidth(page: Page, width: number) {
  await sidebar(page).evaluate((node, width) => {
    node.parentElement!.style.width = `${width}px`
    // The preview's neighboring frame must yield to the wider sidebar too.
    const frame = node.parentElement!.parentElement!.parentElement!
    frame.parentElement!.style.gridTemplateColumns = `${Math.max(380, width + 2)}px minmax(0, 1fr)`
  }, width)
}

/**
 * Read a box once it has stopped moving.
 *
 * Hovering a row reveals its actions and re-flows the marks at its end, and a
 * single read taken on the frame the pointer lands can catch either side of
 * that. Measured: the same tree passed six of six cases on one run and failed
 * two on the next, with no edit between them. Two agreeing frames is the
 * cheapest thing that cannot see the transition.
 */
async function settled(locator: Locator) {
  let last = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = await bounds(locator)
    const key = JSON.stringify(now)
    if (key === last) return now
    last = key
    await locator.page().waitForTimeout(40)
  }
  return bounds(locator)
}

async function bounds(locator: Locator) {
  return locator.evaluate(node => {
    const rect = node.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  })
}

async function unobstructed(locator: Locator) {
  return locator.evaluate(node => {
    const rect = node.getBoundingClientRect()
    return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`workspace hover actions leave its pin and count visible (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const group = workspace(page)
    const actions = group.getByRole('button', { name: 'Actions for HarnessDesk', exact: true })
    await group.hover()
    await actions.click()
    await page.getByRole('menuitem', { name: 'Pin to top', exact: true }).click()
    const pin = group.locator('[class*="groupPin_"]')
    await expect(pin).toBeVisible()

    for (const width of [260, 200, 480]) {
      await setWidth(page, width)
      // Neither metadata nor title should jump when hover controls appear.
      await page.mouse.move(1400, 0)
      await group.getByRole('button').first().blur()
      const before = await bounds(pin)
      await group.hover()
      const add = group.getByRole('button', { name: 'New session in HarnessDesk', exact: true })
      await expect(add).toBeVisible()
      if (width === 260) {
        await group.screenshot({ path: testInfo.outputPath('workspace-hover.png') })
        await testInfo.attach('workspace-geometry', {
          body: JSON.stringify({ pin: await bounds(pin), count: await bounds(group.locator('[class*="groupCount_"]')), add: await bounds(add), actions: await bounds(actions) }),
          contentType: 'application/json',
        })
      }
      // A resting row keeps its whole width — no room is held for a control
      // that is not drawn — and the marks at its end step aside when the ⋯
      // arrives, which is the moment they would otherwise sit under it.
      // It never moves right and never changes line; whether it moves left at
      // all depends on whether the row was full, which the wide case is not.
      const after = await settled(pin)
      expect(after.left).toBeLessThanOrEqual(before.left)
      expect(after.top).toBe(before.top)
      expect(after.right).toBeLessThanOrEqual((await settled(add)).left)
      expect((await settled(group.locator('[class*="groupCount_"]'))).right).toBeLessThanOrEqual((await settled(add)).left)
      expect(await unobstructed(add)).toBe(true)
      expect(await unobstructed(actions)).toBe(true)
    }
    await actions.click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await expect(pin).toHaveCount(0)
  })

  for (const density of ['Compact', 'Comfortable'] as const) {
    test(`session hover actions leave checkout marks readable (${theme}, ${density})`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      await sidebar(page).getByRole('button', { name: 'How this list is shown', exact: true }).click()
      await page.getByRole('menuitemradio', { name: density, exact: true }).click()
      const label = 'Learn from every single tab of the settings screen'
      const row = sidebar(page).locator('[class*="rowWrap_"]').filter({
        has: page.locator(`button[aria-label="Actions for ${label}"]`),
      })
      const open = row.locator('button[data-density]')
      const action = row.getByRole('button', { name: `Actions for ${label}`, exact: true })
      const branch = row.getByRole('img', { name: 'Worktree chore/settings-audit', exact: true })
      const gone = row.getByRole('img', { name: /^Folder is gone/ })
      await expect(gone).toBeVisible()

      for (const width of [260, 200, 480]) {
        await setWidth(page, width)
        await row.scrollIntoViewIfNeeded()
        await page.mouse.move(1400, 0)
        await open.blur()
        const before = await bounds(branch)
        await row.hover()
        await expect(action).toBeVisible()
        if (width === 260) {
          await row.screenshot({ path: testInfo.outputPath('session-hover.png') })
          await testInfo.attach('session-geometry', {
            body: JSON.stringify({ branch: await bounds(branch), gone: await bounds(gone), action: await bounds(action), font: await open.evaluate(node => getComputedStyle(node).fontSize) }),
            contentType: 'application/json',
          })
        }
        // Same trade as the workspace head above: the marks step aside for the
        // ⋯ rather than being covered by it, and they keep their line.
        const moved = await settled(branch)
        expect(moved.left).toBeLessThanOrEqual(before.left)
        expect(moved.top).toBe(before.top)
        for (const mark of [branch, gone]) {
          expect((await settled(mark)).right).toBeLessThanOrEqual((await settled(action)).left)
          expect(await unobstructed(mark)).toBe(true)
        }
        expect(await unobstructed(action)).toBe(true)
        await action.click()
        await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
      }
      // Focusing the row must also expose its action to the keyboard.
      await page.mouse.move(1400, 0)
      await open.focus()
      await expect(action).toBeVisible()
      await action.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible()
    })
  }
}

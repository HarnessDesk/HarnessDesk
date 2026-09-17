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
      expect(await bounds(pin)).toEqual(before)
      expect((await bounds(pin)).right).toBeLessThanOrEqual((await bounds(add)).left)
      expect((await bounds(group.locator('[class*="groupCount_"]'))).right).toBeLessThanOrEqual((await bounds(add)).left)
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
        expect(await bounds(branch)).toEqual(before)
        for (const mark of [branch, gone]) {
          expect((await bounds(mark)).right).toBeLessThanOrEqual((await bounds(action)).left)
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

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
 * Read a box once nothing on the page is moving it.
 *
 * The suite runs with motion reduced, and app.css answers that with a 0.01ms
 * `transition-duration` on every element. `all` is the initial
 * `transition-property`, so every property of every element now transitions:
 * the padding a hovered row takes to make room for its ⋯, and the width
 * `setWidth` hands the column, both arrive as CSS transitions — created at
 * once, but not started until the next animation frame, and held at their
 * old value until then. A runner that goes a while without a frame holds
 * them there, so reads that agree prove nothing: in CI run 35328916230 every
 * read of the mark for 165ms after the hover agreed on where it stood before
 * the hover, 2px under the ⋯ — 459 against 457, the resting row's geometry
 * at 480px to the pixel.
 *
 * So wait for the transitions themselves. `getAnimations()` flushes style
 * before it answers, which lists the one the last change has only just made;
 * ask again after each batch finishes, since one can hand over to the next.
 */
async function settled(locator: Locator) {
  return locator.evaluate(async node => {
    const deadline = performance.now() + 10_000
    for (;;) {
      // Paused and endless animations never finish; only the rest can settle.
      const moving = document.getAnimations().filter(animation =>
        animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity)
      if (moving.length === 0) break
      if (performance.now() > deadline) {
        const names = moving.map(animation => (animation as CSSTransition).transitionProperty ?? (animation as CSSAnimation).animationName)
        throw new Error(`still moving after 10s: ${names.join(', ')}`)
      }
      // A transition the next change interrupts rejects; the next pass meets its successor.
      await Promise.all(moving.map(animation => animation.finished.catch(() => undefined)))
    }
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
      const before = await settled(pin)
      await group.hover()
      const add = group.getByRole('button', { name: 'New session in HarnessDesk', exact: true })
      await expect(add).toBeVisible()
      const after = await settled(pin)
      if (width === 260) {
        await group.screenshot({ path: testInfo.outputPath('workspace-hover.png') })
        await testInfo.attach('workspace-geometry', {
          body: JSON.stringify({ pin: after, count: await settled(group.locator('[class*="groupCount_"]')), add: await settled(add), actions: await settled(actions) }),
          contentType: 'application/json',
        })
      }
      // A resting row keeps its whole width — no room is held for a control
      // that is not drawn — and the marks at its end step aside when the ⋯
      // arrives, which is the moment they would otherwise sit under it.
      // It never moves right and never changes line; whether it moves left at
      // all depends on whether the row was full, which the wide case is not.
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
        const before = await settled(branch)
        await row.hover()
        await expect(action).toBeVisible()
        const moved = await settled(branch)
        if (width === 260) {
          await row.screenshot({ path: testInfo.outputPath('session-hover.png') })
          await testInfo.attach('session-geometry', {
            body: JSON.stringify({ branch: moved, gone: await settled(gone), action: await settled(action), font: await open.evaluate(node => getComputedStyle(node).fontSize) }),
            contentType: 'application/json',
          })
        }
        // Same trade as the workspace head above: the marks step aside for the
        // ⋯ rather than being covered by it, and they keep their line.
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

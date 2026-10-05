import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`Page Up and Page Down scroll only the Git history (${theme})`, async ({ page }) => {
    await page.goto(`/preview.html?theme=${theme}`)
    await page.locator('select').filter({ has: page.locator('option[value="git tools"]') }).selectOption('git tools')
    const grid = page.locator('[data-frame-id="tools-git"]').getByRole('grid', { name: 'Commits' })
    const list = grid.getByRole('rowgroup')
    await expect(grid.locator('[role="row"][aria-selected]')).toHaveCount(9)
    // The same windowed log in a short pane, so its real rowgroup overflows.
    await list.evaluate(el => { el.style.flex = 'none'; el.style.height = '78px' })
    await grid.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const active = await grid.getAttribute('aria-activedescendant')
    const pageTop = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('PageDown')
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(78)
    await expect(grid).toHaveAttribute('aria-activedescendant', active!)
    await expect(grid.locator('[aria-selected="true"]')).toHaveAttribute('id', active!)
    expect(await page.evaluate(() => window.scrollY)).toBe(pageTop)
    await page.keyboard.press('PageUp')
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(0)
    await page.keyboard.press('PageUp')
    expect(await list.evaluate(el => el.scrollTop)).toBe(0)
    for (let index = 0; index < 4; index++) await page.keyboard.press('PageDown')
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(156)
    await expect(grid).toBeFocused()
    // Exercise Chromium's implicit scroll-container Tab stop on the real overflow.
    const frame = page.locator('[data-frame-id="tools-git"]')
    let leftPane = false
    for (let index = 0; index < 30; index++) {
      await page.keyboard.press('Tab')
      expect(await list.evaluate(el => document.activeElement === el)).toBe(false)
      leftPane = await frame.evaluate(el => !el.contains(document.activeElement))
      if (leftPane) break
    }
    expect(leftPane).toBe(true)
  })

  test(`the Git and Library logs keep their table geometry (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?theme=${theme}`)
    await page.locator('select').filter({ has: page.locator('option[value="git tools"]') }).selectOption('git tools')
    const frame = page.locator('[data-frame-id="tools-git"]')
    const grid = frame.getByRole('grid', { name: 'Commits' })
    const header = grid.locator('[data-slot="table-header"]')
    const rows = grid.locator('[role="row"][aria-selected]')
    await expect(rows).toHaveCount(9)
    expect(await header.evaluate(el => el.getBoundingClientRect().height)).toBe(28)
    expect(await rows.first().evaluate(el => el.getBoundingClientRect().height)).toBe(26)
    expect(await header.getByRole('columnheader').first().evaluate(el => {
      const style = getComputedStyle(el.querySelector('[data-slot="text"]')!)
      return [style.fontSize, style.fontWeight]
    })).toEqual(['12px', '500'])
    expect(await rows.first().evaluate(el => getComputedStyle(el).borderBottomWidth)).toBe('1px')
    await rows.nth(1).click()
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
    expect(await rows.nth(1).evaluate(el => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--hd-selected)'
      el.append(probe)
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(probe).backgroundColor
      probe.remove()
      return matches
    })).toBe(true)
    expect(await rows.first().locator('[data-role="row"]').evaluate(el => getComputedStyle(el).fontSize)).toBe('13px')
    const merge = rows.locator('[data-role="row"]').filter({ hasText: "Merge branch" })
    expect(await merge.evaluate(el => getComputedStyle(el).color)).toBe(await rows.first().locator('[data-role="meta"]').last().evaluate(el => getComputedStyle(el).color))
    const chips = rows.locator('[data-slot="chip"]')
    for (const chip of await chips.all()) {
      expect(await chip.evaluate(el => [el.getBoundingClientRect().height, getComputedStyle(el).borderRadius])).toEqual([18, '5px'])
    }
    await expect(frame.getByText('Remotes · 2', { exact: true })).toBeVisible()
    await grid.focus()
    await page.keyboard.press('End')
    await expect(grid).toHaveAttribute('aria-activedescendant', /git-commit-/)
    await page.keyboard.press('Enter')
    await expect(rows.last()).toHaveAttribute('aria-selected', 'true')

    const library = page.locator('[data-frame-id="coverage-library"]')
    await expect(library.getByRole('listitem')).toHaveCount(2)
    await expect(library.locator('[data-slot="separator"]')).toHaveCount(0)
    const item = library.getByRole('listitem').first()
    expect(await item.evaluate(el => getComputedStyle(el.firstElementChild!).alignItems)).toBe('center')
    expect(await item.locator('[data-slot="text"]').first().evaluate(el => getComputedStyle(el).fontVariantNumeric)).toBe('tabular-nums')
    expect(await item.getByRole('button', { name: 'Restore…' }).getAttribute('data-variant')).toBe('outline')
    await page.locator('select').filter({ has: page.locator('option[value="worktree manager"]') }).selectOption('worktree manager')
    const dialog = page.getByRole('dialog', { name: 'Worktrees', exact: true })
    for (const label of ['Here', 'Main checkout', 'Session', 'Locked', '2 uncommitted']) {
      await expect(dialog.getByText(label, { exact: true })).toBeVisible()
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [480, 600, 760]) {
    test(`long local and remote refs leave room for the subject at ${width}px (${theme})`, async ({ page }) => {
      await page.goto(`/preview.html?theme=${theme}`)
      await page.locator('select').filter({ has: page.locator('option[value="git tools"]') }).selectOption('git tools')
      const frame = page.locator('[data-frame-id="tools-git"]')
      await frame.evaluate((el, width) => { el.style.width = `${width}px` }, width)
      const row = frame.getByRole('grid', { name: 'Commits' }).locator('[role="row"][aria-selected]').first()
      await expect(row.locator('[data-slot="chip"]')).toHaveCount(2)
      await expect.poll(() => row.evaluate(el => {
        const subject = el.querySelector('[role="gridcell"]:has([data-role="row"])')!.getBoundingClientRect()
        const text = el.querySelector('[data-role="row"]')!.getBoundingClientRect()
        const chips = [...el.querySelectorAll('[data-slot="chip"]')].map(chip => chip.getBoundingClientRect())
        return text.width > 0 && chips.every(chip => chip.left >= subject.left && chip.right <= subject.right)
      })).toBe(true)
    })
  }
}

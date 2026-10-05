import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`Library quiet state sentences stay inside their column in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('library')
    const sheet = page.locator('[data-frame-id="settings-sheet"]')
    await expect(sheet.getByText('Not read yet by Gamma', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Off in Alpha', { exact: true })).toBeVisible()
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      for (const state of ['Ready', 'Off in Alpha', 'Not read yet by Gamma']) {
        const reading = sheet.getByText(state, { exact: true }).first()
        const bounds = await reading.evaluate(node => {
          const cell = node.closest('td')!
          const rect = cell.getBoundingClientRect()
          const style = getComputedStyle(cell)
          const range = document.createRange()
          range.selectNodeContents(node)
          return {
            left: rect.left + parseFloat(style.paddingLeft),
            right: rect.right - parseFloat(style.paddingRight),
            text: [...range.getClientRects()].map(line => ({ left: line.left, right: line.right })),
          }
        })
        for (const line of bounds.text) {
          expect(line.left, state).toBeGreaterThanOrEqual(bounds.left - 1)
          expect(line.right, state).toBeLessThanOrEqual(bounds.right + 1)
        }
      }
    }
  })

  test(`capability lists keep the table anatomy in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const library = page.locator('[data-frame-id="settings-library"]')
    await expect(library.locator('thead th')).toHaveText(['Skill', 'State', 'Loaded by'])
    const first = library.locator('tbody tr').first()
    await expect(first.locator('[data-shape="face"]')).toHaveCount(1)
    const copy = await first.evaluate(row => {
      const name = row.querySelector('[data-type="subject"]') ?? row.querySelector('button span span')!
      const description = row.querySelector('button')!.lastElementChild!
      const face = row.querySelector('[data-shape="face"]')!
      return { face: face.getBoundingClientRect().width, separateLines: description.getBoundingClientRect().top >= name.getBoundingClientRect().bottom }
    })
    expect(copy.face).toBe(20)
    expect(copy.separateLines).toBe(true)
    await expect(library.locator('[data-slot="row-mark"]')).toHaveCount(0)

    const sheet = page.locator('[data-frame-id="settings-sheet"]')
    const dial = page.getByRole('combobox', { name: 'settings page', exact: true })
    await dial.selectOption('plugins')
    const pluginGeometry = await sheet.locator('[data-slot="row-title"]').evaluateAll(titles => titles.map(title => {
      const row = title.closest('button')!
      return { title: title.textContent, height: row.getBoundingClientRect().height, face: Boolean(row.querySelector('[data-slot="row-mark"]')) }
    }))
    expect(pluginGeometry.map(row => row.height)).toEqual(Array(12).fill(44))
    expect(pluginGeometry.every(row => !row.face)).toBe(true)
    expect(pluginGeometry[2]?.title).toBe('Plugin 2')
    expect(pluginGeometry[10]?.title).toBe('Plugin 10')

    await dial.selectOption('skills')
    await expect(sheet.locator('[data-slot="row-mark"]')).toHaveCount(2) // hooks, no repeated skill faces
    const description = sheet.locator('[data-slot="row-desc"]').nth(1)
    expect(await description.locator('span').evaluate(node => getComputedStyle(node).webkitLineClamp)).toBe('3')
    await expect(sheet.getByText('Hooks · 2', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Trusted', { exact: true })).toBeVisible()
    await sheet.getByRole('button', { name: /Playwright/ }).click()
    await expect(sheet.getByText('Always on', { exact: true })).toBeVisible()

    await dial.selectOption('models')
    await expect(sheet.getByText('Always thinks', { exact: true })).toBeVisible()
    await expect(sheet.locator('[data-slot="row-desc"]').first()).toContainText('Low, Medium, High, Extra high')
    await expect(sheet.getByText('Not available', { exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Remove…', exact: true })).toHaveCount(0)
    await sheet.locator('button[title="More actions for Team proxy"]').click()
    await page.getByRole('menuitem', { name: 'Remove…', exact: true }).click()
    await expect(sheet.getByRole('heading', { name: 'Remove Team proxy?', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    await dial.selectOption('extensions')
    await expect(sheet.getByText('Reference', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Off', { exact: true })).toBeVisible()
    await sheet.getByRole('tab', { name: 'MCP servers', exact: true }).click()
    await expect(sheet.getByText('2 tools · 3 resources', { exact: true })).toBeVisible()
    await expect(sheet.getByText('1 tool · 0 resources', { exact: true })).toBeVisible()
    await expect(sheet.getByText('1 tool · 1 resource', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Authorised', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Signed in', { exact: true })).toBeVisible()

    await dial.selectOption('shortcuts')
    const tiles = sheet.locator('[data-slot="row"]').filter({ hasText: 'Focus tile' })
    await expect(tiles).toHaveCount(1)
    await expect(tiles.locator('kbd')).toHaveText(['⌥', '⌘', '1 – 4'])
  })
}


for (const theme of ['light', 'dark'] as const) {
  test(`Library warnings and four loading faces stay whole at narrow widths in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('library')
    const sheet = page.locator('[data-frame-id="settings-sheet"]')
    for (const width of [900, 720]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(sheet.getByText('Shared review', { exact: true })).toBeVisible()
      const readings = await sheet.locator('tbody tr').evaluateAll(rows => rows.map(row => {
        const cells = [...row.querySelectorAll('td')]
        return cells.slice(1).map(cell => {
          const css = getComputedStyle(cell), rect = cell.getBoundingClientRect()
          const content = [...cell.querySelectorAll('[data-slot="chip"], [data-slot="chip"] span, [data-shape="face"], svg')].map(node => {
            const box = node.getBoundingClientRect()
            return { left: box.left, right: box.right, clipped: node.scrollWidth > node.clientWidth }
          })
          return { label: cell.textContent, left: rect.left + parseFloat(css.paddingLeft), right: rect.right - parseFloat(css.paddingRight), content }
        })
      }))
      for (const cells of readings) for (const cell of cells) for (const box of cell.content) {
        expect(box.clipped, cell.label ?? '').toBe(false)
        expect(box.left).toBeGreaterThanOrEqual(cell.left - 1)
        expect(box.right).toBeLessThanOrEqual(cell.right + 1)
      }
      await expect(sheet.locator('tbody tr[data-problem]')).toHaveCount(0)
      const loaded = sheet.locator('tbody tr').filter({ hasText: 'Shared review' })
      await expect(loaded.locator('[data-shape="face"]')).toHaveCount(4)
      const table = sheet.locator('table')
      expect(await table.evaluate(node => node.parentElement!.scrollWidth <= node.parentElement!.clientWidth)).toBe(true)
      const opener = loaded.locator('button').first()
      await opener.hover()
      expect(await opener.evaluate(node => getComputedStyle(node).textDecorationLine)).toBe('none')
      expect(await opener.evaluate(node => node.closest('tr')!.hasAttribute('data-problem'))).toBe(false)
    }
  })

  test(`mixed skills keep fallback marks small and long descriptions bounded in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 })
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('skills')
    const sheet = page.locator('[data-frame-id="settings-sheet"]')
    await expect(sheet.locator('[data-slot="row-mark"]')).toHaveCount(6) // four skills, two hooks
    for (const name of ['Brainstorming', 'Deploy Notes']) {
      const row = sheet.getByRole('button', { name: new RegExp(name) })
      expect(await row.locator('[data-slot="row-mark"] svg').evaluate(node => node.getBoundingClientRect().width)).toBe(15)
    }
    const row = sheet.getByRole('button', { name: /Brainstorming/ })
    const paragraph = row.locator('[data-slot="row-desc"] span')
    expect(await paragraph.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(60)
    await row.click()
    const full = sheet.getByText('Explore requirements, constraints and the design before implementation. '.repeat(12).trim(), { exact: true })
    await expect(full).toBeVisible()
    expect(await full.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(60)
  })
}

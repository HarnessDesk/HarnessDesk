import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
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
    expect(await description.evaluate(node => getComputedStyle(node).webkitLineClamp)).toBe('none')
    await expect(sheet.getByText('Hooks · 2', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Trusted', { exact: true })).toBeVisible()

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
    await expect(sheet.getByText('Authorised', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Signed in', { exact: true })).toBeVisible()

    await dial.selectOption('shortcuts')
    const tiles = sheet.locator('[data-slot="row"]').filter({ hasText: 'Focus tile' })
    await expect(tiles).toHaveCount(1)
    await expect(tiles.locator('kbd')).toHaveText(['⌥', '⌘', '1 – 4'])
  })
}

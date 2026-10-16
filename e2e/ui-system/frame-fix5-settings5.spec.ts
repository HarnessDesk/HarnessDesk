import { expect, test, type Page } from '@playwright/test'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const widths = [1280, 720] as const
const themes = ['light', 'dark'] as const

const openSettings = async (
  page: Page,
  section: string,
  theme: 'light' | 'dark',
  width: number,
): Promise<void> => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?frame-wall=settings&frame-section=${section}&frame-settings-round4=1&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
}

for (const theme of themes) for (const width of widths) {
  test(`R11.15 ceilings show one selected level and a status chip at ${width} in ${theme}`, async ({ page }) => {
    await openSettings(page, 'permissions', theme, width)
    const section = page.locator('section[aria-label="Ceilings"]')
    await section.getByRole('button', { name: /^Other runtimes · / }).click()
    const rows = section.locator('[data-slot="rows"] > [data-slot="row"]')
    await expect(rows).toHaveCount(12)

    for (const row of await rows.all()) {
      await expect(row.getByRole('radiogroup')).toHaveCount(1)
      await expect(row.getByRole('radio')).toHaveCount(4)
      await expect(row.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1)
      await expect(row.locator('[data-slot="chip"]')).toHaveCount(1)
      await expect(row.locator('[data-slot="chip"]')).toContainText(/Enforced|Asked/)
    }

    const head = section.locator('[data-slot="section-head"]')
    const geometry = await head.evaluate(element => {
      const name = element.querySelector('[data-section-name]')!.getBoundingClientRect()
      const description = element.querySelector('[data-slot="section-description"]')!.getBoundingClientRect()
      return { nameBottom: name.bottom, descriptionTop: description.top }
    })
    expect(geometry.descriptionTop).toBeGreaterThanOrEqual(geometry.nameBottom)
  })

  test(`R11.16 runtimes put attention and ready groups before process cost at ${width} in ${theme}`, async ({ page }) => {
    await openSettings(page, 'runtimes', theme, width)
    await expect(page.getByRole('heading', { name: 'Needs attention · 1' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ready · 11' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Process resources' })).toBeVisible()
    await expect(page.getByText('Signed out', { exact: true })).toBeVisible()

    const headings = await page.locator('[data-slot="section-name"]').allTextContents()
    expect(headings.indexOf('Needs attention · 1')).toBeLessThan(headings.indexOf('Ready · 11'))
    expect(headings.indexOf('Ready · 11')).toBeLessThan(headings.indexOf('Process resources'))
  })

  test(`R11.17 notifications state what the muted row contains at ${width} in ${theme}`, async ({ page }) => {
    await openSettings(page, 'notifications', theme, width)
    const muted = page.locator('[data-slot="row"]').filter({ hasText: 'Muted messages' })
    await expect(muted).toContainText('None muted')
  })

  test(`R11.18 empty history leads with import choices and hides unused filters at ${width} in ${theme}`, async ({ page }) => {
    await openSettings(page, 'history', theme, width)
    const empty = page.locator('[data-slot="empty-state"]').filter({ hasText: 'Nothing imported yet' })
    await expect(empty).toBeVisible()
    await expect(empty.getByRole('button')).toHaveCount(6)
    await expect(page.getByRole('searchbox', { name: 'Search history titles' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Project' })).toHaveCount(0)
    await expect(page.getByRole('switch', { name: 'Show hidden' })).toHaveCount(0)
  })

  test(`R11.19 appearance description covers both interface choices at ${width} in ${theme}`, async ({ page }) => {
    await openSettings(page, 'appearance', theme, width)
    const interfaceRow = page.locator('[data-slot="row"]').filter({ hasText: 'Interface' })
    await expect(interfaceRow).toContainText('Desk keeps controls compact; Studio reads as a dashboard with filled selection and taller controls.')
  })

  test(`R11.20 file search results are in All and their own tab at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?frame-wall=conversation&frame-palette-files=1&theme=${theme}`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    await page.evaluate(async () => { await document.fonts.ready })

    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const search = palette.getByRole('searchbox')
    await expect(search).toHaveAttribute('placeholder', 'Search sessions, files, teams, agents, commands…')
    await search.fill('sweep-index')
    await expect(palette.getByRole('tab', { name: 'Files' })).toBeVisible()
    await expect(palette.getByRole('listbox', { name: 'All results' })).toContainText('src/sweep-index.ts')
    await palette.getByRole('tab', { name: 'Files' }).click()
    await expect(palette.getByRole('listbox', { name: 'Files results' })).toContainText('src/sweep-index.ts')
  })
}

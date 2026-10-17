import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// A separate fixture entry keeps the shared preview frame and its stores untouched.
const open = async (page: Page, theme: 'light' | 'dark', query = '') => {
  await page.route('**/preview.html?first-run*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('/src/preview/main.tsx', '/src/preview/first-run.tsx') })
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?first-run${query}`)
  await expect(page.getByText('What should we build?', { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

for (const theme of ['light', 'dark'] as const) {
  test(`first-run preview frame in ${theme}`, async ({ page }) => {
    await open(page, theme)
    if (process.env.FIRST_RUN_FRAMES_DIR) {
      if (process.env.FIRST_RUN_FRAME_PREFIX !== 'before') await expect(page.getByRole('button', { name: 'Add Beta', exact: true })).toBeVisible()
      await page.screenshot({ path: path.join(process.env.FIRST_RUN_FRAMES_DIR, `${process.env.FIRST_RUN_FRAME_PREFIX ?? 'after'}-${theme}.png`) })
      await page.setViewportSize({ width: 1600, height: 900 })
      await page.screenshot({ path: path.join(process.env.FIRST_RUN_FRAMES_DIR, `${process.env.FIRST_RUN_FRAME_PREFIX ?? 'after'}-1600-${theme}.png`) })
    }
  })

  test(`installed runtimes add in one click and reach the composer in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const offer = page.getByRole('group', { name: 'Installed on this Mac' })
    await expect(offer).toContainText('Beta')
    await expect(offer).toContainText('Gamma')
    await offer.getByRole('button', { name: 'Add Beta', exact: true }).click()
    await expect(offer).not.toContainText('Beta')
    await expect(page.getByText(/Sessions you start in/)).toHaveCount(0)
    await offer.getByRole('button', { name: 'Add Gamma', exact: true }).click()
    await expect(offer).toHaveCount(0)
    // The runtime chooser carries its question in its title; folded, the title also names the runtime.
    const chooser = page.getByRole('button').and(page.getByTitle(/Which runtime starts this conversation$/))
    await expect(chooser).toHaveAccessibleName(/^Alpha/)
    await expect(chooser).toBeEnabled()
    await chooser.click()
    await expect(page.getByRole('menuitemradio', { name: /Beta/ })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /Gamma/ })).toBeVisible()
    await page.getByRole('menuitemradio', { name: /Beta/ }).click()
    await expect(chooser).toHaveAccessibleName(/^Beta/)
  })

  test(`nothing installed leaves no offer in ${theme}`, async ({ page }) => {
    await open(page, theme, '&none')
    await expect(page.getByRole('group', { name: 'Installed on this Mac' })).toHaveCount(0)
  })
}

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 1600]) {
  test(`folderless drafts send and choose a folder without a height jump at ${width}px in ${theme}`, async ({ page }) => {
    await open(page, theme)
    await page.setViewportSize({ width, height: 900 })
    const text = page.locator('[data-slot="composer-text"]')
    const composer = page.locator('[data-slot="composer"]')
    const send = page.locator('[data-slot="composer-send"]')
    const folder = page.getByRole('button', { name: 'No folder', exact: true })
    await expect(text).toBeEnabled()
    await expect(text).toBeFocused()
    await expect(folder).toBeVisible()
    await expect(page.getByText('No sessions yet.', { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-left-projects-head]')).toBeVisible()
    await expect(page.getByText(/CLI|editor extension|history comes from/)).toHaveCount(0)
    await text.fill('Build the checkout task')
    await expect(send).toBeEnabled()
    const before = (await composer.boundingBox())!.height
    const centers = await page.locator('[data-slot="composer-tools"] [data-composer-track] button').evaluateAll(nodes => nodes.flatMap(node => {
      const box = node.getBoundingClientRect()
      return box.height ? [box.y + box.height / 2] : []
    }))
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
    await send.click()
    const picker = page.getByRole('dialog', { name: 'Choose a project folder' })
    await expect(picker).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-sent-folder', '')
    await expect(page.locator('html')).toHaveAttribute('data-sent-text', 'Build the checkout task')
    await expect(text).toHaveValue('')
    await text.fill('Build the checkout task')
    await folder.click()
    await page.getByRole('menuitem', { name: 'Choose folder…', exact: true }).click()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(text).toHaveValue('Build the checkout task')
    await folder.click()
    await page.getByRole('menuitem', { name: 'Choose folder…', exact: true }).click()
    await picker.getByRole('button', { name: 'Open “storefront”', exact: true }).click()
    await send.click()
    await expect(page.locator('html')).toHaveAttribute('data-sent-folder', '/work/storefront')
    await expect(page.locator('html')).toHaveAttribute('data-sent-text', 'Build the checkout task')
    await expect(text).toHaveValue('')
    await expect(page.getByRole('button', { name: 'storefront', exact: true }).and(page.getByTitle('/work/storefront', { exact: true }))).toBeVisible()
    expect((await composer.boundingBox())!.height).toBe(before)
    const chosenCenters = await page.locator('[data-slot="composer-tools"] [data-composer-track] button').evaluateAll(nodes => nodes.flatMap(node => {
      const box = node.getBoundingClientRect()
      return box.height ? [box.y + box.height / 2] : []
    }))
    expect(Math.max(...chosenCenters) - Math.min(...chosenCenters)).toBeLessThanOrEqual(1)
    await expect(page.getByText('No sessions yet.', { exact: true })).toHaveCount(0)
    await expect(page.getByText('No conversations yet — ⌘N starts one here.', { exact: true })).toBeVisible()
    await expect(page.locator('[data-left-projects-head] [data-left-group-text]')).toHaveText('Projects')
    await expect(page.locator('[data-left-projects-head] [data-left-group-text]')).toBeVisible()
    await expect(page.locator('[aria-label="Conversation facts"] [title="/work/storefront"]')).toHaveText('storefront')
    await expect(page.getByText('Permission level not reported for this draft.', { exact: true })).toHaveCount(0)
    if (process.env.FIRST_RUN_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.FIRST_RUN_FRAMES_DIR, `chosen-${width}-${theme}.png`) })
  })
}

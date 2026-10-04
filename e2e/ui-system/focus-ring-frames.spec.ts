import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'
import { mountFocusFixture } from './focus-ring-fixture'

const phase = process.env.FOCUS_RING_PHASE ?? 'after'

for (const theme of ['light', 'dark'] as const) {
  test(`focus frames in ${theme}`, async ({ page }, testInfo) => {
    const folder = process.env.FOCUS_RING_FRAMES ?? testInfo.outputPath('frames')
    await page.emulateMedia({ colorScheme: theme })
    await mountFocusFixture(page)
    await page.evaluate((theme) => {
      const preview = (window as any).__hdPreview
      preview.store.patch({ theme })
    }, theme)
    await mkdir(folder, { recursive: true })
    const safe = async () => expect(textReasons(await page.evaluate(COLLECT), { user: USER })).toEqual([])
    const sidebar = page.locator('[data-frame-id="sidebar-column"]')
    const row = sidebar.getByRole('button', { name: 'Other projects', exact: true })
    await row.click()
    await expect(row).toBeFocused()
    await safe()
    await sidebar.screenshot({ path: `${folder}/${phase}-sidebar-pointer-${theme}.png` })
    if (phase === 'after') {
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await expect(row).toBeFocused()
      await safe()
      await sidebar.screenshot({ path: `${folder}/after-sidebar-keyboard-${theme}.png` })
    }
    const label = 'Draft the 2.5 migration notes after reviewing the sidebar target behavior'
    const conversation = sidebar.locator('[data-region="session-row"] [data-slot="sidebar-menu-item"]')
      .filter({ has: page.getByRole('button', { name: `Actions for ${label}`, exact: true }) })
      .locator('[data-slot="sidebar-menu-button"]')
    await conversation.hover()
    await sidebar.getByRole('button', { name: `Actions for ${label}`, exact: true }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(conversation).toBeFocused()
    await page.mouse.move(1400, 0)
    await safe()
    await sidebar.screenshot({ path: `${folder}/${phase}-sidebar-restored-${theme}.png` })
    const settings = page.getByRole('region', { name: 'Focus settings' })
    await settings.getByRole('textbox', { name: 'Your name' }).click()
    await safe()
    await settings.screenshot({ path: `${folder}/${phase}-settings-${theme}.png` })
    await page.getByRole('button', { name: 'Open palette', exact: true }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('searchbox')).toBeFocused()
    await safe()
    await palette.screenshot({ path: `${folder}/${phase}-palette-${theme}.png` })
  })
}

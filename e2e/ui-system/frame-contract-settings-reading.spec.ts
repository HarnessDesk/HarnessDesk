import { measureDestination } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'
import { FRAME } from '../../packages/ui/src/design/frame'

useFrameContractEvidence()


for (const theme of ['light', 'dark'] as const) {
  for (const width of [2200, 1440, 1100, 720]) {
    for (const section of ['general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'history', 'storage', 'archive', 'runtimes', 'models', 'skills', 'extensions', 'permissions', 'browser']) {
      test(`E2 Settings ${section} is reading at ${width} in ${theme}`, async ({ page }) => {
        await measureDestination(page, `frame-wall=settings&frame-section=${section}`, 'reading', theme, width, { more: 'absent' })
        await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
        await expect(page.locator('[data-left-column]:visible')).toHaveCount(width < 1000 ? 0 : 1)
      })
    }
  }
  test(`E2 keyboard history keeps work retained and the project terminal visible in Settings in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=navigation&frame-terminal=1', theme)
    const work = page.locator('[data-slot="retained-work"]')
    const transcript = work.locator('[data-transcript]').first()
    const pane = page.locator('[data-frame-region="right"]')
    const terminal = pane.locator('[data-terminal-id]').first()
    await expect(transcript).toBeVisible()
    await transcript.evaluate(el => { el.dataset.retentionWitness = 'transcript'; el.scrollTop = 120 })
    const scroll = await transcript.evaluate(el => el.scrollTop)
    await terminal.evaluate(el => { el.dataset.retentionWitness = 'terminal' })
    const terminalId = await terminal.getAttribute('data-terminal-id')
    const paneBox = (await pane.boundingBox())!
    expect(paneBox.y).toBe(0)
    expect(paneBox.height).toBe(900)
    expect((await pane.locator('[data-work-pane-header]').boundingBox())!.height).toBe(FRAME.bar.height)
    const height = paneBox.height
    await page.keyboard.press('Meta+,')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await expect(work).toBeHidden()
    await expect(work).toHaveAttribute('inert', '')
    await expect(terminal).toBeVisible()
    await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-right-open', 'true')
    await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-bottom-open', 'false')
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal).toHaveAttribute('data-retention-witness', 'terminal')
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection',{detail:'reconnecting'})))
    await expect(page.locator('[data-shell-host="main-notice"]')).toContainText('Reconnecting to HarnessDesk.')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection',{detail:'open'})))
    await expect(page.locator('[data-shell-host="main-notice"] [role="status"]')).toHaveCount(0)
    await page.keyboard.press('Meta+]')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.keyboard.press('Meta+[')
    await expect(work).toBeVisible()
    await expect(transcript).toHaveAttribute('data-retention-witness', 'transcript')
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(scroll)
    await expect(terminal).toBeVisible()
    expect(await pane.evaluate(node => node.getBoundingClientRect().height)).toBe(height)
    await page.keyboard.press('Meta+]')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    // Focus in Settings keeps Escape with the page, beside the visible terminal.
    await expect(terminal).toBeVisible()
    await page.getByRole('searchbox', { name: 'Search settings' }).focus()
    await page.keyboard.press('Escape')
    await expect(work).toBeVisible()
    await expect(terminal).toHaveAttribute('data-retention-witness', 'terminal')
    await expect(terminal).toBeVisible()
    expect(await pane.evaluate(node => node.getBoundingClientRect().height)).toBe(height)
  })
}

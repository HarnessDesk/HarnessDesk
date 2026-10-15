import { expectTitleRoom } from './title-contract'
import { measureDestination, expectDestinationTab } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { selectFrameTab } from './frame-actions'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()


for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E1a navigation model preserves the work frame ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, width)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(page.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
  })
}
for (const theme of WALL_THEMES) {
  test(`E1b retained work shares the terminal and notice in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team&frame-terminal=1', theme)
    await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
    await expect(page.locator('[data-shell-host="main-notice"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="retained-work"] [data-shell-host="main-notice"]')).toHaveCount(0)
    const terminal = page.locator('[data-frame-region="bottom"] [data-terminal-id]').first()
    await expect(terminal).toBeVisible()
    await terminal.evaluate(node => { node.setAttribute('data-retention-witness', 'E1b') })
    await selectFrameTab(page, 'overview')
    await expect(terminal).toHaveAttribute('data-retention-witness', 'E1b')
  })
  for (const width of [1440,720]) {
    test(`E1b linked ancestors remain clickable at the final fold ${width} ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=topbar&frame-parents=1', theme, width)
      const bar = page.locator('[data-slot="top-bar"]')
      await expect(bar.locator('[data-topbar="place"] button')).toHaveCount(width===1440 ? 3 : 1)
      const labels = await bar.locator('[data-topbar="place"] button').allTextContents()
      expect(labels).toEqual(width===1440 ? ['Settings ›','Runtimes ›','Alpha ›'] : ['Alpha ›'])
      await expectTitleRoom(bar.locator('[data-topbar-title]'))
      await bar.getByRole('button',{name:'Alpha ›',exact:true}).click()
      const receipt = page.locator('[data-parent-choice]')
      await expect(receipt).toHaveAttribute('data-parent-choice','Alpha')
      if (width===720) {
        await expect(bar).toHaveAttribute('data-fold','3')
        await bar.getByRole('button',{name:'More',exact:true}).click()
        const menu = page.getByRole('menu')
        await expect(menu.getByRole('menuitem').first()).toHaveText('Start a conversation with this account')
        await menu.getByRole('menuitem',{name:'Settings',exact:true}).click()
      } else await bar.getByRole('button',{name:'Settings ›',exact:true}).click()
      await expect(receipt).toHaveAttribute('data-parent-choice','Settings')
    })
    test(`E1b bar controls resolve to no-drag ${width} ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=topbar&frame-parents=1', theme, width)
      const bar = page.locator('[data-slot="top-bar"]')
      expect(await bar.locator('..').evaluate(node=>getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('drag')
      const controls = bar.locator('button:visible, a:visible, input:visible, select:visible, textarea:visible, [role="tab"]:visible, [role="button"]:visible')
      const regions = await controls.evaluateAll(nodes=>nodes.map(node=>({label:node.getAttribute('aria-label')??node.textContent,region:getComputedStyle(node).getPropertyValue('-webkit-app-region')})))
      expect(regions.length).toBeGreaterThan(2)
      for (const control of regions) expect(control.region,control.label??'bar control').toBe('no-drag')
    })
  }
}

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E9 only the permanent shell frames a destination ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, 'frame-wall=plugins&frame-plugin-page=capabilities', 'wide', theme, width, { more: 'absent' })
    await expect(page.locator('[data-app-window-left-frame], [data-slot="app-window"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="page-head"], [data-slot="detail-head"]')).toHaveCount(0)
    await expectDestinationTab(page, 'capabilities')
  })
}

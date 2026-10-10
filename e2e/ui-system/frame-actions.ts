import { expect, type Locator, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
export interface FrameActions {
  readonly inspectFirst?: boolean
  readonly tab?: string
  readonly viewChoice?: string
  readonly tool?: 'details' | 'changes' | 'activity' | 'browser'
  readonly holdMessages?: boolean
}
export const settleFrameBar = async (bar: Locator): Promise<void> => {
  // The title keeps its floor during measurement too. Wait for the staged
  // fold to settle before choosing between its tab and menu spellings.
  await bar.evaluate(async node => {
    await document.fonts.ready
    let previous = ''
    let stable = 0
    while (stable < 4) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const current = `${node.getAttribute('data-fold')}:${node.getBoundingClientRect().width}`
      stable = current === previous ? stable + 1 : 0
      previous = current
    }
  })
}
export const selectFrameTab = async (page: Page, value: string): Promise<void> => {
  const bar = page.locator('[data-slot="top-bar"]:visible').first()
  await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
  await settleFrameBar(bar)
  const visibleTab = bar.locator(`[data-team-page="${value}"]:visible`)
  if (await visibleTab.count()) {
    await visibleTab.click()
    return
  }
  await page.getByTitle('Destination views', { exact: true }).click()
  const item = page.locator(`[role="menu"] [data-team-page="${value}"]:visible`)
  await expect(item).toHaveCount(1)
  await item.click()
}
export const applyFrameActions = async (page: Page, actions: FrameActions): Promise<void> => {
  if (actions.tab) await selectFrameTab(page, actions.tab)
  if (actions.viewChoice) {
    await page.getByRole('button', { name: 'View', exact: true }).click()
    const choice = page.getByRole('menuitem', { name: actions.viewChoice, exact: true })
      .or(page.getByRole('menuitemradio', { name: actions.viewChoice, exact: true }))
      .or(page.getByRole('switch').filter({ has: page.getByText(actions.viewChoice, { exact: true }) }))
    await expect(choice).toHaveCount(1)
    await choice.click()
    // Every view choice closes its menu. Capture the chosen view after that
    // transition; supplemental frames capture the menu as a separate state.
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  if (actions.inspectFirst) await page.locator('[data-slot="workbench-main"] [data-row][data-kind="card"]').first().click()
  if (actions.tool) await page.locator(`[data-work-tool="${actions.tool}"]`).click()
  if (actions.holdMessages) {
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Hold messages', exact: true }).click()
  }
}

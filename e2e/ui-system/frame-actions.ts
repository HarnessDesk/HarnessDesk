import { expect, type Page } from '@playwright/test'
export interface FrameActions {
  readonly inspectFirst?: boolean
  readonly tab?: string
  readonly viewChoice?: string
  readonly tool?: 'details' | 'changes' | 'activity' | 'browser'
  readonly holdMessages?: boolean
}
export const selectFrameTab = async (page: Page, value: string): Promise<void> => {
  const visibleTab = page.locator(`[data-slot="top-bar"] [data-team-page="${value}"]:visible`)
  if (await visibleTab.count()) {
    await visibleTab.first().click()
    return
  }
  // Existing Team headers remain until their shell migration in Task 4.
  const legacyTab = page.locator(`[data-slot="team-room"] [data-team-page="${value}"]:visible`)
  if (await legacyTab.count()) {
    await legacyTab.first().click()
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
      .or(page.getByRole('switch', { name: actions.viewChoice, exact: true }))
    await expect(choice).toHaveCount(1)
    await choice.click()
  }
  if (actions.inspectFirst) await page.locator('[data-slot="workbench-main"] [data-row][data-kind="card"]').first().click()
  if (actions.tool) await page.locator(`[data-work-tool="${actions.tool}"]`).click()
  if (actions.holdMessages) {
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Hold messages', exact: true }).click()
  }
}

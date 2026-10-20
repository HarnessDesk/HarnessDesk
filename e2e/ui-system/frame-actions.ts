import { expectTitleRoom } from './title-contract'
import { closeFloatingTeamRail, selectTeamDestination, toggleTeamRail } from './team-frame-actions'
import { expect, type Locator, type Page } from '@playwright/test'
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
export const pageChoiceFor = (value: string): { title: string; label: string } => {
  const choices: Record<string, { title: string; label: string }> = {
    skill: { title: 'Library sections', label: 'Skills' },
    mcp: { title: 'Library sections', label: 'MCP servers' },
    installed: { title: 'Plugin sections', label: 'Installed' },
    capabilities: { title: 'Plugin sections', label: 'Capabilities' },
    working: { title: 'Changes views', label: 'Working tree' },
    staged: { title: 'Changes views', label: 'Staged' },
  }
  const choice = choices[value]
  if (!choice) throw new Error(`No body choice for ${value}`)
  return choice
}
export const selectFrameTab = async (page: Page, value: string): Promise<void> => {
  await closeFloatingTeamRail(page.locator('body'))
  const bar = page.locator('[data-slot="top-bar"]:visible').first()
  if (await page.locator('[data-page-destination]:visible').count()) await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
  else await expectTitleRoom(bar.locator('[data-topbar-title]'))
  await settleFrameBar(bar)
  if (await page.getByRole('tablist', { name: 'Team views', exact: true }).count()) {
    await selectTeamDestination(page.locator('body'), value)
    return
  }
  const choice = pageChoiceFor(value)
  const trigger = page.locator('[data-slot="page-options"]:visible').getByTitle(choice.title, { exact: true })
  await trigger.click()
  await page.getByRole('menuitemradio').filter({ has: page.getByText(choice.label, { exact: true }) }).click()
  await expect(trigger).toContainText(choice.label)
}
export const applyFrameActions = async (page: Page, actions: FrameActions): Promise<void> => {
  if (actions.viewChoice || actions.inspectFirst) await closeFloatingTeamRail(page.locator('body'))
  if (actions.tab) await selectFrameTab(page, actions.tab)
  if (actions.viewChoice) {
    const unified = page.locator('[data-slot="run-workspace"][data-view="work"]:visible')
    if (actions.viewChoice === 'Flow' && await unified.count()) {
      await expect(unified.locator('[data-slot="run-flow"]')).toBeVisible()
    } else {
      await page.locator('[data-slot="page-options"]:visible').getByRole('button', { name: /^(View|Chat|Split|Board|List|All|Open|Blocking|Running)$/ }).click()
      const choice = page.getByRole('menuitem', { name: actions.viewChoice, exact: true })
        .or(page.getByRole('menuitemradio', { name: actions.viewChoice, exact: true }))
        .or(page.getByRole('switch').filter({ has: page.getByText(actions.viewChoice, { exact: true }) }))
      await expect(choice).toHaveCount(1)
      await choice.click()
      // Every view choice closes its menu. Capture the chosen view after that
      // transition; supplemental frames capture the menu as a separate state.
      await expect(page.getByRole('menu')).toHaveCount(0)
    }
  }
  if (actions.inspectFirst) await page.locator('[data-slot="workbench-main"] [data-row][data-kind="card"]').first().click()
  if (actions.tool === 'details' || actions.tool === 'activity') {
    const rail = page.locator('[data-work-rail-toggle]')
    if (await rail.getAttribute('aria-pressed') !== 'true') await toggleTeamRail(page.locator('body'))
  } else if (actions.tool) {
    const direct = page.locator(`[data-work-tool="${actions.tool}"]`)
    if (await direct.isVisible()) await direct.click()
    else {
      await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
      const action = page.getByRole('menuitemradio', { name: actions.tool === 'browser' ? 'Browser' : 'Changes', exact: true })
      await expect(action).toHaveCount(1)
      await action.click()
      await expect(action).toBeHidden()
    }
  }
  if (actions.holdMessages) {
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Board-only', exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
}

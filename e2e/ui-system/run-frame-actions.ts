import { expect, type Locator } from '@playwright/test'
import { closeFloatingTeamRail } from './team-frame-actions'

/** The subject bar owns its verbs; the Run's choices live in its body. */
export const runBar = (frame: Locator): Locator => frame.locator('[data-slot="top-bar"]:visible').first()

export const selectRunView = async (frame: Locator, value: 'Timeline' | 'Flow'): Promise<void> => {
  await closeFloatingTeamRail(frame)
  const unified = frame.locator('[data-slot="run-workspace"][data-view="work"]')
  if (await unified.count()) {
    if (value === 'Timeline') {
      const expand = frame.getByRole('button', { name: 'Full record', exact: true })
      if (await expand.isVisible()) await expand.click()
      await expect(unified.getByRole('list', { name: 'Run timeline', exact: true })).toBeVisible()
    } else await expect(unified.locator('[data-slot="run-flow"]')).toBeVisible()
    return
  }
  await frame.locator('[data-slot="workbench-main"]').getByRole('button', { name: /^(View|Timeline|Flow)$/ }).click()
  const choice = frame.page().getByRole('menuitemradio', { name: value, exact: true })
  await expect(choice).toBeVisible()
  await choice.click()
  await expect(frame.locator('[data-slot="run-workspace"]')).toHaveAttribute('data-view', value.toLowerCase())
}

export const stopRun = (frame: Locator): Locator => frame.locator('[data-slot="workbench-main"]').getByRole('button', { name: 'Stop run…', exact: true })

/** A standalone Run keeps its action in the body; a Team owns it in its title. */
export const clickStopRun = async (frame: Locator): Promise<void> => {
  const floating = frame.locator('[data-preview-tool-placement="floating"]')
  if (await floating.count()) await floating.getByRole('button', { name: 'Close pane', exact: true }).click()
  const direct = stopRun(frame)
  if (await direct.isVisible()) await direct.click()
  else {
    await runBar(frame).locator('[data-topbar-title]').getByRole('button').click()
    await frame.page().getByRole('menuitem', { name: /^Stop run…/ }).click()
  }
}

/** Selected records close with their pane; the subject rail is independent. */
export const closeRunInspector = async (frame: Locator): Promise<void> => {
  const close = frame.getByRole('button', { name: 'Close pane', exact: true })
  if (await close.isVisible()) await close.click()
  await expect(frame.locator('[data-slot="work-tools"]:visible')).toHaveCount(0)
}

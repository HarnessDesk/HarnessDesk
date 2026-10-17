import { expect, type Page } from '@playwright/test'
import { applyFrameActions, type FrameActions } from './frame-actions'
import type { WallActions } from './frame-wall-actions'
export interface PageFrameActions extends FrameActions, WallActions {
  readonly more?: 'present' | 'absent'
  readonly bodyChoice?: { readonly label: string; readonly value: string; readonly item?: string }
  readonly moreChoice?: string
  readonly addSkillMenu?: boolean
  readonly addSkillChoice?: string
  readonly bodySearch?: { readonly label: string; readonly value: string }
  readonly expandWrapped?: boolean
  readonly expandLibraryEntry?: boolean
  readonly expectedTopInset?: 'page'
}
export const applyPageFrameActions = async (page: Page, actions: PageFrameActions): Promise<void> => {
  await applyFrameActions(page, actions)
  if (actions.bodyChoice) {
    const choice = actions.bodyChoice
    const options = page.locator('[data-slot="page-options"]:visible, [data-slot="library-skills-controls"]:visible')
    const select = options.getByRole('combobox', { name: choice.label, exact: true })
    const radio = options.getByRole('radio', { name: choice.item ?? choice.value, exact: true })
    if (await radio.count()) await radio.click()
    else if (await select.count()) await select.selectOption(choice.value)
    else {
      if (!choice.item) throw new Error(`Missing menu item for ${choice.label}`)
      await options.getByTitle(choice.label, { exact: true }).click()
      const item = page.getByRole('menuitemradio').filter({ has: page.getByText(choice.item, { exact: true }) })
      await expect(item).toHaveCount(1)
      await item.click()
    }
  }
  if (actions.addSkillMenu || actions.addSkillChoice) {
    await page.getByRole('button', { name: 'Add skill', exact: true }).click()
    if (actions.addSkillChoice) await page.getByRole('menuitem', { name: actions.addSkillChoice, exact: true }).click()
    else await expect(page.getByRole('menuitem', { name: 'Write a skill', exact: true })).toBeVisible()
  }
  if (actions.moreChoice) {
    await page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button').click()
    const choice = page.getByRole('menuitem', { name: actions.moreChoice, exact: true })
      .or(page.getByRole('menuitemradio', { name: actions.moreChoice, exact: true }))
    await expect(choice).toHaveCount(1)
    await choice.click()
  }
  if (actions.bodySearch) await page.getByRole('searchbox', { name: actions.bodySearch.label, exact: true }).fill(actions.bodySearch.value)
  if (actions.expandWrapped) {
    const ready = page.getByRole('button', { name: /^Wrapped · / })
    await expect(ready).toHaveAttribute('aria-expanded', 'false')
    await ready.click()
    await expect(ready).toHaveAttribute('aria-expanded', 'true')
  }
  if (actions.expandLibraryEntry) {
    const entry = page.locator('[data-page-destination="library"]:visible [data-slot="library-matrix"] tr button[aria-expanded]').first()
    await expect(entry).toBeVisible()
    await expect(entry).toHaveAttribute('aria-expanded', 'false')
    await entry.click()
    await expect(entry).toHaveAttribute('aria-expanded', 'true')
  }
}

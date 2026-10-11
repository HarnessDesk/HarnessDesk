import { expect, type Page } from '@playwright/test'
import { applyFrameActions, type FrameActions } from './frame-actions'
import type { WallActions } from './frame-wall-actions'
export interface PageFrameActions extends FrameActions, WallActions {
  readonly bodyChoice?: { readonly label: string; readonly value: string; readonly item?: string }
  readonly moreChoice?: string
  readonly bodySearch?: { readonly label: string; readonly value: string }
  readonly expandReady?: boolean
  readonly expandLibraryEntry?: boolean
}
export const applyPageFrameActions = async (page: Page, actions: PageFrameActions): Promise<void> => {
  await applyFrameActions(page, actions)
  if (actions.bodyChoice) {
    const choice = actions.bodyChoice
    const options = page.locator('[data-slot="page-options"]:visible')
    const select = options.getByRole('combobox', { name: choice.label, exact: true })
    if (await select.count()) await select.selectOption(choice.value)
    else {
      if (!choice.item) throw new Error(`Missing menu item for ${choice.label}`)
      await options.getByTitle(choice.label, { exact: true }).click()
      await page.getByRole('menuitemradio', { name: choice.item, exact: true }).click()
    }
  }
  if (actions.moreChoice) {
    await page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button').click()
    const choice = page.getByRole('menuitem', { name: actions.moreChoice, exact: true })
      .or(page.getByRole('menuitemradio', { name: actions.moreChoice, exact: true }))
    await expect(choice).toHaveCount(1)
    await choice.click()
  }
  if (actions.bodySearch) await page.getByRole('searchbox', { name: actions.bodySearch.label, exact: true }).fill(actions.bodySearch.value)
  if (actions.expandReady) {
    const ready = page.getByRole('button', { name: /^Ready to wrap · / })
    await expect(ready).toHaveAttribute('aria-expanded', 'false')
    await ready.click()
    await expect(ready).toHaveAttribute('aria-expanded', 'true')
  }
  if (actions.expandLibraryEntry) {
    const entry = page.locator('[data-page-destination="library"]:visible button[aria-expanded="false"]').first()
    await expect(entry).toBeVisible()
    await entry.click()
    await expect(entry).toHaveAttribute('aria-expanded', 'true')
  }
}

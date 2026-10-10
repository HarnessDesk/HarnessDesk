import { applyLeftColumnActions } from './left-column-actions'
import type { Page } from '@playwright/test'
export interface WallActions { readonly popup?: string }
/** Popup actions run after the wall's existing destination navigation. */
export const openWallDestination = async (page: Page, destination: WallActions): Promise<void> => {
  if (destination.git) {
    await page.locator('[data-work-tool="details"]').click()
    await page.getByRole('button', { name: 'Folder actions', exact: true }).click()
    if (destination.branch) {
      const branch = page.locator('[data-git-branch-row]').locator('xpath=ancestor::*[@role="menuitem"][1]')
      await branch.focus()
      await page.keyboard.press('ArrowRight')
      await page.locator('[data-menu-search] input').waitFor({ state: 'visible' })
    }
    if (destination.gitRef) {
      await page.getByRole('menuitem', { name: 'History', exact: true }).click()
      await page.getByRole('grid', { name: 'Commits', exact: true }).waitFor({ state: 'visible' })
      if (await page.getByRole('button', { name: 'Switch the refs rail', exact: true }).count() === 0) {
        throw new Error('Branch context wall needs an approved refs route in the fixed right panel; the existing rail requires 640px.')
      }
      await page.locator('[data-git-ref="main"]').click({ button: 'right' })
    }
    if (destination.createBranch) await page.getByRole('menuitem', { name: 'Create and checkout new branch…', exact: true }).click()
  }
  if (destination.account) {
    await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'account' })
    await page.locator('[role="menuitem"][data-current]').click()
    const usage = page.getByRole('menuitem', { name: /^Usage remaining/ })
    if (await usage.count()) await usage.click()
    if (destination.signOut) await page.getByRole('menuitem', { name: /^Sign out of/ }).click()
  }
  if (destination.plan) await page.locator(`[data-plan-popup="${destination.plan}"]`).locator('xpath=ancestor::button[1]').click()
  if (destination.composerAdd) await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  if (destination.undo) {
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Undo the last turn/ }).click()
  }
  if (destination.popup === 'More') {
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
    return
  }
  if (destination.popup) await page.getByRole('button', { name: destination.popup, exact: true }).click()
}

export interface WallActions { readonly composerAdd?: boolean }

export interface WallActions { readonly undo?: boolean }


export interface WallActions { readonly plan?: 'anchor' | 'rest' }

export interface WallActions { readonly account?: boolean; readonly signOut?: boolean }

export interface WallActions { readonly git?: boolean; readonly branch?: boolean; readonly gitRef?: boolean; readonly createBranch?: boolean }

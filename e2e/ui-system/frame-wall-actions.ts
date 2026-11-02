import { closeFloatingTeamRail } from './team-frame-actions'
import { expect } from '@playwright/test'
import { applyLeftColumnActions, openAccountUsage } from './left-column-actions'
import type { Page } from '@playwright/test'
export interface WallActions { readonly popup?: string; readonly query?: string }
/** Popup actions run after the wall's existing destination navigation. */
export const openWallDestination = async (page: Page, destination: WallActions): Promise<void> => {
  if (destination.contextInfo || destination.composerModel || destination.composerAdd || destination.infoFocus === 'context') await closeFloatingTeamRail(page.locator('body'))
  if (destination.hover) {
    await page.getByRole('button', { name: destination.hover, exact: true }).hover()
    await page.locator('[data-popup-kind="info-card"]:visible').waitFor()
  }
  if (destination.focus) {
    await page.getByRole('button', { name: destination.focus, exact: true }).focus()
    await page.locator('[data-popup-kind="info-card"]:visible').waitFor()
  }
  if (destination.contextInfo || destination.memberInfo) {
    await page.locator(`[data-info-source="${destination.contextInfo ? 'context' : 'member'}"]`).first().hover()
    await page.locator('[data-popup-kind="info-card"]:visible').waitFor()
  }
  if (destination.infoTarget || destination.infoFocus) {
    const trigger = page.locator(destination.infoTarget ?? `[data-info-source="${destination.infoFocus}"]`).first()
    if (destination.infoFocus) await trigger.focus()
    else await trigger.hover()
    await page.locator('[data-popup-kind="info-card"]:visible').waitFor()
  }
  if (destination.git) {
    const rail = page.getByRole('button', { name: 'Toggle rail', exact: true })
    if (await rail.getAttribute('aria-pressed') !== 'true') await rail.click()
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
      if (await page.locator('[data-git-ref="main"]').count() === 0) {
        await page.getByRole('button', { name: 'Switch the refs rail', exact: true }).click()
        await expect(page.locator('[data-git-ref="main"]')).toBeVisible()
      }
      await page.locator('[data-git-ref="main"]').click({ button: 'right' })
    }
    if (destination.createBranch) {
      await page.getByRole('menuitem', { name: 'Create and checkout new branch…', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Create and checkout new branch', exact: true })).toBeVisible()
      await expect(page.locator('[data-popup-kind="menu"],[data-popup-kind="wide-menu"]')).toHaveCount(0)
    }
  }
  if (destination.account) {
    await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'account' })
  }
  if (destination.plan) {
    await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'account' })
    await openAccountUsage(page)
    await expect(page.locator('[data-usage-details]')).toBeVisible()
  }
  if (destination.inbox) await page.getByRole('button', { name: 'Inbox, 1 unread', exact: true }).click()
  if (destination.expandInbox) await page.getByRole('menuitem', { name: /The Storefront catalogue compatibility check/ }).click()
  if (destination.select) await page.getByRole('combobox', { name: destination.query?.includes('popup=select-disabled') ? 'Frame Select with disabled option' : 'Frame Select', exact: true }).click()
  if (destination.composerAdd) await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  if (destination.undo) {
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Undo the last turn/ }).click()
    await expect(page.getByRole('alertdialog', { name: 'Undo the last turn?', exact: true })).toBeVisible()
    await expect(page.locator('[data-popup-kind="menu"],[data-popup-kind="wide-menu"]')).toHaveCount(0)
  }
  if (destination.popup === 'More') {
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
    return
  }
  if (destination.composerModel) await page.getByTitle(/model and reasoning/i).first().click()
  if (destination.topbarPopup === 'view') await page.locator('[data-slot="page-options"]:visible').getByRole('button', { name: 'View', exact: true }).click()
  if (destination.topbarPopup === 'tabs') {
    await expect(page.getByRole('tablist', { name: 'Team views', exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="top-bar"]:visible [role="tab"]')).toHaveCount(0)
  }
  if (destination.popup) await page.getByRole('button', { name: destination.popup, exact: true }).click()
}

export interface WallActions { readonly composerAdd?: boolean }

export interface WallActions { readonly undo?: boolean }


export interface WallActions { readonly plan?: 'anchor' | 'rest' }

export interface WallActions { readonly hover?: string; readonly focus?: string }

export interface WallActions { readonly contextInfo?: boolean; readonly memberInfo?: boolean }

export interface WallActions { readonly infoTarget?: string; readonly infoFocus?: 'context' }
export interface WallActions { readonly account?: boolean }

export interface WallActions { readonly git?: boolean; readonly branch?: boolean; readonly gitRef?: boolean; readonly createBranch?: boolean }
export interface WallActions { readonly select?: boolean }

export interface WallActions { readonly composerModel?: boolean; readonly topbarPopup?: 'view' | 'tabs' }

export interface WallActions { readonly inbox?: boolean; readonly expandInbox?: boolean }

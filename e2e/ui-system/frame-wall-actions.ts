import { expect } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import type { Page } from '@playwright/test'
export interface WallActions { readonly popup?: string }
/** Popup actions run after the wall's existing destination navigation. */
export const openWallDestination = async (page: Page, destination: WallActions): Promise<void> => {
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
  if (destination.composerModel) await page.getByTitle(/model and reasoning/i).first().click()
  if (destination.topbarPopup === 'view') await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'View', exact: true }).click()
  if (destination.topbarPopup === 'tabs') {
    const folded = page.getByTitle('Destination views', { exact: true })
    const shouldFold = (page.viewportSize()?.width ?? FRAME.fold.panelFloats) < FRAME.fold.panelFloats
    if (shouldFold) await expect(folded).toBeVisible()
    if (await folded.isVisible()) await folded.click()
    if (shouldFold) await expect(page.getByRole('menu')).toBeVisible()
  }
  if (destination.popup) await page.getByRole('button', { name: destination.popup, exact: true }).click()
}

export interface WallActions { readonly composerAdd?: boolean }

export interface WallActions { readonly undo?: boolean }


export interface WallActions { readonly plan?: 'anchor' | 'rest' }

export interface WallActions { readonly hover?: string; readonly focus?: string }

export interface WallActions { readonly contextInfo?: boolean; readonly memberInfo?: boolean }

export interface WallActions { readonly infoTarget?: string; readonly infoFocus?: 'context' }

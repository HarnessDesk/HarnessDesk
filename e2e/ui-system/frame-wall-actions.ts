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

export interface WallActions { readonly hover?: string; readonly focus?: string }

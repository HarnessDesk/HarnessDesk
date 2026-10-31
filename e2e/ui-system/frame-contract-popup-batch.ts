import { expect, type Page } from '@playwright/test'
import { applyFrameActions } from './frame-actions'
import { checkDestinationPopups } from './frame-contract-popup-rules'
import { readInBothThemes, RICH_POPUPS, SELECTION_ACTION, type PopupSnapshot } from './frame-contract-popup-snapshot'
import { openWallDestination } from './frame-wall-actions'
import type { WallDestination } from './frame-wall-destinations'
import { applyLeftColumnActions, applySettingsNavigationActions } from './left-column-actions'
import { openReused, runSnapshotBatch } from './frame-snapshot-batch'

export { batches } from './frame-snapshot-batch'

/**
 * The C10 popup contracts, captured once and checked many times
 * (docs/decisions.md, 2026-10-31). One test takes a batch of wall
 * destinations at one width through one page (`frame-snapshot-batch.ts`):
 * each destination is staged once, light, read in both themes, and every rule
 * runs over that reading in Node.
 */

/** Stage one destination: the setup the live check made before it measured. */
export const stageDestination = async (page: Page, destination: WallDestination, width: number) => {
  await openReused(page, destination.query, width, async () => {
    await applyFrameActions(page, destination)
    await applyLeftColumnActions(page, destination)
    await applySettingsNavigationActions(page, destination)
    await openWallDestination(page, destination)
  })
  if (destination.id === 'popup-account-info') {
    const root = page.locator('[data-slot="popover-popup"]:visible')
    const menu = page.locator('[data-slot="dropdown-menu-sub-content"]:visible')
    await expect(root.locator('[data-slot="dropdown-menu-sub-trigger"][data-current] [data-menu-account-name]')).toHaveAttribute('title', /.+/)
    await expect(menu.locator('[data-usage-details]')).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open usage', exact: true })).toBeVisible()
  }
  // This destination stages a selection after the lazy editor mounts. Reading
  // popups before its action arrives would pass without measuring anything.
  if (destination.id === 'editor-ask') {
    const rich = page.locator(RICH_POPUPS)
    await expect(rich.filter({ has: page.getByRole('button', { name: SELECTION_ACTION, exact: true }) })).toHaveCount(1)
  }
}

/** Stage one destination and read its popups. */
export const readDestinationPopups = async (page: Page, destination: WallDestination, width: number): Promise<PopupSnapshot> => {
  await stageDestination(page, destination, width)
  return readInBothThemes(page, destination.id, width, { selection: destination.id === 'editor-ask' })
}

/** Check a batch of destinations at one width; returns the popup kinds the batch found. */
export const checkPopupBatch = async (page: Page, destinations: readonly WallDestination[], width: number): Promise<Set<string>> => {
  const kinds = new Set<string>()
  await runSnapshotBatch(page, destinations, width, destination => readDestinationPopups(page, destination, width), snapshot => {
    for (const kind of checkDestinationPopups(snapshot)) kinds.add(kind)
  })
  return kinds
}

/** A batch's place in the test title: every destination it reads, as the per-destination titles named them. */
export const batchTitle = (destinations: readonly WallDestination[], width: number) => `${destinations.map(destination => destination.id).join(', ')} at ${width} in both themes`

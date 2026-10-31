import { expect, test, type Page } from '@playwright/test'
import { applyFrameActions } from './frame-actions'
import { checkDestinationPopups } from './frame-contract-popup-rules'
import { readInBothThemes, RICH_POPUPS, SELECTION_ACTION, type PopupSnapshot } from './frame-contract-popup-snapshot'
import { FRAME_PREVIEW_URL, installFrameUpdateBridge, routeFramePreview } from './frame-preview-fixture'
import { openWallDestination } from './frame-wall-actions'
import type { WallDestination } from './frame-wall-destinations'
import { applyLeftColumnActions, applySettingsNavigationActions } from './left-column-actions'

/**
 * The C10 popup contracts, captured once and checked many times
 * (docs/decisions.md, 2026-10-31). One test takes a batch of wall
 * destinations at one width through one page: each destination is a fresh
 * document, light, read in both themes, and every rule runs over that
 * reading in Node. Reusing the page keeps the app's bundle in the HTTP cache,
 * which halves a load; nothing else carries over, because the page's storage
 * is cleared before every destination.
 */

const preparedPages = new WeakSet<Page>()

/**
 * What a fresh context gives a test, given to every document this page
 * opens: the update bridge, and empty storage. The app writes its drafts on
 * `pagehide`, so storage is cleared as each document starts rather than
 * before the last one leaves. It keeps nothing in IndexedDB or cookies.
 */
const preparePage = async (page: Page) => {
  if (preparedPages.has(page)) return
  preparedPages.add(page)
  await installFrameUpdateBridge(page)
  await page.addInitScript(() => {
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      // An opaque-origin frame (the sandboxed preview) has no storage to clear.
    }
  })
}

/**
 * `openFrame` and the wall's staging, for a page that has opened other
 * destinations: the destination's width, light. The preview fixture's route
 * would turn the cache off for every load, so a destination gets it only
 * when its document asks for the local preview, and is opened again with it.
 */
const openDestination = async (page: Page, destination: WallDestination, width: number) => {
  await preparePage(page)
  await page.unrouteAll()
  await page.context().clearCookies()
  let wantsPreview = false
  const watch = (request: { url(): string }) => { if (FRAME_PREVIEW_URL.test(request.url())) wantsPreview = true }
  const open = async () => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.mouse.move(width - 1, 899)
    await page.goto(`/preview.html?${destination.query}&theme=light`)
    await page.evaluate(async () => { await document.fonts.ready })
    await applyFrameActions(page, destination)
    await applyLeftColumnActions(page, destination)
    await applySettingsNavigationActions(page, destination)
    await openWallDestination(page, destination)
  }
  page.on('request', watch)
  try {
    await open()
  } catch (error) {
    // Staging that needed the preview is staged again with it.
    if (!wantsPreview) throw error
  } finally {
    page.off('request', watch)
  }
  if (!wantsPreview) return
  await routeFramePreview(page)
  await open()
}

/** Stage one destination: the setup the live check made before it measured. */
export const stageDestination = async (page: Page, destination: WallDestination, width: number) => {
  await openDestination(page, destination, width)
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

/**
 * Check a batch of destinations at one width. A destination that fails does
 * not stop the rest: each is its own step, its snapshot is attached, and the
 * test fails at the end naming every destination that did. Returns the popup
 * kinds the batch found.
 */
export const checkPopupBatch = async (page: Page, destinations: readonly WallDestination[], width: number): Promise<Set<string>> => {
  // Each destination may spend what a test of its own could.
  test.setTimeout(test.info().timeout * destinations.length)
  const kinds = new Set<string>()
  const failures: { destination: string; error: Error }[] = []
  for (const destination of destinations) {
    let snapshot: PopupSnapshot | undefined
    try {
      await test.step(`${destination.id} at ${width}`, async () => {
        snapshot = await readDestinationPopups(page, destination, width)
        for (const kind of checkDestinationPopups(snapshot)) kinds.add(kind)
      })
    } catch (error) {
      failures.push({ destination: destination.id, error: error as Error })
      if (snapshot) await test.info().attach(`${destination.id}-${width}.json`, { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' })
    }
  }
  if (failures.length === 1) throw Object.assign(failures[0]!.error, { message: `${failures[0]!.destination} at ${width}: ${failures[0]!.error.message}` })
  if (failures.length > 1) throw new Error(failures.map(({ destination, error }) => `${destination} at ${width}: ${error.message}`).join('\n\n'))
  return kinds
}

/** A batch's place in the test title: every destination it reads, as the per-destination titles named them. */
export const batchTitle = (destinations: readonly WallDestination[], width: number) => `${destinations.map(destination => destination.id).join(', ')} at ${width} in both themes`

/** Destinations in batches of `size`, in order. */
export const batches = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, at * size + size))

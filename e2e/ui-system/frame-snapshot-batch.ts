import { test, type Page } from '@playwright/test'
import { FRAME_PREVIEW_URL, installFrameUpdateBridge, routeFramePreview } from './frame-preview-fixture'

/**
 * Capture once, check many (docs/decisions.md, 2026-10-31): the frame
 * families that read a wall destination once per width take a batch of them
 * through one page. Each destination is a fresh document, light; reusing the
 * page keeps the app's bundle in the HTTP cache, which halves a load, and
 * nothing else carries over.
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
 * `openFrame` for a page that has opened other destinations, in light, then
 * `stage`. The preview fixture's route would turn the cache off for every
 * load, so a document gets it only when it asks for the local preview, and is
 * opened and staged again with it.
 */
export const openReused = async (page: Page, query: string, width: number, stage: () => Promise<void> = async () => {}) => {
  await preparePage(page)
  await page.unrouteAll()
  await page.context().clearCookies()
  let wantsPreview = false
  const watch = (request: { url(): string }) => { if (FRAME_PREVIEW_URL.test(request.url())) wantsPreview = true }
  const open = async () => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.mouse.move(width - 1, 899)
    await page.goto(`/preview.html?${query}&theme=light`)
    await page.evaluate(async () => { await document.fonts.ready })
    await stage()
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

/**
 * Visit and check a batch of destinations at one width. A destination that
 * fails does not stop the rest: each is its own step, its reading is
 * attached, and the test fails at the end naming every destination that did.
 */
export const runSnapshotBatch = async <D extends { readonly id: string }, S>(
  page: Page, destinations: readonly D[], width: number,
  visit: (destination: D) => Promise<S>, check: (snapshot: S, destination: D) => void,
) => {
  // Each destination may spend what a test of its own could.
  test.setTimeout(test.info().timeout * destinations.length)
  const failures: { destination: string; error: Error }[] = []
  for (const destination of destinations) {
    let snapshot: S | undefined
    try {
      await test.step(`${destination.id} at ${width}`, async () => {
        snapshot = await visit(destination)
        check(snapshot, destination)
      })
    } catch (error) {
      failures.push({ destination: destination.id, error: error as Error })
      if (snapshot !== undefined) await test.info().attach(`${destination.id}-${width}.json`, { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' })
    }
  }
  if (failures.length === 1) throw Object.assign(failures[0]!.error, { message: `${failures[0]!.destination} at ${width}: ${failures[0]!.error.message}` })
  if (failures.length > 1) throw new Error(failures.map(({ destination, error }) => `${destination} at ${width}: ${error.message}`).join('\n\n'))
}

/** Destinations in batches of `size`, in order. */
export const batches = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, at * size + size))

import { expect, type Locator, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { settleFrameBar } from './frame-actions'
import { openReused } from './frame-snapshot-batch'
import type { WallDestination } from './frame-wall-destinations'

/**
 * Capture once, check many (docs/decisions.md, 2026-10-31): the B10 window
 * leads of a non-work destination, read in one visit, so
 * `frame-contract-leads-rules.ts` can hold the contract as pure functions.
 *
 * The live check waited before most of its assertions — for a title to leave
 * the bar, a lead to gain its buttons, a title to find its room. Each wait is
 * kept here, under the same condition and deadline, and its assertion moved
 * to the rule: a wait that runs out is not a failure here, the rule reads
 * what is there and names it. Geometry is read in light only.
 */

/** The three window states the B10 leads are held to. */
export const LEAD_STATES = {
  /** The sidebar hidden in a wide window: the lead carries the window's controls. */
  wide: { width: 1440, query: '&frame-sidebar-hidden=1', away: true },
  /** A narrow window, where the sidebar is away on its own. */
  narrow: { width: 720, query: '', away: true },
  /** A wide window with its sidebar standing: the lead carries nothing. */
  standing: { width: 1440, query: '', away: false },
} as const
export type LeadState = keyof typeof LEAD_STATES

export interface LeadReading {
  readonly destination: string
  readonly settings: boolean
  /** The overlay's Return to main, before it was pressed: the bar's other buttons, and whether it showed. */
  readonly returnToMain: { readonly barButtons: number; readonly visible: boolean } | null
  readonly leadButtons: readonly (string | null)[]
  readonly workTools: number
  readonly barTitles: number
  readonly settingsHeadings: readonly string[]
  readonly barHeight: number | null
  /** The page's own title column, when it has one. */
  readonly content: { readonly canvas: boolean; readonly headings: number; readonly headingX: number | null; readonly edge: number } | null
  /** The bar's title, when the page has no title column of its own. */
  readonly title: { readonly attached: boolean; readonly width: number; readonly intrinsic: number; readonly x: number } | null
  readonly placeX: number | null
}

export const windowBar = (page: Page) => page.locator('[data-frame-region="top"] [data-slot="top-bar"]')

/** A wait the live check made before it asserted; its assertion is the rule's. */
const settle = (wait: Promise<unknown>) => wait.catch(() => {})

/** The bar title's own width, and the width of an unclipped copy (`title-contract.ts`). */
const titleRoom = (title: Locator) => title.evaluate(node => {
  const copy = node.cloneNode(true) as HTMLElement
  Object.assign(copy.style, { position: 'fixed', visibility: 'hidden', width: 'max-content', maxWidth: 'none', minWidth: 'max-content', flex: 'none' })
  node.parentElement!.append(copy)
  const intrinsic = copy.getBoundingClientRect().width
  copy.remove()
  const box = node.getBoundingClientRect()
  return { width: box.width, intrinsic, x: box.x }
})

/** `expectTitleRoom`'s condition: short titles take their words, longer ones keep the fold's floor. */
export const titleFits = ({ width, intrinsic }: { width: number; intrinsic: number }) =>
  width + 0.5 >= Math.min(FRAME.bar.titleMin, intrinsic) && width <= Math.min(FRAME.bar.titleMax, intrinsic) + 0.5

/**
 * Settle the bar, step an overlay aside with Return to main, and read the
 * lead's buttons: `expectLead`'s half of the visit.
 */
export const readLeadButtons = async (bar: Locator, settings: boolean, away: boolean): Promise<Pick<LeadReading, 'returnToMain' | 'leadButtons'>> => {
  await settleFrameBar(bar)
  let returnToMain: LeadReading['returnToMain'] = null
  const overlay = bar.page().getByRole('button', { name: 'Return to main', exact: true })
  if (await overlay.count()) {
    await settle(expect(bar.getByRole('button')).toHaveCount(0))
    await settle(expect(overlay).toBeVisible())
    returnToMain = { barButtons: await bar.getByRole('button').count(), visible: await overlay.isVisible() }
    if (returnToMain.visible) await overlay.click()
  }
  const lead = bar.locator('[data-topbar="lead"]').getByRole('button')
  await settle(expect(lead).toHaveCount(!away ? 0 : settings ? 1 : 3))
  return { returnToMain, leadButtons: await lead.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))) }
}

/** The work conversation's place origin, which every non-work lead is held to. */
export const readLeadReference = async (page: Page, state: LeadState): Promise<number> => {
  const { width, query } = LEAD_STATES[state]
  await openReused(page, `frame-wall=conversation${query}`, width)
  return (await windowBar(page).locator('[data-topbar="place"]').boundingBox())!.x
}

/** Open a non-work destination in a window state and read its lead. */
export const readLead = async (page: Page, destination: WallDestination, state: LeadState): Promise<LeadReading> => {
  const { width, query } = LEAD_STATES[state]
  await openReused(page, `${destination.query}${query}`, width)
  return readOpenedLead(page, destination, state)
}

/** Read the lead of a destination already open in that window state. */
export const readOpenedLead = async (page: Page, destination: WallDestination, state: LeadState): Promise<LeadReading> => {
  const { away } = LEAD_STATES[state]
  const bar = windowBar(page)
  // Staging: the agent page's body arrives after the frame.
  if (destination.id === 'e4-agent-detail') await expect(page.locator('[data-page-destination]:visible h1')).toHaveText('Code reviewer')
  const settings = await page.locator('[data-page-destination="settings"]:visible').count() === 1
  const { returnToMain, leadButtons } = await readLeadButtons(bar, settings, away)
  if (away) await settle(expect(bar.locator('[data-work-tool]')).toHaveCount(0))
  const workTools = await bar.locator('[data-work-tool]').count()
  let settingsHeadings: string[] = [], barHeight: number | null = null
  const barTitle = bar.locator('[data-topbar-title]')
  if (settings) {
    await settle(expect(barTitle).toHaveCount(0))
    const headings = page.locator('[data-page-destination="settings"]:visible h1')
    await settle(expect(headings).toHaveText(/\S/))
    settingsHeadings = await headings.allTextContents()
    barHeight = (await bar.locator('..').boundingBox())!.height
  }
  let content: LeadReading['content'] = null
  const column = page.locator('[data-page-destination]:visible [data-slot="page"]').first()
  if (await column.count()) {
    await settle(expect(barTitle).toHaveCount(0))
    const canvas = await column.getAttribute('data-width') === 'canvas'
    const heading = column.getByRole('heading', { level: 1 })
    await settle(expect(heading).toHaveCount(canvas ? 0 : 1))
    const headings = await heading.count()
    content = {
      canvas, headings,
      headingX: !canvas && headings === 1 ? (await heading.boundingBox())!.x : null,
      edge: await column.evaluate(node => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft)),
    }
  }
  const barTitles = await barTitle.count()
  let title: LeadReading['title'] = null
  let placeX: number | null = null
  if (!content) {
    if (state !== 'standing') {
      await settle(expect(barTitle).toBeAttached())
      const attached = await barTitle.count() > 0
      if (attached) await settle(expect.poll(async () => titleFits(await titleRoom(barTitle))).toBe(true))
      title = attached ? { attached, ...await titleRoom(barTitle) } : { attached, width: 0, intrinsic: 0, x: 0 }
    }
    placeX = (await bar.locator('[data-topbar="place"]').boundingBox())!.x
  }
  return { destination: destination.id, settings, returnToMain, leadButtons, workTools, barTitles, settingsHeadings, barHeight, content, title, placeX }
}

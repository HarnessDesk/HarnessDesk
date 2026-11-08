import { expect } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { LEAD_STATES, titleFits, type LeadReading, type LeadState } from './frame-contract-leads-snapshot'

/**
 * B10: a non-work page's title follows its content column, and the fixed lead
 * follows the window's state — as pure functions over a lead reading
 * (`frame-contract-leads-snapshot.ts`). Each assertion and message is the one
 * the live check made; `lead-contract-rules.spec.ts` breaks each of them.
 */

/** An overlay steps aside first; the lead carries exactly the window's controls. */
export const checkLeadButtons = (reading: Pick<LeadReading, 'returnToMain' | 'leadButtons' | 'settings'>, away: boolean) => {
  if (reading.returnToMain) {
    expect(reading.returnToMain.barButtons, 'the overlay bar has no buttons but Return to main').toBe(0)
    expect(reading.returnToMain.visible, 'Return to main is visible').toBe(true)
  }
  // Every non-Settings destination carries history while the sidebar is away.
  const names = !away ? [] : reading.settings ? ['Show sidebar'] : ['Show sidebar', 'Back', 'Forward']
  expect(reading.leadButtons).toHaveLength(names.length)
  expect(reading.leadButtons).toEqual(names)
}

/** The current Settings route names itself in the content column only. */
export const checkQuietSettings = (reading: LeadReading) => {
  expect(reading.barTitles, 'Settings puts no title in the bar').toBe(0)
  expect(reading.settingsHeadings, 'the Settings page has one title').toHaveLength(1)
  expect(reading.settingsHeadings[0]).toMatch(/\S/)
  expect(reading.barHeight).toBe(FRAME.bar.height)
}

/** A page with a title column titles itself there, on the column's text edge. */
export const checkContentTitle = (reading: LeadReading) => {
  const content = reading.content
  if (!content) return false
  expect(reading.barTitles, 'a page with its own title column puts none in the bar').toBe(0)
  if (content.canvas) {
    expect(content.headings, 'a canvas page has no title').toBe(0)
    return true
  }
  expect(content.headings, 'the title column has one title').toBe(1)
  expect(content.headingX!).toBeCloseTo(content.edge, 1)
  return true
}

/**
 * The whole B10 lead contract for one destination in one window state;
 * returns the bar title's place measurements when the bar carries the title.
 */
export const checkLead = (reading: LeadReading, referenceX: number, state: LeadState) => {
  const { away } = LEAD_STATES[state]
  checkLeadButtons(reading, away)
  if (away) expect(reading.workTools, 'a non-work page has no work tools').toBe(0)
  if (reading.settings) checkQuietSettings(reading)
  if (checkContentTitle(reading)) return null
  const origin = reading.placeX!
  if (state === 'standing') {
    expect(Math.abs(origin - referenceX), `${reading.destination}: origin ${origin}, work ${referenceX}`).toBeLessThanOrEqual(1)
    return null
  }
  const title = reading.title!
  expect(title.attached, 'the bar carries a title').toBe(true)
  expect(titleFits(title), 'title fits its intrinsic words or protects the long-title floor').toBe(true)
  // Bars slot 2 and the approved Agent/Settings drawing put the parent
  // before the child. Pin that entire place origin, and separately keep
  // the child's intrinsic title room; work title-x stays in B6.
  expect(Math.abs(origin - referenceX), `${reading.destination} place origin`).toBeLessThanOrEqual(1)
  return { destination: reading.destination, origin, childX: title.x, titleWidth: title.width }
}

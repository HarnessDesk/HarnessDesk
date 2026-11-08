import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { checkLead } from './frame-contract-leads-rules'
import type { LeadReading, LeadState } from './frame-contract-leads-snapshot'

/**
 * The B10 lead rules run in Node, over a reading. Each case breaks one fact
 * of a synthesised reading — shaped like the ones the browser takes — and
 * expects the rule to fail with its own message. No browser starts.
 */

const reference = 280
const barTitled: LeadReading = {
  destination: 'dashboard-overview', settings: false, returnToMain: null,
  leadButtons: ['Show sidebar', 'Back', 'Forward'], workTools: 0, barTitles: 1, settingsHeadings: [], barHeight: null,
  content: null, title: { attached: true, width: 120, intrinsic: 120, x: reference + 20 }, placeX: reference,
}
const settings: LeadReading = {
  ...barTitled, destination: 'settings-general', settings: true, leadButtons: ['Show sidebar'], barTitles: 0,
  settingsHeadings: ['General'], barHeight: FRAME.bar.height,
  content: { canvas: false, headings: 1, headingX: 324, edge: 324 }, title: null, placeX: null,
}
const canvas: LeadReading = { ...barTitled, destination: 'flows-canvas', barTitles: 0, content: { canvas: true, headings: 0, headingX: null, edge: 8 }, title: null, placeX: null }
const standing = (reading: LeadReading): LeadReading => ({ ...reading, leadButtons: [], title: null })

/** A rule's failure as a person reads it: the matcher's colour codes highlight inside quoted values. */
const failure = (run: () => void): string | null => {
  try {
    run()
  } catch (error) {
    return (error as Error).message.replace(/\u001b\[[0-9;]*m/g, '')
  }
  return null
}

test('well-formed readings pass in every window state', () => {
  for (const state of ['wide', 'narrow'] as LeadState[]) {
    expect(checkLead(barTitled, reference, state)).toEqual({ destination: 'dashboard-overview', origin: reference, childX: reference + 20, titleWidth: 120 })
    expect(checkLead(settings, reference, state)).toBeNull()
    expect(checkLead(canvas, reference, state)).toBeNull()
  }
  expect(checkLead(standing(barTitled), reference, 'standing')).toBeNull()
  expect(checkLead({ ...standing(settings) }, reference, 'standing')).toBeNull()
  expect(checkLead({ ...barTitled, returnToMain: { barButtons: 0, visible: true } }, reference, 'wide')).not.toBeNull()
})

const breaks: [string, () => unknown, RegExp][] = [
  ['an overlay bar with buttons of its own', () => checkLead({ ...barTitled, returnToMain: { barButtons: 2, visible: true } }, reference, 'wide'), /the overlay bar has no buttons but Return to main/],
  ['a hidden Return to main', () => checkLead({ ...barTitled, returnToMain: { barButtons: 0, visible: false } }, reference, 'wide'), /Return to main is visible/],
  ['a lead without history', () => checkLead({ ...barTitled, leadButtons: ['Show sidebar'] }, reference, 'wide'), /toHaveLength/],
  ['lead controls out of order', () => checkLead({ ...barTitled, leadButtons: ['Back', 'Show sidebar', 'Forward'] }, reference, 'narrow'), /toEqual/],
  ['Settings carrying history', () => checkLead({ ...settings, leadButtons: ['Show sidebar', 'Back', 'Forward'] }, reference, 'wide'), /toHaveLength/],
  ['a standing lead with controls', () => checkLead({ ...standing(barTitled), leadButtons: ['Show sidebar'] }, reference, 'standing'), /toHaveLength/],
  ['work tools on a non-work page', () => checkLead({ ...barTitled, workTools: 1 }, reference, 'wide'), /a non-work page has no work tools/],
  ['Settings titled in the bar', () => checkLead({ ...settings, barTitles: 1 }, reference, 'wide'), /Settings puts no title in the bar/],
  ['Settings without a title', () => checkLead({ ...settings, settingsHeadings: [] }, reference, 'narrow'), /the Settings page has one title/],
  ['Settings with an empty title', () => checkLead(standing({ ...settings, settingsHeadings: [' '] }), reference, 'standing'), /toMatch/],
  ['Settings bar height', () => checkLead({ ...settings, barHeight: FRAME.bar.height + 4 }, reference, 'wide'), new RegExp(String(FRAME.bar.height))],
  ['a title column with a bar title', () => checkLead({ ...canvas, barTitles: 1 }, reference, 'wide'), /a page with its own title column puts none in the bar/],
  ['a titled canvas', () => checkLead({ ...canvas, content: { ...canvas.content!, headings: 1 } }, reference, 'wide'), /a canvas page has no title/],
  ['a title column without its title', () => checkLead({ ...settings, content: { ...settings.content!, headings: 0, headingX: null } }, reference, 'wide'), /the title column has one title/],
  ['a title off the column edge', () => checkLead({ ...settings, content: { ...settings.content!, headingX: 330 } }, reference, 'wide'), /toBeCloseTo/],
  ['a bar with no title', () => checkLead({ ...barTitled, title: { attached: false, width: 0, intrinsic: 0, x: 0 } }, reference, 'wide'), /the bar carries a title/],
  ['a short title clipped', () => checkLead({ ...barTitled, title: { ...barTitled.title!, width: 100 } }, reference, 'narrow'), /title fits its intrinsic words or protects the long-title floor/],
  ['a long title under its floor', () => checkLead({ ...barTitled, title: { ...barTitled.title!, width: FRAME.bar.titleMin - 20, intrinsic: 500 } }, reference, 'wide'), /title fits its intrinsic words or protects the long-title floor/],
  ['a long title past its ceiling', () => checkLead({ ...barTitled, title: { ...barTitled.title!, width: FRAME.bar.titleMax + 20, intrinsic: 500 } }, reference, 'wide'), /title fits its intrinsic words or protects the long-title floor/],
  ['a place origin off the work origin', () => checkLead({ ...barTitled, placeX: reference + 2 }, reference, 'wide'), /dashboard-overview place origin/],
  ['a standing place origin off the work origin', () => checkLead({ ...standing(barTitled), placeX: reference - 2 }, reference, 'standing'), /dashboard-overview: origin 278, work 280/],
]

for (const [name, run, message] of breaks) test(`the lead rules catch ${name}`, () => {
  const said = failure(run)
  expect(said, 'the rule fails').not.toBeNull()
  expect(said).toMatch(message)
})

import { expect, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

/** Canonical Team slots, scoped to one synthetic fixture's shell. */
export const teamBar = (frame: Locator): Locator => frame.locator('[data-slot="top-bar"]:visible').first()

/** Select the real destination without prescribing a content fixture's width. */
export const selectTeamDestination = async (frame: Locator, value: string): Promise<void> => {
  const bar = teamBar(frame)
  const tab = bar.locator(`[data-team-page="${value}"]:visible`)
  const folded = bar.getByTitle('Destination views', { exact: true })
  // The click resolves either live representation. Only an actually opened
  // menu needs a second click; a direct selection may immediately refold.
  await tab.or(folded).first().click()
  const item = frame.page().locator(`[role="menu"] [data-team-page="${value}"]:visible`)
  if (await bar.locator('button[title="Destination views"][aria-expanded="true"]').count()) {
    await tab.or(item).first().click()
  }
  const label = ({ overview: 'Overview', run: 'Run', board: 'Board', room: 'Chat', findings: 'Findings', runs: 'Runs', receipt: 'Receipt' } as Record<string, string>)[value]
  if (!label) throw new Error(`Unknown Team destination: ${value}`)
  await expect(bar.locator(`[data-team-page="${value}"][aria-selected="true"]:visible`)
    .or(folded.filter({ hasText: new RegExp(`^${label}(?:\\s*\\d+)?$`) }))).toHaveCount(1)
}

export const selectTeamPage = async (frame: Locator, value: string): Promise<void> => {
  const bar = teamBar(frame)
  await expect.poll(async()=>(await bar.locator('[data-topbar-title]').boundingBox())?.width??0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
  await selectTeamDestination(frame, value)
}

export const teamDetails = async (frame: Locator): Promise<Locator> => {
  // Return another open Details mode through its lit door when the fixture
  // needs the default Team facts. A lit door always closes on its first press.
  const body = frame.locator('[data-slot="tool-body"]:visible').filter({has:frame.page().getByText('Seats',{exact:true})})
  const tool = teamBar(frame).locator('[data-work-tool="details"]')
  if (await body.count() === 0) {
    if (await tool.getAttribute('aria-pressed') === 'true') await tool.click()
    await tool.click()
  }
  await expect(body).toHaveCount(1)
  return body
}

export const teamSeats = async (frame: Locator): Promise<Locator> => {
  const body = await teamDetails(frame)
  const seats = body.locator('[data-slot="tool-section"]').filter({ has: frame.page().getByText('Seats', { exact: true }) })
  await expect(seats).toHaveCount(1)
  return seats
}

export const seatActions = async (frame: Locator, name: string): Promise<Locator> => {
  const seats = await teamSeats(frame)
  await seats.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()
  return frame.page().getByRole('menu').filter({ has: frame.page().getByRole('menuitem', { name: /^Open conversation(?:\s|$)/ }) })
}

export const closeTeamDetails = async (frame: Locator): Promise<void> => {
  if (await frame.locator('[data-slot="tool-body"]:visible').count()) {
    await teamBar(frame).getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(frame.locator('[data-slot="tool-body"]:visible')).toHaveCount(0)
  }
}

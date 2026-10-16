import { expectTitleRoom } from './title-contract'
import { expect, type Locator } from '@playwright/test'

/** Canonical Team slots, scoped to one synthetic fixture's shell. */
export const teamBar = (frame: Locator): Locator => frame.locator('[data-slot="top-bar"]:visible').first()

/** Body controls sit behind the floating rail until the person puts it away. */
export const closeFloatingTeamRail = async (frame: Locator): Promise<void> => {
  const shell = frame.locator('[data-slot="fixed-shell"]:visible').first()
  if (await shell.count() && await shell.getAttribute('data-rail-floats') === 'true' && await shell.getAttribute('data-rail-open') === 'true') {
    await teamBar(frame).locator('[data-work-rail-toggle]').click()
    await expect(shell).toHaveAttribute('data-rail-open', 'false')
  }
}

/** Select the real destination without prescribing a content fixture's width. */
export const selectTeamDestination = async (frame: Locator, value: string): Promise<void> => {
  await closeFloatingTeamRail(frame)
  const tab = frame.locator(`[data-team-page="${value}"]:visible`)
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

export const selectTeamPage = async (frame: Locator, value: string): Promise<void> => {
  const bar = teamBar(frame)
  await expectTitleRoom(bar.locator('[data-topbar-title]'))
  await selectTeamDestination(frame, value)
}

export const teamDetails = async (frame: Locator): Promise<Locator> => {
  const body = frame.locator('[data-frame-region="rail"] [data-slot="tool-body"]:visible').filter({has:frame.page().getByText('Seats',{exact:true})})
  const tool = teamBar(frame).locator('[data-work-rail-toggle]')
  if (await tool.getAttribute('aria-pressed') !== 'true') await tool.click()
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
  if (await frame.locator('[data-frame-region="rail"] [data-slot="tool-body"]:visible').count()) {
    await teamBar(frame).getByRole('button', { name: 'Toggle rail', exact: true }).click()
    await expect(frame.locator('[data-frame-region="rail"] [data-slot="tool-body"]:visible')).toHaveCount(0)
  }
}

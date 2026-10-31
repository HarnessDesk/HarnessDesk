import { devices, expect, test } from '@playwright/test'
import { stageDestination } from './frame-contract-popup-batch'
import { readInBothThemes, readPopups, settlePopups } from './frame-contract-popup-snapshot'
import { openFrame } from './frame-contract-helpers'
import { applyFrameActions } from './frame-actions'
import { useFrameContractEvidence } from './frame-contract-split-setup'
import { openWallDestination } from './frame-wall-actions'
import { WALL_DESTINATIONS } from './frame-wall-destinations'
import { applyLeftColumnActions, applySettingsNavigationActions } from './left-column-actions'

/**
 * The C10 popup specs read a destination's ink in the second theme by
 * switching the rendered page in place rather than loading it again
 * (`frame-contract-popup-snapshot.ts`). That is sound only while the theme is
 * the body attribute and its colour scheme: a popup that chose its colours in
 * script would read differently. These destinations cover every popup kind,
 * refused and destructive rows, hints, groups and facts; each is read both
 * ways and the readings must be the same.
 */
const IDS = ['popup-disabled-rows', 'popup-menu-icons', 'popup-wide-menu', 'popup-info-card', 'left-account', 'popup-select-disabled']

useFrameContractEvidence()
for (const id of IDS) test(`the in-place theme switch reads ${id} as its own load does`, async ({ page, browser }) => {
  const destination = WALL_DESTINATIONS.find(destination => destination.id === id)!
  await stageDestination(page, destination, 1440)
  const switched = (await readInBothThemes(page, id, 1440)).readings[1]
  expect(switched, `${id} has a popup to read`).toBeDefined()
  const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce', baseURL: test.info().project.use.baseURL })
  try {
    const loaded = await context.newPage()
    await openFrame(loaded, destination.query, 'dark', 1440)
    await applyFrameActions(loaded, destination)
    await applyLeftColumnActions(loaded, destination)
    await applySettingsNavigationActions(loaded, destination)
    await openWallDestination(loaded, destination)
    await settlePopups(loaded)
    expect(await readPopups(loaded, 'dark', false)).toEqual(switched)
  } finally {
    await context.close()
  }
})

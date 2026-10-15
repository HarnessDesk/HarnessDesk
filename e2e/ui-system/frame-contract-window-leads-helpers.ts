import { expect, type Page, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { B10_NONWORK_DESTINATIONS } from './frame-contract-helpers'



export const windowBar = (page: Page) => page.locator('[data-frame-region="top"] [data-slot="top-bar"]')
export const expectLead = async (bar: Locator, width: number, settings: boolean, away: boolean) => {
  const names = !away ? [] : settings ? ['Show sidebar'] : width < FRAME.fold.sidebarFloats
    ? ['Show sidebar', 'Search everything'] : ['Show sidebar', 'Search everything', 'Back', 'Forward']
  await expect(bar.locator('[data-topbar="lead"]').getByRole('button')).toHaveCount(names.length)
  expect(await bar.locator('[data-topbar="lead"]').getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(names)
}
export const expectQuietSettings = async (page: Page, bar: Locator) => {
  // AUDIT-3b R10.33-34: an empty bar, with the page still named accessibly.
  await expect(bar.locator('[data-topbar-title]')).toHaveText('')
  await expect(page.locator('[data-page-destination="settings"]:visible h1')).toHaveText(/\S/)
  expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
}

// Every destination remains checked; batches bound repeated full-frame mounts.
export const nonworkGroups = Array.from({ length: Math.ceil(B10_NONWORK_DESTINATIONS.length / 8) }, (_, group) =>
  B10_NONWORK_DESTINATIONS.slice(group * 8, (group + 1) * 8))

import { expect, type Page, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { B10_NONWORK_DESTINATIONS } from './frame-contract-helpers'



export const windowBar = (page: Page) => page.locator('[data-frame-region="top"] [data-slot="top-bar"]')
export const expectLead = async (bar: Locator, _width: number, settings: boolean, away: boolean) => {
  const names = !away ? [] : settings ? ['Show sidebar'] : ['Show sidebar', 'Back', 'Forward']
  await expect(bar.locator('[data-topbar="lead"]').getByRole('button')).toHaveCount(names.length)
  expect(await bar.locator('[data-topbar="lead"]').getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(names)
}
export const expectQuietSettings = async (page: Page, bar: Locator) => {
  // D1 names Settings in the bar and keeps the current route's heading in its body.
  await expect(bar.locator('[data-topbar-title]')).toHaveText('Settings')
  await expect(page.locator('[data-page-destination="settings"]:visible h1')).toHaveText(/\S/)
  expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
}

// Every destination remains checked; batches bound repeated full-frame mounts.
export const nonworkGroups = Array.from({ length: Math.ceil(B10_NONWORK_DESTINATIONS.length / 8) }, (_, group) =>
  B10_NONWORK_DESTINATIONS.slice(group * 8, (group + 1) * 8))

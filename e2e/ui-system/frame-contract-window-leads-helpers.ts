import { expect, type Page, type Locator } from '@playwright/test'
import { settleFrameBar } from './frame-actions'
import { FRAME } from '../../packages/ui/src/design/frame'
import { B10_NONWORK_DESTINATIONS } from './frame-contract-helpers'



export const windowBar = (page: Page) => page.locator('[data-frame-region="top"] [data-slot="top-bar"]')
export const expectContentTitle = async (page: Page, bar: Locator): Promise<boolean> => {
  const column = page.locator('[data-page-destination]:visible [data-slot="page"]').first()
  if (!await column.count()) return false
  await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
  const title = column.getByRole('heading', { level: 1 })
  if (await column.getAttribute('data-width') === 'canvas') {
    await expect(title).toHaveCount(0)
    return true
  }
  await expect(title).toHaveCount(1)
  const edge = await column.evaluate(node => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft))
  expect((await title.boundingBox())!.x).toBeCloseTo(edge, 1)
  return true
}
export const expectLead = async (bar: Locator, _width: number, settings: boolean, away: boolean) => {
  await settleFrameBar(bar)
  const returnToMain = bar.page().getByRole('button', { name: 'Return to main', exact: true })
  if (await returnToMain.count()) {
    await expect(bar.getByRole('button')).toHaveCount(0)
    await expect(returnToMain).toBeVisible()
    await returnToMain.click()
  }
  // Every non-Settings destination carries history while the sidebar is away.
  const names = !away ? [] : settings ? ['Show sidebar'] : ['Show sidebar', 'Back', 'Forward']
  await expect(bar.locator('[data-topbar="lead"]').getByRole('button')).toHaveCount(names.length)
  expect(await bar.locator('[data-topbar="lead"]').getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(names)
}
export const expectQuietSettings = async (page: Page, bar: Locator) => {
  // The current Settings route names itself in the content column only.
  await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
  await expect(page.locator('[data-page-destination="settings"]:visible h1')).toHaveText(/\S/)
  expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
}

// Every destination remains checked; batches bound repeated full-frame mounts.
export const nonworkGroups = Array.from({ length: Math.ceil(B10_NONWORK_DESTINATIONS.length / 8) }, (_, group) =>
  B10_NONWORK_DESTINATIONS.slice(group * 8, (group + 1) * 8))

import { expect, test, type Locator, type Page } from '@playwright/test'

const openBoard = async (page: Page, name: string) => {
  await page.goto('/design.html')
  await page.getByRole('button', { name }).click()
  await page.locator('main h1').first().waitFor({ state: 'visible' })
  await expect(page.getByText('Mounting the screen…')).toBeHidden()
}

const capGaps = async (text: Locator, container: Locator) => text.evaluate((element, containerElement) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let line: DOMRect | undefined
  while (walker.nextNode() && !line) {
    const node = walker.currentNode as Text
    if (!node.textContent?.trim()) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    line = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0)
  }
  if (!line) throw new Error('Expected visible single-line text')
  const style = getComputedStyle(element)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')!
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const font = context.measureText(element.textContent ?? '')
  const cap = context.measureText('H')
  const baseline = line.top + (line.height - font.fontBoundingBoxAscent - font.fontBoundingBoxDescent) / 2 + font.fontBoundingBoxAscent
  const box = containerElement.getBoundingClientRect()
  const containerStyle = getComputedStyle(containerElement)
  const top = box.top + (parseFloat(containerStyle.borderTopWidth) || 0)
  const bottom = box.bottom - (parseFloat(containerStyle.borderBottomWidth) || 0)
  const above = baseline - cap.actualBoundingBoxAscent - top
  const below = bottom - baseline
  return { above, below, imbalance: Math.abs(above - below) }
}, await container.elementHandle())

const boxGaps = async (glyph: Locator, container: Locator) => glyph.evaluate((element, containerElement) => {
  const box = element.getBoundingClientRect()
  const row = containerElement.getBoundingClientRect()
  const style = getComputedStyle(containerElement)
  const top = row.top + (parseFloat(style.borderTopWidth) || 0)
  const bottom = row.bottom - (parseFloat(style.borderBottomWidth) || 0)
  const above = box.top - top
  const below = bottom - box.bottom
  return { above, below, imbalance: Math.abs(above - below) }
}, await container.elementHandle())

const expectCentered = async (element: Locator, row: Locator, label: string) => {
  const [box, rowBox] = await Promise.all([element.boundingBox(), row.boundingBox()])
  expect(box, `${label} should be visible`).not.toBeNull()
  expect(rowBox).not.toBeNull()
  expect(Math.abs(box!.y + box!.height / 2 - (rowBox!.y + rowBox!.height / 2)), `${label} centre`).toBeLessThanOrEqual(1)
}

test('one-line notices centre every part; wrapped notices keep the lead on line one', async ({ page }) => {
  await openBoard(page, 'Notices')
  const board = page.locator('[data-alignment-board-id="notices"]')
  const composer = board.locator('[data-slot="composer-notice"]').filter({ hasText: 'Alpha can continue.' }).first()
  await expect(composer).toBeVisible()
  const composerRow = composer
  const composerLine = composer.locator('[data-slot="notice-message-line"]')
  await expect(composerLine).toBeVisible()
  await expectCentered(composerLine, composerRow, 'composer text')
  await expectCentered(composer.locator('[data-slot="notice-lead"] [data-size="md"]'), composerRow, 'composer lead')
  const composerLeadGlyph = composer.locator('[data-slot="notice-lead"] [data-size="md"] svg')
  const composerAction = composer.getByRole('button', { name: 'Continue with Alpha' })
  const composerDismissGlyph = composer.getByRole('button', { name: 'Dismiss' }).locator('svg')
  await expectCentered(composerAction, composerRow, 'composer action')
  await expectCentered(composerDismissGlyph, composerRow, 'composer dismiss glyph')
  for (const glyph of [composerLeadGlyph, composerDismissGlyph]) expect((await boxGaps(glyph, composerRow)).imbalance).toBeLessThanOrEqual(1)
  expect((await capGaps(composerAction, composerRow)).imbalance, 'composer action cap-height gaps').toBeLessThanOrEqual(1)
  for (const text of await composer.locator('[data-part="notice-title"], [data-part="notice-detail"]').all()) {
    expect((await capGaps(text, composerRow)).imbalance, 'composer cap-height gaps').toBeLessThanOrEqual(1)
  }

  const strip = board.locator('[data-slot="notice-strip"]').filter({ hasText: 'Alpha can continue.' }).first()
  await expect(strip).toBeVisible()
  await expectCentered(strip.locator('[data-slot="notice-message-line"]'), strip, 'strip text')
  await expectCentered(strip.locator('[data-slot="notice-lead"] [data-size="sm"]'), strip, 'strip lead')
  const stripLeadGlyph = strip.locator('[data-slot="notice-lead"] [data-size="sm"] svg')
  const stripAction = strip.getByRole('button', { name: 'Continue with Alpha' })
  const stripDismissGlyph = strip.getByRole('button', { name: 'Dismiss' }).locator('svg')
  await expectCentered(stripAction, strip, 'strip action')
  await expectCentered(stripDismissGlyph, strip, 'strip dismiss glyph')
  for (const glyph of [stripLeadGlyph, stripDismissGlyph]) expect((await boxGaps(glyph, strip)).imbalance).toBeLessThanOrEqual(1)
  expect((await capGaps(stripAction, strip)).imbalance, 'strip action cap-height gaps').toBeLessThanOrEqual(1)
  expect((await capGaps(strip.locator('[data-part="notice-title"]'), strip)).imbalance, 'strip cap-height gaps').toBeLessThanOrEqual(1)

  await openBoard(page, 'Banner')
  const bannerBoard = page.locator('[data-alignment-board-id="banner"]')
  const banner = bannerBoard.locator('[data-tone="warning"]').filter({ hasText: 'Alpha can continue.' }).first()
  await expect(banner).toBeVisible()
  await expectCentered(banner.locator('[data-slot="alert-content"]'), banner, 'banner text')
  await expectCentered(banner.locator('[data-part="banner-icon"]'), banner, 'banner lead')
  const bannerAction = banner.getByRole('button', { name: 'Continue with Alpha' })
  const bannerDismissGlyph = banner.getByRole('button', { name: 'Dismiss' }).locator('svg')
  await expectCentered(bannerAction, banner, 'banner action')
  await expectCentered(bannerDismissGlyph, banner, 'banner dismiss glyph')
  for (const glyph of [banner.locator('[data-part="banner-icon"] svg'), bannerDismissGlyph]) expect((await boxGaps(glyph, banner)).imbalance).toBeLessThanOrEqual(1)
  expect((await capGaps(bannerAction, banner)).imbalance, 'banner action cap-height gaps').toBeLessThanOrEqual(1)
  expect((await capGaps(banner.locator('[data-slot="alert-title"]'), banner)).imbalance, 'banner cap-height gaps').toBeLessThanOrEqual(1)

  const wrappedBanner = bannerBoard.locator('[data-slot="alert"][data-tone="warning"]').filter({ hasText: 'Alpha needs your decision.' }).first()
  await expect(wrappedBanner).toBeVisible()
  const titleLine = await wrappedBanner.locator('[data-slot="alert-title"]').evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const first = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0)
    return first ? { top: first.top, height: first.height } : undefined
  })
  const wrappedIcon = await wrappedBanner.locator('[data-part="banner-icon"]').boundingBox()
  const wrappedRow = await wrappedBanner.boundingBox()
  const wrappedAction = await wrappedBanner.getByRole('button', { name: 'Continue with Alpha' }).boundingBox()
  const wrappedDismiss = await wrappedBanner.getByRole('button', { name: 'Dismiss' }).boundingBox()
  expect(titleLine).toBeDefined()
  expect(Math.abs(wrappedIcon!.y + wrappedIcon!.height / 2 - (titleLine!.top + titleLine!.height / 2)), 'wrapped banner lead stays on the first line').toBeLessThanOrEqual(1)
  expect(Math.abs(wrappedAction!.y + wrappedAction!.height / 2 - (wrappedRow!.y + wrappedRow!.height / 2)), 'wrapped banner action centres on the card').toBeLessThanOrEqual(1)
  expect(Math.abs(wrappedDismiss!.y + wrappedDismiss!.height / 2 - (wrappedRow!.y + wrappedRow!.height / 2)), 'wrapped banner dismiss centres on the card').toBeLessThanOrEqual(1)

  await openBoard(page, 'Notices')
  const wrapped = page.locator('[data-alignment-board-id="notices"] [data-slot="composer-notice"]').filter({ hasText: 'Alpha needs your decision.' }).first()
  await expect(wrapped).toBeVisible()
  const line = wrapped.locator('[data-slot="notice-message-line"]')
  const lineTops = await line.evaluate(element => {
    const tops: number[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (!node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      tops.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.top))
    }
    return tops.sort((a, b) => a - b).filter((top, index, all) => index === 0 || Math.abs(top - all[index - 1]!) >= 1)
  })
  const lead = await wrapped.locator('[data-slot="notice-lead"] [data-size="md"]').boundingBox()
  const row = await wrapped.boundingBox()
  const action = await wrapped.getByRole('button', { name: 'Continue with Alpha' }).boundingBox()
  const dismiss = await wrapped.getByRole('button', { name: 'Dismiss' }).boundingBox()
  expect(lineTops).toHaveLength(2)
  expect(Math.abs(lead!.y + lead!.height / 2 - (lineTops[0]! + 10)), 'wrapped lead stays on the first line').toBeLessThanOrEqual(2)
  expect(Math.abs(action!.y + action!.height / 2 - (row!.y + row!.height / 2)), 'wrapped action centres on the row').toBeLessThanOrEqual(1)
  expect(Math.abs(dismiss!.y + dismiss!.height / 2 - (row!.y + row!.height / 2)), 'wrapped dismiss centres on the row').toBeLessThanOrEqual(1)
})

import { expect, test, type Locator, type Page } from '@playwright/test'

// The 13px font's ascent/descent asymmetry contributes about 1px to cap-height gaps.
const GLYPH_GAP_TOLERANCE = 1.5

const openBoard = async (page: Page, name: string) => {
  await page.goto('/design.html')
  await page.getByRole('button', { name, exact: true }).click()
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

const textRects = async (text: Locator) => text.evaluate(element => {
  const rects: { top: number; left: number; right: number; height: number }[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.textContent?.trim()) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    rects.push(...[...range.getClientRects()]
      .filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => ({ top: rect.top, left: rect.left, right: rect.right, height: rect.height })))
  }
  return rects.sort((a, b) => a.top - b.top || a.left - b.left)
})

const distinctLineRects = async (text: Locator) => {
  const rects = await textRects(text)
  return rects.filter((rect, index) => index === 0 || Math.abs(rect.top - rects[index - 1]!.top) >= 1)
}

// Legacy composer hosts move in part 2 and retain their first-line contract.
const expectLeadOnFirstLine = async (lead: Locator, text: Locator, label: string) => {
  const [leadBox, lines] = await Promise.all([lead.boundingBox(), distinctLineRects(text)])
  expect(lines.length, `${label} should contain multiple line tops`).toBeGreaterThan(1)
  expect(leadBox).not.toBeNull()
  expect(Math.abs(leadBox!.y + leadBox!.height / 2 - (lines[0]!.top + lines[0]!.height / 2)), `${label} lead follows line one`).toBeLessThanOrEqual(2)
}

test('one-line notices centre every part; wrapped banners centre the tile on the copy', async ({ page }) => {
  await openBoard(page, 'Notice')
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
  for (const glyph of [composerLeadGlyph, composerDismissGlyph]) expect((await boxGaps(glyph, composerRow)).imbalance).toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)
  expect((await capGaps(composerAction, composerRow)).imbalance, 'composer action cap-height gaps').toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)
  for (const text of await composer.locator('[data-part="notice-title"], [data-part="notice-detail"]').all()) {
    expect((await capGaps(text, composerRow)).imbalance, 'composer cap-height gaps').toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)
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
  for (const glyph of [stripLeadGlyph, stripDismissGlyph]) expect((await boxGaps(glyph, strip)).imbalance).toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)
  expect((await capGaps(stripAction, strip)).imbalance, 'strip action cap-height gaps').toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)
  expect((await capGaps(strip.locator('[data-part="notice-title"]'), strip)).imbalance, 'strip cap-height gaps').toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)

  await openBoard(page, 'Notice')
  const bannerBoard = page.locator('[data-legacy-banner-examples]')
  const banner = bannerBoard.locator('[data-slot="alert"][data-tone="warning"]').filter({ hasText: 'Alpha can continue.' }).first()
  await expect(banner).toBeVisible()
  await expectCentered(banner.locator('[data-slot="alert-content"]'), banner, 'banner text')
  await expectCentered(banner.locator('[data-part="banner-icon"]'), banner, 'banner lead')
  const bannerAction = banner.getByRole('button', { name: 'Continue with Alpha' })
  const bannerDismissGlyph = banner.getByRole('button', { name: 'Dismiss' }).locator('svg')
  await expectCentered(bannerAction, banner, 'banner action')
  await expectCentered(bannerDismissGlyph, banner, 'banner dismiss glyph')
  for (const glyph of [banner.locator('[data-part="banner-icon"] svg'), bannerDismissGlyph]) expect((await boxGaps(glyph, banner)).imbalance).toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)
  expect((await capGaps(bannerAction, banner)).imbalance, 'banner action cap-height gaps').toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)
  expect((await capGaps(banner.locator('[data-slot="alert-title"]'), banner)).imbalance).toBeLessThanOrEqual(GLYPH_GAP_TOLERANCE)

  const wrappedBanner = bannerBoard.locator('[data-slot="alert"][data-tone="warning"]').filter({ hasText: 'Alpha needs your decision.' }).first()
  await expect(wrappedBanner).toBeVisible()
  await expect(wrappedBanner, 'Banner must report wrapped copy').toHaveAttribute('data-wrapped', '')
  expect((await distinctLineRects(wrappedBanner.locator('[data-slot="alert-content"]'))).length).toBeGreaterThanOrEqual(2)
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
  await expectCentered(wrappedBanner.locator('[data-part="banner-icon"]'), wrappedBanner.locator('[data-slot="alert-content"]'), 'wrapped tile')
  expect(Math.abs(wrappedAction!.y + wrappedAction!.height / 2 - (wrappedRow!.y + wrappedRow!.height / 2)), 'wrapped banner action centres on the card').toBeLessThanOrEqual(1)
  const padding = await wrappedBanner.evaluate(el => parseFloat(getComputedStyle(el).paddingTop))
  expect(wrappedDismiss!.y - wrappedRow!.y).toBeCloseTo(padding, 0)

  await openBoard(page, 'Notice')
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

test('composer action placement follows narrow and wide container resizes', async ({ page }) => {
  await openBoard(page, 'Notice')
  const composer = page.locator('[data-alignment-board-id="notices"] [data-slot="composer-notice"]')
    .filter({ hasText: 'Alpha can continue.' }).first()
  const line = composer.locator('[data-slot="notice-message-line"]')
  const lead = composer.locator('[data-slot="notice-lead"] [data-size="md"]')
  const parent = composer.locator('xpath=..')
  await expect(composer).toBeVisible()
  await expect(composer).not.toHaveAttribute('data-wrapped', '')

  await parent.evaluate(element => { (element as HTMLElement).style.width = '320px' })
  const narrowLine = (await line.boundingBox())!
  const narrowAction = (await composer.getByRole('button', { name: 'Continue with Alpha' }).boundingBox())!
  expect(narrowAction.y, 'the action leaves the full row for copy').toBeGreaterThanOrEqual(narrowLine.y + narrowLine.height)
  await expectCentered(composer.getByRole('button', { name: 'Dismiss' }), line, 'narrow composer dismiss')

  await parent.evaluate(element => { (element as HTMLElement).style.width = '900px' })
  await expect(composer).not.toHaveAttribute('data-wrapped', '')
  await expectCentered(lead, composer, 'widened composer lead')
})

test('unbreakable notice paths wrap before controls and a card keeps its copy inside', async ({ page }) => {
  await openBoard(page, 'Notice')
  const board = page.locator('[data-alignment-board-id="notices"]')
  const composer = board.locator('[data-slot="composer-notice"]').filter({ hasText: 'unbreakablepathsegment' })
  await expect(composer).toHaveAttribute('data-wrapped', '')
  const composerLine = composer.locator('[data-slot="notice-message-line"]')
  expect((await distinctLineRects(composerLine)).length).toBeGreaterThanOrEqual(3)
  await expectLeadOnFirstLine(composer.locator('[data-slot="notice-lead"] [data-size="md"]'), composerLine, 'long-path composer')
  const composerAction = await composer.getByRole('button', { name: 'Continue with Alpha' }).boundingBox()
  expect(composerAction).not.toBeNull()
  for (const rect of await textRects(composerLine)) {
    expect(rect.right <= composerAction!.x || rect.left >= composerAction!.x + composerAction!.width
      || rect.top + rect.height <= composerAction!.y || rect.top >= composerAction!.y + composerAction!.height,
    'composer path must not enter action, including when it folds below').toBe(true)
  }
  const composerDismiss = await composer.getByRole('button', { name: 'Dismiss' }).boundingBox()
  expect(composerDismiss).not.toBeNull()
  expect(Math.max(...(await textRects(composerLine)).map(rect => rect.right)), 'composer path must not enter dismiss').toBeLessThanOrEqual(composerDismiss!.x)

  const card = board.locator('[data-slot="notice-card"]').filter({ hasText: 'unbreakablepathsegment' })
  const cardBox = await card.boundingBox()
  const cardText = card.locator('[data-part="notice-title"], [data-slot="notice-description"]')
  expect(cardBox).not.toBeNull()
  for (const text of await cardText.all()) {
    const box = await text.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width, 'card copy stays within the card').toBeLessThanOrEqual(cardBox!.x + cardBox!.width)
    const rects = await textRects(text)
    expect(Math.max(...rects.map(rect => rect.right)), 'card path glyphs stay within the card').toBeLessThanOrEqual(cardBox!.x + cardBox!.width)
  }
})

test('notices retain optional action and dismiss controls', async ({ page }) => {
  await openBoard(page, 'Notice')
  const board = page.locator('[data-alignment-board-id="notices"]')
  const noDismiss = board.locator('[data-slot="composer-notice"]').filter({ hasText: 'Cursor is not signed in.' })
  await expect(noDismiss.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(noDismiss.getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
  const neither = board.locator('[data-slot="composer-notice"]').filter({ hasText: 'Reconnecting to the host…' })
  await expect(neither.getByRole('button')).toHaveCount(0)

  await openBoard(page, 'Notice')
  const banner = page.locator('[data-alignment-board-id="notices"] [data-slot="alert"]')
    .filter({ hasText: 'A newer version of the runtime is available.' })
  await expect(banner.getByRole('button', { name: 'Dismiss' })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Open settings' })).toHaveCount(0)
})

test('narrow Banner moves actions below wrapped copy and centres the tile on the copy', async ({ page }) => {
  await openBoard(page, 'Notice')
  const banner = page.locator('[data-alignment-board-id="notices"] [data-slot="alert"]')
    .filter({ hasText: 'unbreakablepathsegment' }).first()
  await expect(banner).toHaveAttribute('data-wrapped', '')
  const text = banner.locator('[data-slot="alert-content"]')
  expect(await distinctLineRects(text).then(lines => lines.length)).toBeGreaterThanOrEqual(3)
  await expectCentered(banner.locator('[data-part="banner-icon"]'), text, 'narrow Banner tile')
  const textBox = await text.boundingBox()
  const action = await banner.getByRole('button', { name: 'Continue with Alpha' }).boundingBox()
  expect(textBox).not.toBeNull()
  expect(action).not.toBeNull()
  expect(action!.y, 'narrow Banner action follows the copy').toBeGreaterThanOrEqual(textBox!.y + textBox!.height)
})

test('a strip notice gives its message the room it needs before it clips', async ({ page }) => {
  await openBoard(page, 'Notice')
  const strip = page.locator('[data-alignment-board-id="notices"] [data-slot="notice-strip"]')
    .filter({ hasText: 'Alpha can continue.' }).first()
  await expect(strip).toBeVisible()
  const line = strip.locator('[data-slot="notice-message-line"]')
  // The message and the spacer that pushes the pager to the edge both grew, so
  // they split the slack: a sentence wider than half of it was cut with an
  // ellipsis while the other half of the row stood empty. Lengthen the message
  // past half the row and check it still fits.
  await strip.evaluate((element) => {
    const title = element.querySelector('[data-part="notice-title"]')!
    const message = element.querySelector('[data-slot="notice-message-line"]') as HTMLElement
    const half = element.getBoundingClientRect().width / 2
    while (message.scrollWidth < half) title.textContent = `${title.textContent} and then some`
  })
  const { shown, needed } = await line.evaluate((element) => ({ shown: element.clientWidth, needed: element.scrollWidth }))
  expect(shown, 'the message is not clipped while the row has room').toBeGreaterThanOrEqual(needed)
})

test('a strip message too long for its row gives up its own width, never the pager', async ({ page }) => {
  await openBoard(page, 'Notice')
  const strip = page.locator('[data-alignment-board-id="notices"] [data-slot="notice-strip"]')
    .filter({ has: page.locator('[data-slot="notice-pager"]') }).first()
  await expect(strip).toBeVisible()
  const pager = strip.locator('[data-slot="notice-pager"]')
  const [stripBefore, pagerBefore] = await Promise.all([strip.boundingBox(), pager.boundingBox()])
  // With the message sized to its text, a sentence longer than the row leaves
  // no free space, so everything that may shrink does. The pager's "1 of 2"
  // breaks at its spaces, which made the strip taller.
  await strip.locator('[data-part="notice-title"]').evaluate((title) => {
    title.textContent = `${title.textContent} ${'and a great deal more to say about it '.repeat(40)}`
  })
  const [stripAfter, pagerAfter] = await Promise.all([strip.boundingBox(), pager.boundingBox()])
  expect(stripAfter!.height, 'the strip stays one line tall').toBeCloseTo(stripBefore!.height, 0)
  expect(pagerAfter!.width, 'the pager keeps its width').toBeCloseTo(pagerBefore!.width, 0)
})

const specimen = (page: Page, name: string) => page.locator(`[data-notice-case="${name}"] [data-slot="alert"]`)
for (const theme of ['light', 'dark'] as const) test.describe(`notice in ${theme}`, () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await openBoard(page, 'Notice')
  })
  test('one line centres every part', async ({ page }) => {
    const oneLine = specimen(page, 'standard-info-one-line-glyph')
    for (const part of ['[data-part="banner-icon"]', '[data-slot="alert-content"]', 'button']) {
      for (const el of await oneLine.locator(part).all()) await expectCentered(el, oneLine, part)
    }
  })
  test('wrapped copy centres the tile and actions, with a top-right dismiss', async ({ page }) => {
    const wrapped = specimen(page, 'standard-danger-wrapped-glyph')
    await expect(wrapped).toHaveAttribute('data-wrapped', '')
    await expectCentered(wrapped.locator('[data-part="banner-icon"]'), wrapped.locator('[data-slot="alert-content"]'), 'wrapped tile')
    await expectCentered(wrapped.getByRole('button', { name: 'View changes' }), wrapped.locator('[data-slot="alert-content"]'), 'wrapped action')
    const box = await wrapped.boundingBox()
    const dismiss = await wrapped.getByRole('button', { name: 'Dismiss' }).boundingBox()
    const padding = await wrapped.evaluate(el => parseFloat(getComputedStyle(el).paddingTop))
    expect(dismiss!.y - box!.y).toBeCloseTo(padding, 0)
  })
  test('danger marks a neutral plate with its bar and tinted tile', async ({ page }) => {
    const wrapped = specimen(page, 'standard-danger-wrapped-glyph')
    const colours = await wrapped.evaluate(el => {
      const style = getComputedStyle(el)
      const bar = getComputedStyle(el, '::before')
      const tile = getComputedStyle(el.querySelector('[data-slot="icon-tile"]')!)
      const probe = document.createElement('span'); el.append(probe)
      probe.style.background = 'var(--hd-card)'; const card = getComputedStyle(probe).backgroundColor
      probe.style.background = 'var(--hd-danger-dim)'; const dim = getComputedStyle(probe).backgroundColor
      probe.style.color = 'var(--hd-danger-ink)'; const ink = getComputedStyle(probe).color
      probe.style.background = 'var(--hd-danger)'; const danger = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { ground: style.backgroundColor, card, bar: bar.backgroundColor, danger, barWidth: bar.width, tile: tile.backgroundColor, dim, ink: tile.color, expectedInk: ink }
    })
    expect(colours.ground).toBe(colours.card)
    expect(colours.bar).toBe(colours.danger)
    expect(colours.barWidth).toBe('3px')
    expect(colours.tile).toBe(colours.dim)
    expect(colours.ink).toBe(colours.expectedInk)
  })
  test('three or more actions stack below copy', async ({ page }) => {
    const stacked = specimen(page, 'standard-success-stacked-glyph')
    const copy = await stacked.locator('[data-slot="alert-content"]').boundingBox()
    for (const button of await stacked.locator('button:not([aria-label="Dismiss"])').all()) {
      expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(copy!.y + copy!.height)
    }
    const three = page.locator('[data-notice-case="three-actions"] [data-slot="alert"]')
    const threeCopy = await three.locator('[data-slot="alert-content"]').boundingBox()
    for (const button of await three.locator('button').all()) expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(threeCopy!.y + threeCopy!.height)
  })
  test('the host chooses compact type and tile size', async ({ page }) => {
    const oneLine = specimen(page, 'standard-info-one-line-glyph')
    const compact = specimen(page, 'compact-info-one-line-glyph')
    expect(await compact.locator('[data-slot="alert-title"]').evaluate(el => getComputedStyle(el).fontSize)).toBe('13px')
    expect(await oneLine.locator('[data-slot="alert-title"]').evaluate(el => getComputedStyle(el).fontSize)).toBe('14px')
    expect(await compact.locator('[data-slot="icon-tile"]').evaluate(el => el.getBoundingClientRect().width)).toBe(24)
  })
  test('standard, compact and floating hosts use the approved padding', async ({ page }) => {
    for (const [host, expected] of [
      ['standard', ['12px', '12px', '12px', '16px']],
      ['compact', ['8px', '8px', '8px', '12px']],
      ['floating', ['8px', '8px', '8px', '12px']],
    ] as const) {
      expect(await specimen(page, `${host}-info-one-line-glyph`).evaluate(el => {
        const style = getComputedStyle(el)
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      })).toEqual(expected)
    }
  })
  test('a labelled icon-kind action fits its complete label', async ({ page }) => {
    const action = specimen(page, 'labelled-action').getByRole('button', { name: 'View the complete activity log' })
    await expect(action).toBeVisible()
    expect(await action.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const box = await action.boundingBox()
    expect(box!.width).toBeGreaterThan(box!.height)
    expect(box!.height).toBe(28)
  })
  test('floating toast alone takes the notice shadow', async ({ page }) => {
    const compact = specimen(page, 'compact-info-one-line-glyph')
    const shadow = (el: Locator) => el.evaluate(el => getComputedStyle(el).boxShadow)
    const flow = await shadow(compact)
    const floating = await shadow(specimen(page, 'floating-info-one-line-glyph'))
    expect(flow).not.toBe(floating)
    expect(await compact.evaluate(el => {
      const probe = document.createElement('div'); probe.style.boxShadow = 'inset 0 0 0 1px var(--hd-border-emphasis), var(--hd-composer-shell-shadow)'; el.append(probe)
      const expected = getComputedStyle(probe).boxShadow; probe.remove(); return expected
    })).toBe(flow)
  })
  test('the preview notice keeps the same tile radius when utilities load later', async ({ page }) => {
    await page.goto('/preview.html?notice-placement')
    const tile = page.locator('[data-frame-id="coverage-notice-folder-gone"] [data-part="banner-icon"]')
    await expect(tile).toBeAttached()
    expect(await tile.evaluate(el => getComputedStyle(el).borderRadius)).toBe('8px')
  })
  test('a narrow host folds its action below copy', async ({ page }) => {
    const narrow = page.locator('[data-notice-case="sidebar-narrow"] [data-slot="alert"]')
    const narrowText = await narrow.locator('[data-slot="alert-content"]').boundingBox()
    expect((await narrow.getByRole('button', { name: 'Continue', exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(narrowText!.y + narrowText!.height)
  })
})

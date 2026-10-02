import { expect, test, type Page } from '@playwright/test'

const shapes = ['Assistant A', 'Assistant B', 'Assistant C', 'Assistant D']
const slots = ['add', 'work-in', 'agent', 'permissions', 'mode', 'extension', 'more', 'context', 'model', 'send']

const aligned = (page: Page, width: string, layout: 'draft' | 'live') => page.evaluate(({ width, layout, shapes, slots }) => {
  const testedSlots = layout === 'draft' ? slots : slots.filter((slot) => slot !== 'work-in')
  const positions: Record<string, number[]> = Object.fromEntries(testedSlots.map((slot) => [slot, []]))
  for (const shape of shapes) {
    const section = document.querySelector<HTMLElement>(`[data-composer-width="${width}"] [data-composer-shape="${shape}"]`)
    const toolbar = section?.querySelector<HTMLElement>(`[data-composer-layout="${layout}"]`)
    if (!toolbar) return { aligned: false, positions }
    for (const slot of testedSlots) {
      const track = toolbar.querySelector<HTMLElement>(`[data-composer-track="${slot}"]`)
      if (track) positions[slot]?.push(Math.round(track.getBoundingClientRect().left))
    }
  }
  return {
    aligned: Object.values(positions).every((xs) => xs.length === shapes.length && new Set(xs).size === 1),
    positions,
  }
}, { width, layout, shapes, slots })

const labelsUntruncated = (page: Page, width: string, layout: 'draft' | 'live') => page.evaluate(({ width, layout }) => {
  const labels = document.querySelectorAll<HTMLElement>(`[data-composer-width="${width}"] [data-composer-layout="${layout}"] [data-slot="text"]`)
  return [...labels].every((label) => label.scrollWidth <= label.clientWidth)
}, { width, layout })

const boxGeometry = (page: Page) => page.evaluate(() => {
  const column = Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--hd-column'))
  const boxes = [...document.querySelectorAll<HTMLElement>('[data-composer-width]')]
  const widths = Object.fromEntries(boxes.map((box) => {
    const name = box.dataset.composerWidth!
    const expected = name === 'composer' ? column : Number(name)
    return [name, { actual: box.getBoundingClientRect().width, expected }]
  }))
  return {
    widths,
    valid: boxes.length === 4 && Object.values(widths).every(({ actual, expected }) => Math.abs(actual - expected) <= 2),
  }
})

const expectedFolds = {
  composer: {
    draft: ['agent', 'work-in', 'more'],
    // Live folds Agent below 738px once the reserved Extension track is counted.
    live: ['agent'],
    tight: false,
  },
  '560': {
    draft: ['agent', 'work-in', 'more', 'mode', 'permissions', 'model'],
    live: ['agent', 'more', 'mode', 'permissions'],
    tight: false,
  },
  '360': {
    draft: ['agent', 'work-in', 'more', 'mode', 'permissions', 'model'],
    live: ['agent', 'more', 'mode', 'permissions', 'model'],
    tight: true,
  },
  '320': {
    draft: ['agent', 'work-in', 'more', 'mode', 'permissions', 'model'],
    live: ['agent', 'more', 'mode', 'permissions', 'model'],
    tight: true,
  },
} as const

type ComposerWidth = keyof typeof expectedFolds

const foldsMatch = (page: Page, width: ComposerWidth) => page.evaluate(({ width, shapes, slots, expected }) => {
  const folds = expected[width]
  return shapes.every((shape) => (['draft', 'live'] as const).every((layout) => {
    const selector = '[data-composer-width="' + width + '"] [data-composer-shape="' + shape + '"] [data-composer-layout="' + layout + '"]'
    const toolbar = document.querySelector<HTMLElement>(selector)
    if (!toolbar) return false
    const expectedFolded = folds[layout]
    const checkedSlots = layout === 'draft' ? slots : slots.filter((slot) => slot !== 'work-in')
    return checkedSlots.every((slot) => {
      const track = toolbar.querySelector<HTMLElement>('[data-composer-track="' + slot + '"]')
      if (!track) return false
      const shouldFold = expectedFolded.includes(slot as never)
      const shouldTight = folds.tight && ['agent', 'work-in', 'more', 'mode', 'permissions', 'model'].includes(slot)
      return track.hasAttribute('data-folded') === shouldFold && track.hasAttribute('data-tight') === shouldTight
    })
  }))
}, { width, shapes, slots, expected: expectedFolds })

const toolsDoNotOverflow = (page: Page, width: string, layout: 'draft' | 'live') => page.evaluate(({ width, layout, shapes }) => {
  const tools = [...document.querySelectorAll<HTMLElement>(
    '[data-composer-width="' + width + '"] [data-composer-layout="' + layout + '"]',
  )]
  return tools.length === shapes.length && tools.every((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth)
}, { width, layout, shapes })

const tightGlyphsMeetTarget = (page: Page, width: '360' | '320', layout: 'draft' | 'live') => page.evaluate(({ width, layout, shapes, slots }) => {
  return shapes.every((shape) => {
    const toolbar = document.querySelector<HTMLElement>(
      `[data-composer-width="${width}"] [data-composer-shape="${shape}"] [data-composer-layout="${layout}"]`,
    )
    if (!toolbar) return false
    const requiredSlots = slots.filter((slot) => layout === 'draft' || slot !== 'work-in')
    return requiredSlots.every((slot) => {
      const track = toolbar.querySelector<HTMLElement>(`[data-composer-track="${slot}"]`)
      if (!track) return false
      const buttons = [...track.querySelectorAll<HTMLButtonElement>('button')]
      if (slot !== 'extension' && buttons.length === 0) return false
      const targetsFit = buttons.every((button) => {
        const bounds = button.getBoundingClientRect()
        return bounds.width >= 24
      })
      const glyphsFit = [...track.querySelectorAll<SVGSVGElement>('svg')].every((glyph) =>
        glyph.getBoundingClientRect().width >= 12,
      )
      return targetsFit && glyphsFit
    })
  })
}, { width, layout, shapes, slots })

const contextRingsUnclipped = (page: Page) => page.evaluate(() => {
  const tracks = [...document.querySelectorAll<HTMLElement>('[data-composer-track="context"]')]
  return tracks.length > 0 && tracks.every((track) => {
    const ring = track.querySelector<HTMLElement>('[data-slot="progress-ring"]')
    if (!ring) return false
    const bounds = track.getBoundingClientRect()
    const rect = ring.getBoundingClientRect()
    return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
  })
})

const extensionCaseMatches = (page: Page) => page.evaluate(() => {
  const toolbars = [...document.querySelectorAll<HTMLElement>('[data-extension-width-case] [data-composer-layout="draft"]')]
  if (toolbars.length !== 2) return { valid: false, overflow: true, positions: [] }
  const positions = toolbars.map((toolbar) => ['more', 'context', 'model', 'send'].map((slot) => {
    const track = toolbar.querySelector<HTMLElement>(`[data-composer-track="${slot}"]`)
    return track ? Math.round(track.getBoundingClientRect().left) : -1
  }))
  return {
    valid: positions[0]?.every((x, index) => x === positions[1]?.[index]) === true,
    overflow: toolbars.some((toolbar) => toolbar.scrollWidth > toolbar.clientWidth),
    positions,
  }
})

// Present or absent, never a value: `data-folded` is written as `folded || undefined`.
const switchCaseModelFolded = async (page: Page) =>
  (await page.locator('[data-layout-switch-case] [data-composer-track="model"]').getAttribute('data-folded')) !== null

const composerWidthFoldIsStable = (page: Page) => page.evaluate(() => {
  const toolbar = document.querySelector<HTMLElement>('[data-composer-width-extension-case] [data-slot="composer-tools"]')
  const more = toolbar?.querySelector<HTMLElement>('[data-composer-track="more"]')
  if (!toolbar || !more) return { moreFolded: false, overflow: true, width: -1 }
  return {
    moreFolded: more.hasAttribute('data-folded'),
    overflow: toolbar.scrollWidth > toolbar.clientWidth,
    width: Math.round(toolbar.getBoundingClientRect().width),
  }
})

test('composer slots keep their tracks aligned across agent shapes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 })
  await page.goto('/preview.html?composer-slots')
  await page.waitForSelector('[data-composer-width="composer"] [data-composer-layout="live"] [data-composer-track="model"]')

  const switchCase = page.locator('[data-layout-switch-case]')
  await expect.poll(() => switchCaseModelFolded(page)).toBe(true)
  await switchCase.locator('[data-layout-switch]').click()
  await expect.poll(() => switchCaseModelFolded(page)).toBe(false)
  await switchCase.locator('[data-layout-switch]').click()
  await expect.poll(() => switchCaseModelFolded(page)).toBe(true)

  const stableBefore = await composerWidthFoldIsStable(page)
  expect(stableBefore).toMatchObject({ moreFolded: true, overflow: false })
  await page.evaluate(() => { document.body.dataset.foldThresholdProbe = 'theme-change' })
  await expect.poll(async () => composerWidthFoldIsStable(page)).toMatchObject({ moreFolded: true, overflow: false })
  const afterBodyMutation = await composerWidthFoldIsStable(page)
  expect(afterBodyMutation.width).toBe(stableBefore.width)
  await page.evaluate(() => { delete document.body.dataset.foldThresholdProbe })

  await page.setViewportSize({ width: 1360, height: 1600 })
  const afterViewportResize = await composerWidthFoldIsStable(page)
  expect(afterViewportResize.width).toBe(stableBefore.width)
  expect(afterViewportResize).toMatchObject({ moreFolded: true, overflow: false })
  await page.setViewportSize({ width: 1440, height: 1600 })

  // Mutation: make the body-attribute path receive a width 18px wider, as if
  // it used the toolbar's border box rather than its content box. That crosses
  // More's 728px draft threshold while only 718px fits in this toolbar.
  const contentBoxToolbar = page.locator('[data-composer-width-extension-case] [data-slot="composer-tools"]')
  await contentBoxToolbar.evaluate((node) => {
    const toolbar = node as HTMLElement
    const original = toolbar.getBoundingClientRect.bind(toolbar)
    const style = getComputedStyle(toolbar)
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    Object.defineProperty(toolbar, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const rect = original()
        return new DOMRect(rect.x, rect.y, rect.width + padding, rect.height)
      },
    })
    document.body.dataset.foldThresholdProbe = 'border-box-mutation'
  })
  await expect.poll(async () => composerWidthFoldIsStable(page)).toMatchObject({ moreFolded: false, overflow: true })
  await contentBoxToolbar.evaluate((node) => {
    delete (node as HTMLElement & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect
    delete document.body.dataset.foldThresholdProbe
  })
  await expect.poll(async () => composerWidthFoldIsStable(page)).toMatchObject({ moreFolded: true, overflow: false })

  const extensionCase = page.locator('[data-extension-width-case] [data-composer-layout="draft"]').last()
  await expect.poll(async () => extensionCaseMatches(page)).toMatchObject({ valid: true, overflow: false })
  const extensionTrack = extensionCase.locator('[data-composer-track="extension"]')
  await extensionTrack.evaluate((node) => { (node as HTMLElement).style.width = 'var(--hd-composer-track-model)' })
  expect(await extensionCaseMatches(page), 'a widened populated Extension must break its aligned, overflow-free layout').toMatchObject({ valid: false, overflow: true })
  await extensionTrack.evaluate((node) => { (node as HTMLElement).style.removeProperty('width') })
  await expect.poll(async () => extensionCaseMatches(page)).toMatchObject({ valid: true, overflow: false })

  expect(await boxGeometry(page), 'preview boxes must match their width labels and composer token').toMatchObject({ valid: true })
  const composerToolbar = await page.locator('[data-composer-width="composer"] [data-composer-layout="draft"]').first().boundingBox()
  expect(composerToolbar?.width).toBeGreaterThanOrEqual(713)
  expect(composerToolbar?.width).toBeLessThanOrEqual(736)

  for (const width of ['composer', '560', '360', '320'] as const) {
    expect(await foldsMatch(page, width), 'folds at ' + width + 'px').toBe(true)
    for (const layout of ['draft', 'live'] as const) {
      expect(await aligned(page, width, layout), `${layout} slots at ${width}px`).toMatchObject({ aligned: true })
    }
  }

  for (const width of ['composer', '560', '360', '320'] as const) {
    for (const layout of ['draft', 'live'] as const) {
      expect(await toolsDoNotOverflow(page, width, layout), layout + ' toolbar overflows at ' + width + 'px').toBe(true)
    }
  }

  for (const width of ['360', '320'] as const) {
    for (const layout of ['draft', 'live'] as const) {
      expect(await tightGlyphsMeetTarget(page, width, layout), `${layout} glyphs and targets at ${width}px`).toBe(true)
    }
  }

  const widened = page.locator('[data-composer-width="560"]')
  await widened.evaluate((node) => {
    const box = node as HTMLElement
    box.style.width = '1374px'
    box.style.maxWidth = 'none'
  })
  await expect.poll(async () => foldsMatch(page, '560')).toBe(false)
  await widened.evaluate((node) => {
    const box = node as HTMLElement
    box.style.width = 'var(--hd-composer-slots-preview-narrow)'
    box.style.removeProperty('max-width')
  })
  await expect.poll(async () => foldsMatch(page, '560')).toBe(true)

  const gap = page.locator('[data-composer-width="320"] [data-composer-shape="Assistant A"] [data-composer-layout="draft"] [data-slot="composer-gap"]')
  await gap.evaluate((node) => { (node as HTMLElement).style.minWidth = '120px' })
  expect(await toolsDoNotOverflow(page, '320', 'draft'), 'a minimum width on the flexible gap must cause overflow').toBe(false)
  await gap.evaluate((node) => { (node as HTMLElement).style.removeProperty('min-width') })
  expect(await toolsDoNotOverflow(page, '320', 'draft')).toBe(true)

  const smallGlyph = page.locator('[data-composer-width="320"] [data-composer-shape="Assistant A"] [data-composer-layout="draft"] [data-composer-track="work-in"] svg').first()
  await smallGlyph.evaluate((node) => { (node as SVGSVGElement).style.width = '8px' })
  expect(await tightGlyphsMeetTarget(page, '320', 'draft'), 'an undersized glyph must fail the tight glyph check').toBe(false)
  await smallGlyph.evaluate((node) => { (node as SVGSVGElement).style.removeProperty('width') })
  expect(await tightGlyphsMeetTarget(page, '320', 'draft')).toBe(true)

  const refused = page.locator('[data-composer-width="composer"] [data-composer-shape="Assistant C"] [data-composer-layout="live"] [aria-disabled="true"]')
  await expect(refused.first()).toBeVisible()
  await expect(refused.first()).toHaveAttribute('title', /.+/)
  const emptySlots = page.locator('[data-empty-more-case] [data-composer-layout="draft"]')
  await expect(page.locator('[data-empty-more-case]')).toContainText('More — no options · Extension — no actions · Context — No usage yet')
  await expect(emptySlots.locator('[data-composer-track="more"] button')).toHaveCount(0)
  await expect(emptySlots.locator('[data-composer-track="extension"] button')).toHaveCount(0)
  await expect(emptySlots.locator('[data-composer-track="context"] button')).toHaveAttribute('aria-label', 'No usage yet')
  await expect(page.locator('[data-extension-width-case] h3')).toContainText('Extension — empty and populated')
  expect(await labelsUntruncated(page, 'composer', 'live'), 'live labels at the real composer width').toBe(true)
  expect(await contextRingsUnclipped(page), 'context ring must fit its track at every width').toBe(true)

  const contextMutation = page.locator('[data-composer-width="360"] [data-composer-shape="Assistant A"] [data-composer-layout="draft"] [data-composer-track="context"]')
  await contextMutation.evaluate((node) => { (node as HTMLElement).style.width = '8px' })
  expect(await contextRingsUnclipped(page), 'a too narrow context track must fail the ring check').toBe(false)
  await contextMutation.evaluate((node) => { (node as HTMLElement).style.removeProperty('width') })
  expect(await contextRingsUnclipped(page)).toBe(true)

  const alignmentMutation = page.locator('[data-composer-width="composer"] [data-composer-shape="Assistant B"] [data-composer-layout="draft"] [data-composer-track="mode"]')
  await alignmentMutation.evaluate((node) => { (node as HTMLElement).style.width = '240px' })
  expect((await aligned(page, 'composer', 'draft')).aligned, 'width mutation must break the alignment check').toBe(false)
  await alignmentMutation.evaluate((node) => { (node as HTMLElement).style.removeProperty('width') })
  expect((await aligned(page, 'composer', 'draft')).aligned).toBe(true)

  const truncationMutation = page.locator('[data-composer-width="composer"] [data-composer-shape="Assistant A"] [data-composer-layout="live"] [data-composer-track="mode"]')
  await truncationMutation.evaluate((node) => { (node as HTMLElement).style.width = '20px' })
  expect(await labelsUntruncated(page, 'composer', 'live'), 'narrow mode mutation must be caught by the truncation assertion').toBe(false)
  await truncationMutation.evaluate((node) => { (node as HTMLElement).style.removeProperty('width') })
  expect(await labelsUntruncated(page, 'composer', 'live')).toBe(true)
})

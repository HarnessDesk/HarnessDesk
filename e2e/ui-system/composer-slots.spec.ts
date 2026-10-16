import { expect, test, type Page } from '@playwright/test'
import expectedFolds from './composer-slot-record.json' with { type: 'json' }

const shapes = ['Assistant A', 'Assistant B', 'Assistant C', 'Assistant D']
const slots = ['add', 'work-in', 'agent', 'permissions', 'mode', 'extension', 'more', 'context', 'model', 'send']

test('permission modes keep their chosen label in draft and live composers', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/preview.html?composer-slots')
  for (const layout of ['draft', 'live']) {
    const composer = page.locator(`[data-permission-mode-case="${layout}"]`)
    await expect(composer).toBeVisible()
    await expect(composer.getByText('This runtime has no permission setting', { exact: true })).toHaveCount(0)
    await expect(composer.locator('[title="This runtime has no permission setting"]')).toHaveCount(0)
    await expect(composer.locator('[data-composer-track="permissions"]')).toHaveCount(1)
    const label = composer.locator('[data-composer-track="permissions"] [data-slot="text"]')
    await expect(label).toHaveText('Accept edits')
    await expect(label).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Collaboration mode — Act' })).toBeVisible()
  }
})

const aligned = (page: Page, width: string, layout: 'draft' | 'live') => page.evaluate(({ width, layout, shapes, slots }) => {
  const testedSlots = layout === 'draft' ? slots : slots.filter((slot) => slot !== 'work-in')
  const positions: Record<string, number[]> = Object.fromEntries(testedSlots.map((slot) => [slot, []]))
  let naturalWidths = true, separated = true
  for (const shape of shapes) {
    const section = document.querySelector<HTMLElement>(`[data-composer-width="${width}"] [data-composer-shape="${shape}"]`)
    const toolbar = section?.querySelector<HTMLElement>(`[data-composer-layout="${layout}"]`)
    if (!toolbar) return { aligned: false, positions }
    for (const slot of testedSlots) {
      const track = toolbar.querySelector<HTMLElement>(`[data-composer-track="${slot}"]`)
      if (!track) {
        if (slot === 'mode' && shape === 'Assistant C') continue
        return { aligned: false, positions }
      }
      positions[slot]?.push(Math.round(track.getBoundingClientRect().left))
      if (['permissions', 'mode'].includes(slot) && !track.hasAttribute('data-folded')) {
        const intrinsic = track.cloneNode(true) as HTMLElement
        intrinsic.style.width = 'max-content'
        intrinsic.style.position = 'absolute'
        intrinsic.style.visibility = 'hidden'
        toolbar.append(intrinsic)
        naturalWidths &&= Math.abs(track.getBoundingClientRect().width - intrinsic.getBoundingClientRect().width) <= 1
        intrinsic.remove()
      }
      const previous = track.previousElementSibling
      if (previous && previous.matches('[data-composer-track]'))
        separated &&= track.getBoundingClientRect().left >= previous.getBoundingClientRect().right + 3
    }
  }
  return {
    // R12.1 permits natural selected-value widths. Outer anchors still line
    // up across shapes. An absent mode gives the shrinkable folder more room;
    // the following controls may move, and each natural track still fits exactly.
    aligned: Object.entries(positions).every(([slot, xs]) => xs.length === shapes.length - (slot === 'mode' ? 1 : 0)
      && (!['add', 'work-in', 'send'].includes(slot) || new Set(xs).size === 1)) && naturalWidths && separated,
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

type ComposerWidth = keyof typeof expectedFolds
type FoldState = { folded: readonly string[]; tight: readonly string[] }
type FoldLayouts = Record<'draft' | 'live', FoldState>

const foldsMatch = (page: Page, width: ComposerWidth) => page.evaluate(({ width, shapes, slots, expected }) => {
  const folds: FoldLayouts & { overrides?: Record<string, FoldLayouts> } = expected[width]
  return shapes.every((shape) => (['draft', 'live'] as const).every((layout) => {
    const selector = '[data-composer-width="' + width + '"] [data-composer-shape="' + shape + '"] [data-composer-layout="' + layout + '"]'
    const toolbar = document.querySelector<HTMLElement>(selector)
    if (!toolbar) return false
    const shapeFolds = (folds.overrides?.[shape] ?? folds)[layout]
    const expectedFolded = shapeFolds.folded
    const checkedSlots = layout === 'draft' ? slots : slots.filter((slot) => slot !== 'work-in')
    return checkedSlots.every((slot) => {
      const track = toolbar.querySelector<HTMLElement>('[data-composer-track="' + slot + '"]')
      if (!track) return slot === 'mode' && shape === 'Assistant C'
      const shouldFold = expectedFolded.includes(slot as never)
      const shouldTight = shapeFolds.tight.includes(slot as never)
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
      if (!track) return slot === 'mode' && shape === 'Assistant C'
      const buttons = [...track.querySelectorAll<HTMLButtonElement>('button')]
      if (slot !== 'extension' && buttons.length === 0) return false
      const targetsFit = buttons.every((button) => {
        const bounds = button.getBoundingClientRect()
        return bounds.width >= 24
      })
      // A runtime with no mode can keep the ordinary folded state at 360px.
      // Its primary glyph still meets 12px; the visible disclosure is the
      // shared 11px Chevron. Tight controls omit that disclosure entirely.
      const glyphsFit = [...track.querySelectorAll<SVGSVGElement>('svg')].every((glyph, index) =>
        glyph.getBoundingClientRect().width >= (track.hasAttribute('data-tight') || index === 0 ? 12 : 11),
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

test('composer slots keep their order and fit across agent shapes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 })
  await page.goto('/preview.html?composer-slots')
  await page.waitForSelector('[data-composer-width="composer"] [data-composer-layout="live"] [data-composer-track="model"]')

  const switchCase = page.locator('[data-layout-switch-case]')
  await expect.poll(() => switchCaseModelFolded(page)).toBe(true)
  await switchCase.locator('[data-layout-switch]').click()
  await expect.poll(() => switchCaseModelFolded(page)).toBe(false)
  await switchCase.locator('[data-layout-switch]').click()
  await expect.poll(() => switchCaseModelFolded(page)).toBe(true)

  // Pin this mutation fixture between its trailing padding and total padding below the real More fold boundary.
  // The frame foundation changed the track measures; the production fold
  // algorithm and the 18px border-box mutation stay under test unchanged.
  await page.evaluate(() => document.fonts.ready)
  const contentCase = page.locator('[data-composer-width-extension-case]')
  // The full fixture choices fill the supported content-sized tracks.
  // Pin this fixture's folder so an incorrect fold cannot hide in a shortened name.
  await contentCase.locator('[data-composer-track="work-in"]').evaluate(node => { (node as HTMLElement).style.flexShrink = '0' })
  // Exercise the nominal wide floors as well as content-sized labels. Short
  // values can otherwise conceal an incorrect fold in spare track width.
  const wideTracks = { add:'add', 'work-in':'work-in', agent:'agent', permissions:'permissions-wide', mode:'mode-wide', extension:'extension', more:'more', context:'context-wide', model:'model', send:'send' }
  await page.addStyleTag({ content: Object.entries(wideTracks).map(([track, token]) => `[data-composer-width-extension-case] [data-composer-track="${track}"]:not([data-folded]):not([data-tight]) { min-width:var(--hd-composer-track-${token}); }`).join('\n') })
  let low = 400, high = 1400
  await contentCase.evaluate((node, value) => { (node as HTMLElement).style.width = `${value}px` }, high)
  await expect.poll(async () => (await composerWidthFoldIsStable(page)).moreFolded).toBe(false)
  while (high - low > 1) {
    const width = Math.floor((low + high) / 2)
    await contentCase.evaluate((node, value) => { (node as HTMLElement).style.width = `${value}px` }, width)
    await expect.poll(async () => (await composerWidthFoldIsStable(page)).width).toBe(width)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if ((await composerWidthFoldIsStable(page)).moreFolded) low = width
    else high = width
  }
  const probeOffset = await contentCase.locator('[data-slot="composer-tools"]').evaluate(node => {
    const style = getComputedStyle(node), left = parseFloat(style.paddingLeft), right = parseFloat(style.paddingRight)
    return Math.ceil((left + 2 * right) / 2)
  })
  await contentCase.evaluate((node, value) => { (node as HTMLElement).style.width = `${value}px` }, high - probeOffset)
  await expect.poll(async () => (await composerWidthFoldIsStable(page)).moreFolded).toBe(true)
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
  // More's measured draft threshold, with the overflow beyond its end padding.
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
  await test.info().attach('content-box mutation geometry', { body: JSON.stringify(await contentBoxToolbar.evaluate(node => ({
    client:node.clientWidth,scroll:node.scrollWidth,gap:getComputedStyle(node).columnGap,
    tracks:[...node.querySelectorAll<HTMLElement>('[data-composer-track]')].map(track=>({name:track.dataset.composerTrack,width:track.getBoundingClientRect().width,min:getComputedStyle(track).minWidth,shrink:getComputedStyle(track).flexShrink,folded:track.hasAttribute('data-folded')}))
  })),null,2),contentType:'application/json' })
  await expect.poll(async () => composerWidthFoldIsStable(page)).toMatchObject({ moreFolded: false, overflow: true })
  await contentBoxToolbar.evaluate((node) => {
    delete (node as HTMLElement & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect
    delete document.body.dataset.foldThresholdProbe
  })
  await expect.poll(async () => composerWidthFoldIsStable(page)).toMatchObject({ moreFolded: true, overflow: false })

  const extensionCase = page.locator('[data-extension-width-case] [data-composer-layout="draft"]').last()
  await expect.poll(async () => extensionCaseMatches(page)).toMatchObject({ valid: true, overflow: false })
  const extensionWindow = page.locator('[data-extension-width-case]')
  await extensionWindow.evaluate(node => { (node as HTMLElement).style.width = '320px' })
  await expect.poll(async () => extensionCaseMatches(page)).toMatchObject({ valid: true, overflow: false })
  const extensionTrack = extensionCase.locator('[data-composer-track="extension"]')
  await extensionTrack.evaluate((node) => { (node as HTMLElement).style.width = 'var(--hd-composer-track-model)' })
  expect(await extensionCaseMatches(page), 'a widened populated Extension must break its aligned, overflow-free layout').toMatchObject({ valid: false, overflow: true })
  await extensionTrack.evaluate((node) => { (node as HTMLElement).style.removeProperty('width') })
  await expect.poll(async () => extensionCaseMatches(page)).toMatchObject({ valid: true, overflow: false })
  await extensionWindow.evaluate(node => { (node as HTMLElement).style.removeProperty('width') })
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
  const emptyUsage = emptySlots.locator('[data-composer-track="context"] button')
  await expect(emptyUsage).toHaveAttribute('aria-label', 'Usage')
  await expect(emptyUsage).toHaveAttribute('title', 'Usage')
  await expect(emptyUsage.locator('[data-slot="progress-ring"]')).toHaveAttribute('aria-label', 'No usage yet')
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

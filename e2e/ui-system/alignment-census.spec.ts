import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { writeOnceEveryTestPasses } from './write-once'

type Check = 'lead-off-line' | 'trailing-glyph-off-column' | 'header-off-body'
type Census = Record<Check, { count: number; signatures: Record<string, number> }>

const TABLE = fileURLToPath(new URL('../../packages/ui/src/design/alignment-census.json', import.meta.url))
const UPDATE = process.env.UPDATE_ALIGNMENT === '1'
const CHECKS: Check[] = ['lead-off-line', 'trailing-glyph-off-column', 'header-off-body']
const staged = new Map<string, string[]>()

if (UPDATE) writeOnceEveryTestPasses(test, () => writeFileSync(TABLE, `${JSON.stringify(wholeTable(staged), null, 2)}\n`))

const wholeTable = (observed: Map<string, string[]>): Census => {
  const missing = CHECKS.filter(check => !observed.has(check))
  if (missing.length) throw new Error(`A re-record needs every check; not measured: ${missing.join(', ')}`)
  return Object.fromEntries(CHECKS.map(check => {
    const signatures = Object.fromEntries([...observed.get(check)!].sort().map(signature => [signature, 0]))
    for (const signature of observed.get(check)!) signatures[signature]++
    return [check, { count: Object.values(signatures).reduce((sum, count) => sum + count, 0), signatures }]
  })) as Census
}

const recorded = (): Census => JSON.parse(UPDATE ? JSON.stringify(wholeTable(staged)) : readFileSync(TABLE, 'utf8')) as Census

/** Wait for measured descendant geometry to match across samples, or fail with the unsettled page. */
const settle = async (page: import('@playwright/test').Page) => page.evaluate(async () => {
  await document.fonts.ready
  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const fingerprint = () => {
    const root = document.querySelector('#root')
    if (!root) return 'missing-root'
    return [root, ...root.querySelectorAll('*')].map(element => {
      const rect = element.getBoundingClientRect()
      const round = (value: number) => Math.round(value * 100) / 100
      return `${element.tagName}:${round(rect.x)},${round(rect.y)},${round(rect.width)},${round(rect.height)}`
    }).join('|')
  }
  const deadline = performance.now() + 4000
  let previous = fingerprint()
  let stableComparisons = 0
  while (performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    await nextFrame()
    const next = fingerprint()
    stableComparisons = next === previous ? stableComparisons + 1 : 0
    previous = next
    if (stableComparisons >= 4) return
  }
  throw new Error(`Alignment census layout did not settle within 4s at ${location.pathname}${location.search}`)
})

/** Measure just the rendered app in one preview frame or one explorer board. */
const measure = async (page: import('@playwright/test').Page, rootSelector: string, pageName: string, stableId: string, title: string) => page.locator(rootSelector).evaluate((root, context) => {
  const hidden = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.matches('[data-slot="preview-frame-chrome"], [aria-hidden="true"], [hidden], [inert], [data-slot="popover-content"][data-state="closed"], [role="menu"][data-state="closed"]')) return true
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return true
    }
    return false
  }
  const visibleChildren = (element: Element) => [...element.children].filter(child => !hidden(child))
  const hasIcon = (element: Element) => !!element.querySelector('svg, img')
  const hasText = (element: Element) => (element.textContent ?? '').trim().length > 0
  const visibleLineCount = (element: Element) => {
    const tops: number[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      tops.push(...[...range.getClientRects()]
        .filter(rect => rect.width > 0 && rect.height > 0)
        .map(rect => rect.top))
    }
    return tops.sort((a, b) => a - b)
      .filter((top, index, sorted) => sorted.findIndex(candidate => Math.abs(candidate - top) < 1) === index).length
  }
  const firstTextLine = (element: Element) => {
    // A range over nested block content can return its full container bounds,
    // not a line fragment; compare leads with the first visible text node's first fragment.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!node.textContent?.trim() || (node.parentElement && hidden(node.parentElement))) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0)
      if (rect) return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }
    return null
  }
  const firstLine = (element: Element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const rect = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0)
    return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null
  }
  const boxSurface = (element: Element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
    const bordered = ['Top', 'Right', 'Bottom', 'Left'].some(side => {
      const width = parseFloat(style[`border${side}Width` as 'borderTopWidth'])
      return width > 0 && style[`border${side}Style` as 'borderTopStyle'] !== 'none'
    })
    const shadowed = style.boxShadow !== 'none' && style.boxShadow.includes('inset')
    // Some surfaces are defined by their inset even when their visible edge
    // is painted by an overlay ancestor, so parts can mark that geometry.
    return element.hasAttribute('data-surface') || (rect.width >= 120 && (painted || bordered || shadowed))
  }
  const descriptors = (element: Element) => {
    const parts: string[] = []
    for (let node: Element | null = element; node && node !== root.parentElement && parts.length < 5; node = node.parentElement) {
      const slot = node.getAttribute('data-slot')
      const classes = [...node.classList]
        .filter(name => /(?:__|_module_)/.test(name))
        .map(name => name.replace(/^.*module_/, '').replace(/__[a-z0-9_-]{5,}$/i, '').replace(/_[a-z0-9]{6,}$/i, ''))
        .filter(Boolean)
      const descriptor = slot ? `[${slot}]` : classes.length ? `.${classes.slice(0, 2).join('.')}` : node.tagName.toLowerCase()
      if (parts.at(-1) !== descriptor) parts.push(descriptor)
    }
    return parts.reverse().join(' > ')
  }
  const signature = (kind: Check, element: Element) => {
    const testId = element.closest('[data-testid]')?.getAttribute('data-testid')
    const key = `${context.page} / ${context.id} / ${kind} / ${testId ? `[data-testid=${testId}]` : descriptors(element)}`
    diagnostics[key] = context.title
    return key
  }
  const found: Record<Check, Map<string, Set<Element>>> = {
    'lead-off-line': new Map(),
    'trailing-glyph-off-column': new Map(),
    'header-off-body': new Map(),
  }
  const diagnostics: Record<string, string> = {}
  const record = (kind: Check, element: Element) => {
    const key = signature(kind, element)
    const instances = found[kind].get(key) ?? new Set<Element>()
    instances.add(element)
    found[kind].set(key, instances)
  }
  const elements = [root, ...root.querySelectorAll('*')].filter(element =>
    !hidden(element) && !element.closest('[data-slot="preview-frame-chrome"]') &&
    !(element.parentElement === root && ['H1', 'P'].includes(element.tagName)))

  for (const row of elements) {
    const style = getComputedStyle(row)
    if (style.display !== 'flex' || style.flexDirection !== 'row') continue
    const children = visibleChildren(row)
    if (children.length < 2) continue
    const lead = children[0]!
    const text = children[1]!
    const leadRect = lead.getBoundingClientRect()
    const line = firstTextLine(text)
    const iconLike = (lead.tagName.toLowerCase() === 'svg' || lead.tagName.toLowerCase() === 'img' ||
      (leadRect.width <= 40 && leadRect.height <= 40 && hasIcon(lead) && !hasText(lead)))
    // A surface child is its own panel, not this row's text column.
    if (iconLike && hasText(text) && !boxSurface(text) && line && line.left >= leadRect.left && line.left - leadRect.right < row.getBoundingClientRect().width) {
      const delta = Math.abs((leadRect.top + leadRect.bottom) / 2 - (line.top + line.bottom) / 2)
      const rowStyle = getComputedStyle(row)
      const firstLineAligned = rowStyle.alignItems === 'flex-start' || rowStyle.alignItems === 'start'
      // #1009 allows a horizontal Attachment thumbnail and the Plans account mark to centre beside fixed title + meta lines.
      // ListRow subtitles/meta and ChoiceRow descriptions follow the first-line rule; a two-line shape alone is not an exemption.
      const centeredMetaPattern = row.matches('[data-slot="attachment"][data-orientation="horizontal"]') || !!row.closest('[data-slot="plans-table"]')
      const centeredTwoLineLead = centeredMetaPattern && visibleLineCount(text) <= 2
      if (delta >= 1.5 && (firstLineAligned || !centeredTwoLineLead)) record('lead-off-line', lead)
    }
  }

  for (const button of elements.filter(element => element.tagName.toLowerCase() === 'button')) {
    if (hasText(button) || !button.querySelector('svg') || [...button.children].some(child => child.tagName.toLowerCase() !== 'svg')) continue
    let row: Element | null = button.parentElement
    while (row && row !== root && !(getComputedStyle(row).display === 'flex' && getComputedStyle(row).flexDirection === 'row')) row = row.parentElement
    if (!row || row === root || row.closest('[data-slot$="bar"], [role="toolbar"]')) continue
    const controls = [...row.querySelectorAll('button, input, select, [role="button"], [data-slot$="ctl"]')].filter(control => !hidden(control))
    if (controls.at(-1) !== button) continue
    let branch: Element = button
    while (branch.parentElement && branch.parentElement !== row) branch = branch.parentElement
    if (!visibleChildren(row).slice(0, visibleChildren(row).indexOf(branch)).some(hasText)) continue
    let surface: Element | null = button.parentElement
    while (surface && surface !== root && !boxSurface(surface)) surface = surface.parentElement
    if (!surface || surface === root) continue
    const surfaceRect = surface.getBoundingClientRect()
    const surfaceStyle = getComputedStyle(surface)
    const rightInset = parseFloat(surfaceStyle.paddingRight) + parseFloat(surfaceStyle.borderRightWidth)
    const columnRight = surfaceRect.right - rightInset
    const glyph = button.querySelector('svg')!.getBoundingClientRect()
    // The content edge is the right edge shared by the surface's text column; the hit target may hang past it.
    if (columnRight - glyph.right >= 2 && surfaceRect.right - button.getBoundingClientRect().right <= 48) {
      record('trailing-glyph-off-column', button)
    }
  }

  for (const surface of elements.filter(boxSurface)) {
    const children = visibleChildren(surface)
    if (children.length < 2) continue
    const header = children[0]!
    // `row-title` names one entry, not the surface. A Rows card's first entry
    // must not be promoted to a header just because its slot ends in "title".
    const headingSelector = 'h1, h2, h3, [data-slot$="title"]:not([data-slot="row-title"]), [data-slot="section-name"]'
    const headerish = header.matches(`header, ${headingSelector}`) || !!header.querySelector(headingSelector)
    if (!headerish) continue
    const headerText = header.matches('h1,h2,h3')
      ? firstLine(header)
      : firstLine(header.querySelector(headingSelector) ?? header)
    let bodyText: ReturnType<typeof firstLine> = null
    for (const child of children.slice(1)) {
      const candidates = [child, ...child.querySelectorAll('*')].filter(hasText)
      bodyText = candidates.map(firstLine).find(rect => rect !== null) ?? null
      if (bodyText) break
    }
    if (headerText && bodyText && Math.abs(headerText.left - bodyText.left) >= 2) {
      record('header-off-body', header)
    }
  }

  const findings = Object.fromEntries((Object.keys(found) as Check[]).map(check => [
    check,
    [...found[check]].flatMap(([key, instances]) => Array.from(instances, () => key)).sort(),
  ])) as Record<Check, string[]>
  return { findings, diagnostics }
}, { page: pageName, id: stableId, title })

test('the rendered frames and boards hold the alignment census ceiling', async ({ page }, testInfo) => {
  // Every preview frame and catalogue board, each settled before it is
  // measured: about 35s on a laptop and slower on a CI runner, so the budget
  // is the coverage gate's, not the suite's one-minute default.
  test.setTimeout(180_000)
  const all: Record<Check, string[]> = { 'lead-off-line': [], 'trailing-glyph-off-column': [], 'header-off-body': [] }
  const diagnostics = new Map<string, string>()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html')
  await settle(page)
  const frames = await page.locator('#root > div > section').evaluateAll(nodes => nodes
    .filter(section => section.querySelector(':scope > h2') && section.querySelector(':scope > div'))
    .map(section => {
      const id = section.getAttribute('data-frame-id')
      return {
        selector: `[data-frame-id="${id}"] > div`,
        id,
        title: section.querySelector(':scope > h2')?.textContent?.trim() || `Frame ${id}`,
      }
    }))
  expect(frames.length, 'preview.html exposes its default frames without opening dials').toBeGreaterThan(10)
  for (const frame of frames) expect(frame.id, 'each preview Frame has a stable data-frame-id').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  for (const frame of frames) {
    const observed = await measure(page, frame.selector, 'preview.html', frame.id, frame.title)
    for (const [signature, title] of Object.entries(observed.diagnostics)) diagnostics.set(signature, title)
    for (const check of CHECKS) all[check].push(...observed.findings[check])
  }

  await page.goto('/design.html')
  await settle(page)
  const nav = page.locator('nav button')
  const boardCount = await nav.count()
  expect(boardCount, 'design.html exposes boards through its own navigation').toBeGreaterThan(10)
  for (let index = 0; index < boardCount; index++) {
    const item = nav.nth(index)
    const title = (await item.innerText()).replace(/\s+/g, ' ').trim()
    await item.click()
    await page.locator('main h1').first().waitFor({ state: 'visible' })
    await settle(page)
    const actualTitle = (await page.locator('main h1').first().innerText()).replace(/\s+/g, ' ').trim()
    expect(actualTitle, `the ${title} navigation item opened its own board`).toBe(
      title === 'Foundation' ? 'Tokens' : title === 'Manifest' ? 'Coverage' : title,
    )
    // Product surfaces are lazy; a stable Suspense placeholder is not the rendered board to measure.
    await page.getByText('Mounting the screen…').waitFor({ state: 'hidden' })
    const boardRoot = page.locator('main > div').last()
    const stableId = await boardRoot.evaluate(element => {
      element.setAttribute('data-alignment-measure-root', '')
      return element.getAttribute('data-alignment-board-id')
    })
    expect(stableId, 'each explorer board exposes its registry id').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    const observed = await measure(page, '[data-alignment-measure-root]', 'design.html', stableId!, actualTitle)
    for (const [signature, title] of Object.entries(observed.diagnostics)) diagnostics.set(signature, title)
    for (const check of CHECKS) all[check].push(...observed.findings[check])
  }

  if (UPDATE) {
    staged.clear()
    for (const check of CHECKS) staged.set(check, all[check])
    testInfo.annotations.push({ type: 'measured', description: CHECKS.map(check => `${check}: ${all[check].length} occurrences`).join(', ') })
    return
  }

  const table = recorded()
  const differences = CHECKS.flatMap(check => {
    const actual = Object.fromEntries([...new Set(all[check])].sort().map(signature => [signature, 0])) as Record<string, number>
    for (const signature of all[check]) actual[signature]++
    const expected = table[check]?.signatures ?? {}
    const newOnes = Object.entries(actual).filter(([signature, count]) => count > (expected[signature] ?? 0))
      .map(([signature, count]) => `${check}: multiplicity rose ${expected[signature] ?? 0} → ${count} — ${diagnostics.get(signature) ?? 'visible title unavailable'}\n  ${signature}`)
    const fixed = Object.entries(expected).filter(([signature, count]) => (actual[signature] ?? 0) < count)
      .map(([signature, count]) => `${check}: fixed — re-record to lower the ceiling (${count} → ${actual[signature] ?? 0}) — ${diagnostics.get(signature) ?? 'visible title unavailable'}\n  ${signature}`)
    const countError = table[check]?.count !== Object.values(expected).reduce((sum, count) => sum + count, 0)
      ? [`${check}: recorded total ${table[check]?.count} does not match signature multiplicity ${Object.values(expected).reduce((sum, count) => sum + count, 0)}`] : []
    return [...newOnes, ...fixed, ...countError]
  })
  // A check the table records and this spec no longer measures would hold nothing.
  for (const check of Object.keys(table)) if (!CHECKS.includes(check as Check)) differences.push(`${check}: recorded but no longer measured`)
  await testInfo.attach('alignment-census', { body: JSON.stringify(all, null, 2), contentType: 'application/json' })
  expect(differences.join('\n\n') || 'every recorded signature is still present and no new ones appeared').toBe('every recorded signature is still present and no new ones appeared')
})

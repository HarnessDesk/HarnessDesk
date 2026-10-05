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
  const firstBodyColumn = (element: Element, iconTab: boolean) => {
    const candidates = [element, ...element.querySelectorAll('*')].filter(candidate =>
      !candidate.closest('[data-slot="alert"]') && (
        candidate.matches('[data-slot="search"] input, [data-slot="list-row-title"], [data-slot="approval-code"]') ||
        (hasText(candidate) && !candidate.closest('button') && !candidate.querySelector('button, [data-slot="alert"], [data-slot="approval-code"], [data-slot="search"] input'))
      ))
    for (const candidate of candidates) {
      if (hidden(candidate)) continue
      if (candidate instanceof HTMLInputElement && (candidate.value || candidate.placeholder)) {
        // A bare bar label uses the search's lead; an icon tab shares its words.
        const lead = candidate.closest('[data-slot="search"]')?.querySelector('svg')
        if (!iconTab && lead && lead.getBoundingClientRect().width > 0 && getComputedStyle(lead).visibility !== 'hidden') return lead.getBoundingClientRect().left
        const style = getComputedStyle(candidate)
        return candidate.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
      }
      // Approval code owns a second inset; the card label shares its outer edge.
      if (candidate.matches('[data-slot="approval-code"]')) return candidate.getBoundingClientRect().left
      const line = firstTextLine(candidate)
      if (line) return line.left
    }
    return null
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
      // Tables, default/small lists and settings now centre on the whole row.
      // Other compositions still answer to their first text line.
      const familyRow = row.matches('[data-slot="list-row"]') || lead.matches('[data-slot="row-mark"], [data-slot="row-choice-mark"], [data-slot="table-cell-lead"]')
      const target = familyRow ? row.getBoundingClientRect() : line
      const delta = Math.abs((leadRect.top + leadRect.bottom) / 2 - (target.top + target.bottom) / 2)
      const rowStyle = getComputedStyle(row)
      const firstLineAligned = rowStyle.alignItems === 'flex-start' || rowStyle.alignItems === 'start'
      // #1009 allows a horizontal Attachment thumbnail and the Plans account mark to centre beside fixed title + meta lines.
      // Only the named row family uses row-centre geometry; a two-line shape alone is not an exemption.
      const centeredMetaPattern = row.matches('[data-slot="attachment"][data-orientation="horizontal"]') || !!row.closest('[data-slot="plans-table"]')
      const centeredTwoLineLead = centeredMetaPattern && visibleLineCount(text) <= 2
      if (delta >= 1.5 && (familyRow || firstLineAligned || !centeredTwoLineLead)) record('lead-off-line', lead)
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
    // A Row owns its inset even when its container draws the visible card edge.
    while (surface && surface !== root && !surface.matches('[data-slot="row"]') && !boxSurface(surface)) surface = surface.parentElement
    if (!surface || surface === root) continue
    const surfaceRect = surface.getBoundingClientRect()
    const surfaceStyle = getComputedStyle(surface)
    const rightInset = parseFloat(surfaceStyle.paddingRight) + parseFloat(surfaceStyle.borderRightWidth)
    const columnRight = surfaceRect.right - rightInset
    const buttonRect = button.getBoundingClientRect()
    const buttonStyle = getComputedStyle(button)
    const visibleColor = (color: string) => {
      if (color === 'transparent') return false
      const alpha = color.match(/,\s*([\d.]+)\s*\)$/)
      return !alpha || Number(alpha[1]) > 0
    }
    const visibleBorder = ['Top', 'Right', 'Bottom', 'Left'].some(side => {
      const width = parseFloat(buttonStyle[`border${side}Width` as 'borderTopWidth'])
      const style = buttonStyle[`border${side}Style` as 'borderTopStyle']
      const color = buttonStyle[`border${side}Color` as 'borderTopColor']
      return width > 0 && style !== 'none' && visibleColor(color)
    })
    const visibleFill = visibleColor(buttonStyle.backgroundColor)
    const visibleBox = visibleBorder || visibleFill
    const glyph = button.querySelector('svg')!.getBoundingClientRect()
    // docs/design.md, “What the engine checks”: trailing actions align to the surface text column.
    // A visible border/fill makes the button box its edge; a ghost button has no visible box, so align its glyph.
    const trailingEdge = visibleBox ? buttonRect.right : glyph.right
    if (Math.abs(columnRight - trailingEdge) >= 2 && surfaceRect.right - buttonRect.right <= 48) {
      record('trailing-glyph-off-column', button)
    }
  }

  for (const surface of elements.filter(boxSurface)) {
    const children = visibleChildren(surface)
    if (children.length < 2) continue
    const header = children[0]!
    // Row and list names/facts describe entries, not a surface. The first entry
    // must not be promoted to a header just because its slot ends in "title".
    const headingSelector = 'h1, h2, h3, [data-slot$="title"]:not([data-slot="row-title"], [data-slot="list-row-title"], [data-slot="list-row-subtitle"]), [data-slot="section-name"]'
    const headerish = header.matches(`header, ${headingSelector}`) || !!header.querySelector(headingSelector)
    if (!headerish) continue
    // Start at the heading's first text glyph so a decorative mark before it is not measured as the heading.
    const heading = header.matches(headingSelector) ? header : header.querySelector(headingSelector) ?? header
    const headerText = firstTextLine(heading)
    let bodyLeft: number | null = null
    for (const child of children.slice(1)) {
      const rows = child.matches('[data-slot="rows"]') ? child : child.querySelector('[data-slot="rows"]')
      if (rows) {
        const firstRow = visibleChildren(rows)
          .map(element => element.matches('[data-slot="row-folding"]')
            ? visibleChildren(element).find(opener => opener.matches('button')) ?? null
            : element)
          .find(element => element?.matches('[data-slot="row"], button'))
        if (firstRow) {
          const mark = firstRow.querySelector('[data-slot="row-mark"]')
          const markRect = mark && !hidden(mark) ? mark.getBoundingClientRect() : null
          const textLine = firstTextLine(firstRow)
          // docs/design.md, “Where a label lands”: a SectionHead over Rows shares the first row's lead,
          // which is its mark when present and otherwise its first text glyph; bar/column labels share text columns.
          bodyLeft = markRect?.left ?? textLine?.left ?? null
        }
        if (bodyLeft !== null) break
      }
      // Input text and navigation labels can define the first body column;
      // a later status chip must not displace them merely because they are controls.
      bodyLeft = firstBodyColumn(child, !!header.querySelector('[data-slot="dock-panel-tab"] > svg'))
      if (bodyLeft !== null) break
    }
    // Corner rows spend a layout inset for native window controls. Compare
    // from their ordinary padding edge, retaining any additional glyph offset.
    let cornerShift = 0
    if (header.matches('[data-corner], [data-slot="dock-panel-bar"]') &&
        parseFloat(getComputedStyle(header).getPropertyValue('--titlebar-inset')) > 0) {
      const element = header as HTMLElement
      const padding = parseFloat(getComputedStyle(element).paddingLeft)
      const previous = element.style.getPropertyValue('--titlebar-inset')
      const priority = element.style.getPropertyPriority('--titlebar-inset')
      try {
        element.style.setProperty('--titlebar-inset', '0px')
        cornerShift = Math.max(0, padding - parseFloat(getComputedStyle(element).paddingLeft))
      } finally {
        if (previous) element.style.setProperty('--titlebar-inset', previous, priority)
        else element.style.removeProperty('--titlebar-inset')
      }
    }
    if (headerText && bodyLeft !== null && Math.abs(headerText.left - cornerShift - bodyLeft) >= 2) {
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

  // The catalog's Settings row-fold specimen starts with a marked folding
  // opener and reveals an unmarked row. Exercise both states so the census's
  // first-row wrapper handling remains covered by a mixed-mark example.
  await page.goto('/design.html?view=row')
  await settle(page)
  const rowFoldCase = page.locator('[data-catalog-case="row-fold"][data-slot="rows"]')
  await expect(rowFoldCase.locator('[data-slot="row-folding"] > button [data-slot="row-mark"]'),
    'the first folding row is marked').toHaveCount(1)
  await rowFoldCase.locator('[aria-label$="accounts under Codex"]').click()
  const revealedPlainRow = rowFoldCase.locator('[data-slot="row-folding"] + button')
  await expect(revealedPlainRow,
    'the folding opener reveals the following row').toHaveCount(1)
  await expect(revealedPlainRow.locator('[data-slot="row-mark"]'),
    'the revealed following row is unmarked').toHaveCount(0)

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

test('a corner inset adjusts the header reference without hiding a real offset', async ({ page }) => {
  await page.setContent(`<main id="root">
    <section data-surface style="width:400px; --titlebar-inset:80px">
      <header data-corner style="padding-left:max(16px, var(--titlebar-inset))"><h2>Corner header</h2></header>
      <div style="padding-left:16px">Body column</div>
    </section>
  </main>`)
  const read = () => measure(page, '#root', 'fixture', 'corner', 'Corner fixture')
  expect((await read()).findings['header-off-body']).toEqual([])
  await page.locator('h2').evaluate(element => { (element as HTMLElement).style.marginLeft = '8px' })
  expect((await read()).findings['header-off-body']).toHaveLength(1)
  await page.locator('h2').evaluate(element => { (element as HTMLElement).style.marginLeft = '0px' })
  await page.locator('header').evaluate(element => element.removeAttribute('data-corner'))
  expect((await read()).findings['header-off-body']).toHaveLength(1)
})

test('placement frames are measured without exemptions', async ({ page }) => {
  await page.goto('/preview.html?notice-placement')
  await settle(page)
  const frames = page.locator('[data-frame-id^="coverage-notice-"]')
  expect(await frames.count()).toBe(11)
  for (const frame of await frames.all()) {
    const id = (await frame.getAttribute('data-frame-id'))!
    const notices = frame.locator('[data-slot="composer-notice"], [data-slot="notice-strip"]')
    await expect(notices).toHaveCount(1)
    const result = await measure(page, `[data-frame-id="${id}"] > div`, 'preview.html', id, id)
    for (const check of CHECKS) expect.soft(result.findings[check], `${id}: ${check}`).toEqual([])
  }
})

for (const [name, body] of [
  ['input', '<span data-slot="search"><input placeholder="Filter sessions" style="margin-left:16px; border:0; padding-left:24px"></span><span style="margin-left:200px">this week</span>'],
  ['navigation', '<button style="margin-left:40px; padding:0; border:0"><span data-slot="list-row-title">Overview</span></button><p style="margin-left:16px">Agents</p>'],
  ['nested box', '<pre data-slot="approval-code" style="margin:0 0 0 40px; padding:12px; border:1px solid; width:200px"><code>pnpm test</code></pre>'],
] as const) {
  test(`a header compares with its ${name} body column`, async ({ page }) => {
    await page.setContent(`<main id="root"><section data-surface style="width:400px">
      <header style="padding-left:40px"><h2>Surface label</h2></header><div>${body}</div>
    </section></main>`)
    const read = () => measure(page, '#root', 'fixture', name, name)
    expect((await read()).findings['header-off-body']).toEqual([])
    await page.locator('h2').evaluate(element => { (element as HTMLElement).style.marginLeft = '8px' })
    expect((await read()).findings['header-off-body']).toHaveLength(1)
  })
}

test('a bare bar label shares a search lead while an icon tab shares its text', async ({ page }) => {
  await page.setContent(`<main id="root"><section data-surface style="width:400px">
    <header style="padding-left:40px"><h2>Activity</h2></header>
    <div><span data-slot="search" style="display:block; position:relative; margin-left:40px">
      <svg aria-hidden="true" style="position:absolute; left:0; width:14px; height:14px"></svg>
      <input placeholder="Filter sessions" style="border:0; padding-left:20px">
    </span></div>
  </section></main>`)
  const read = () => measure(page, '#root', 'fixture', 'search', 'Search columns')
  expect((await read()).findings['header-off-body']).toEqual([])
  await page.locator('header').evaluate(element => {
    element.setAttribute('data-slot', 'dock-panel-bar')
    element.querySelector('h2')!.setAttribute('data-slot', 'dock-panel-tab')
    element.querySelector('h2')!.insertAdjacentHTML('afterbegin', '<svg style="position:absolute; width:14px; height:14px"></svg>')
    ;(element as HTMLElement).style.paddingLeft = '60px'
  })
  expect((await read()).findings['header-off-body']).toEqual([])
  await page.locator('h2').evaluate(element => { (element as HTMLElement).style.marginLeft = '8px' })
  expect((await read()).findings['header-off-body']).toHaveLength(1)
})

test('row-family leads centre on the row, and a first-line regression is caught', async ({ page }) => {
  for (const slot of ['list-row-lead', 'row-mark', 'row-choice-mark', 'table-cell-lead']) {
    await page.setContent(`<main id="root"><div ${slot === 'list-row-lead' ? 'data-slot="list-row"' : ''} style="display:flex;align-items:center;gap:12px;height:100px">
      <span data-slot="${slot}" style="display:flex;width:32px;height:32px"><svg width="20" height="20"></svg></span>
      <div style="line-height:20px">A title<br>A second line<br>A wrapping sentence</div>
    </div></main>`)
    expect((await measure(page, '#root', 'fixture', slot, slot)).findings['lead-off-line']).toEqual([])
    await page.locator(`[data-slot="${slot}"]`).evaluate(el => { (el as HTMLElement).style.transform = 'translateY(-12px)' })
    expect((await measure(page, '#root', 'fixture', slot, slot)).findings['lead-off-line']).toHaveLength(1)
  }
})

// An entry's own name is not a heading over its trailing reading.
test('a selected list entry does not promote its name to a surface header', async ({ page }) => {
  await page.setContent(`<main id="root"><div data-slot="list-row" style="display:flex;gap:24px;width:400px;background:#eee">
    <div data-slot="list-row-content"><div data-slot="list-row-title">Review project checks</div><div data-slot="list-row-subtitle">3 checks</div></div>
    <div style="margin-left:auto">Selected</div>
  </div></main>`)
  expect((await measure(page, '#root', 'fixture', 'list-entry', 'List entry')).findings['header-off-body']).toEqual([])
  await page.locator('[data-slot="list-row-title"]').evaluate(el => { el.setAttribute('data-slot', 'panel-title') })
  expect((await measure(page, '#root', 'fixture', 'panel-title', 'Panel title')).findings['header-off-body']).toHaveLength(1)
})

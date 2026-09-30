import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { writeOnceEveryTestPasses } from './write-once'

type Check = 'lead-off-line' | 'trailing-glyph-off-column' | 'header-off-body'
type Census = Record<Check, { count: number; signatures: string[] }>

const TABLE = fileURLToPath(new URL('../../packages/ui/src/design/alignment-census.json', import.meta.url))
const UPDATE = process.env.UPDATE_ALIGNMENT === '1'
const CHECKS: Check[] = ['lead-off-line', 'trailing-glyph-off-column', 'header-off-body']
const staged = new Map<string, string[]>()

if (UPDATE) writeOnceEveryTestPasses(test, () => writeFileSync(TABLE, `${JSON.stringify(wholeTable(staged), null, 2)}\n`))

const wholeTable = (observed: Map<string, string[]>): Census => {
  const missing = CHECKS.filter(check => !observed.has(check))
  if (missing.length) throw new Error(`A re-record needs every check; not measured: ${missing.join(', ')}`)
  return Object.fromEntries(CHECKS.map(check => {
    const signatures = [...new Set(observed.get(check)!)].sort()
    return [check, { count: signatures.length, signatures }]
  })) as Census
}

const recorded = (): Census => JSON.parse(UPDATE ? JSON.stringify(wholeTable(staged)) : readFileSync(TABLE, 'utf8')) as Census

/** Wait for the page's fonts and the layout changes caused by mounting a board to settle. */
const settle = async (page: import('@playwright/test').Page) => page.evaluate(async () => {
  await document.fonts.ready
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const fingerprint = () => {
    const root = document.querySelector('#root')
    return `${document.styleSheets.length}|${root?.getBoundingClientRect().height}|${root?.getBoundingClientRect().width}|${root?.scrollHeight}`
  }
  let previous = fingerprint()
  let stableSince = performance.now()
  const start = stableSince
  while (performance.now() - start < 4000) {
    await frame()
    const next = fingerprint()
    if (next !== previous) {
      previous = next
      stableSince = performance.now()
    }
    if (performance.now() - stableSince >= 80) return
  }
})

/** Measure just the rendered app in one preview frame or one explorer board. */
const measure = async (page: import('@playwright/test').Page, rootSelector: string, pageName: string, frameName: string) => page.locator(rootSelector).evaluate((root, context) => {
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
    return rect.width >= 120 && (painted || bordered || shadowed)
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
  const signature = (kind: Check, element: Element) => `${context.page} / ${context.frame} / ${kind} / ${descriptors(element)}`
  const found: Record<Check, string[]> = { 'lead-off-line': [], 'trailing-glyph-off-column': [], 'header-off-body': [] }
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
    const line = firstLine(text)
    const iconLike = (lead.tagName.toLowerCase() === 'svg' || lead.tagName.toLowerCase() === 'img' ||
      (leadRect.width <= 40 && leadRect.height <= 40 && hasIcon(lead) && !hasText(lead)))
    if (iconLike && hasText(text) && line && line.left >= leadRect.left && line.left - leadRect.right < row.getBoundingClientRect().width) {
      const delta = Math.abs((leadRect.top + leadRect.bottom) / 2 - (line.top + line.bottom) / 2)
      if (delta >= 1.5) found['lead-off-line'].push(signature('lead-off-line', lead))
    }
  }

  for (const button of elements.filter(element => element.tagName.toLowerCase() === 'button')) {
    if (hasText(button) || !button.querySelector('svg') || [...button.children].some(child => child.tagName.toLowerCase() !== 'svg')) continue
    let row: Element | null = button.parentElement
    while (row && row !== root && !(getComputedStyle(row).display === 'flex' && getComputedStyle(row).flexDirection === 'row')) row = row.parentElement
    if (!row || row === root) continue
    const controls = [...row.querySelectorAll('button, input, select, [role="button"], [data-slot$="ctl"]')].filter(control => !hidden(control))
    if (controls.at(-1) !== button) continue
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
      found['trailing-glyph-off-column'].push(signature('trailing-glyph-off-column', button))
    }
  }

  for (const surface of elements.filter(boxSurface)) {
    const children = visibleChildren(surface)
    if (children.length < 2) continue
    const header = children[0]!
    const headerish = header.matches('header, h1, h2, h3, [data-slot$="title"], [data-slot="section-name"]') ||
      !!header.querySelector('h1, h2, h3, [data-slot$="title"], [data-slot="section-name"]')
    if (!headerish) continue
    const headerText = header.matches('h1,h2,h3') ? firstLine(header) : firstLine(header.querySelector('h1,h2,h3,[data-slot$="title"],[data-slot="section-name"]') ?? header)
    let bodyText: ReturnType<typeof firstLine> = null
    for (const child of children.slice(1)) {
      const candidates = [child, ...child.querySelectorAll('*')].filter(hasText)
      bodyText = candidates.map(firstLine).find(rect => rect !== null) ?? null
      if (bodyText) break
    }
    if (headerText && bodyText && Math.abs(headerText.left - bodyText.left) >= 2) {
      found['header-off-body'].push(signature('header-off-body', header))
    }
  }

  for (const check of Object.keys(found) as Check[]) found[check] = [...new Set(found[check])].sort()
  return found
}, { page: pageName, frame: frameName })

test('the rendered frames and boards hold the alignment census ceiling', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const all: Record<Check, string[]> = { 'lead-off-line': [], 'trailing-glyph-off-column': [], 'header-off-body': [] }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html')
  await settle(page)
  const frames = await page.locator('#root > div > section').evaluateAll(nodes => nodes
    .filter(section => section.querySelector(':scope > h2') && section.querySelector(':scope > div'))
    .map((section, index) => {
      section.setAttribute('data-alignment-frame', String(index))
      return {
        selector: `[data-alignment-frame="${index}"] > div`,
        title: section.querySelector(':scope > h2')?.textContent?.trim() || `Frame ${index + 1}`,
      }
    }))
  expect(frames.length, 'preview.html exposes its default frames without opening dials').toBeGreaterThan(10)
  for (const frame of frames) {
    const observed = await measure(page, frame.selector, 'preview.html', frame.title)
    for (const check of CHECKS) all[check].push(...observed[check])
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
    const observed = await measure(page, await page.locator('main > div').last().evaluate(element => {
      element.setAttribute('data-alignment-measure-root', '')
      return '[data-alignment-measure-root]'
    }), 'design.html', `${title} — ${actualTitle}`)
    for (const check of CHECKS) all[check].push(...observed[check])
  }

  if (UPDATE) {
    for (const check of CHECKS) all[check] = [...new Set(all[check])].sort()
    staged.clear()
    for (const check of CHECKS) staged.set(check, all[check])
    testInfo.annotations.push({ type: 'measured', description: CHECKS.map(check => `${check}: ${all[check].length}`).join(', ') })
    return
  }

  const table = recorded()
  const differences = CHECKS.flatMap(check => {
    const actual = [...new Set(all[check])].sort()
    const expected = table[check]?.signatures ?? []
    const newOnes = actual.filter(signature => !expected.includes(signature)).map(signature => `${check}: new misalignment\n  ${signature}`)
    const fixed = expected.filter(signature => !actual.includes(signature)).map(signature => `${check}: fixed — re-record to lower the ceiling\n  ${signature}`)
    const countError = table[check]?.count !== expected.length ? [`${check}: recorded count ${table[check]?.count} does not match ${expected.length} signatures`] : []
    return [...newOnes, ...fixed, ...countError]
  })
  await testInfo.attach('alignment-census', { body: JSON.stringify(all, null, 2), contentType: 'application/json' })
  expect(differences.join('\n\n') || 'every recorded signature is still present and no new ones appeared').toBe('every recorded signature is still present and no new ones appeared')
})

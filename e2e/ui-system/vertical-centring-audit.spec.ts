import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = resolve(ROOT, process.env.VCENTRE_AUDIT_OUT ?? 'output/vertical-centring')

test.skip(process.env.VCENTRE_AUDIT !== '1', 'Set VCENTRE_AUDIT=1 to run the investigation-only audit.')

type Sample = {
  key: string
  page: string
  frame: string
  title: string
  component: string
  text: string
  font: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  container: { x: number; y: number; width: number; height: number }
  line: { top: number; bottom: number; height: number }
  baseline: number
  metrics: { fontAscent: number; fontDescent: number; capHeight: number; xHeight: number; inkAscent: number; inkDescent: number }
  imbalance: { cap: number; xHeight: number; ink: number }
  gaps: Record<'cap' | 'xHeight' | 'ink', { above: number; below: number }>
  styles: { display: string; alignItems: string; paddingTop: string; paddingBottom: string; borderTop: string; borderBottom: string; height: string; verticalAlign: string }
  convention: 'cap'
}

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
  let stable = 0
  while (performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    await nextFrame()
    const next = fingerprint()
    stable = next === previous ? stable + 1 : 0
    previous = next
    if (stable >= 4) return
  }
  throw new Error(`Vertical centring audit layout did not settle at ${location.pathname}${location.search}`)
})

const measureRoot = async (page: import('@playwright/test').Page, rootSelector: string, pageName: string, frameId: string, title: string) => page.locator(rootSelector).evaluate((root, context) => {
  const hidden = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      if (node.matches('[aria-hidden="true"], [hidden], [inert]') || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return true
    }
    return false
  }
  const round = (value: number) => Math.round(value * 100) / 100
  const clipped = (element: Element, line: DOMRect) => {
    for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (!/(auto|scroll|hidden|clip)/.test(`${style.overflow}${style.overflowY}`)) continue
      const rect = node.getBoundingClientRect()
      if (line.bottom <= rect.top || line.top >= rect.bottom || line.right <= rect.left || line.left >= rect.right) return true
    }
    return false
  }
  const componentFor = (textElement: Element) => {
    // A filled ancestor is not automatically the text's container: a card can
    // be hundreds of pixels tall. Boxed controls are explicit; otherwise the
    // nearest horizontal row/bar owns the text's vertical centre.
    for (let node: Element | null = textElement; node && node !== root; node = node.parentElement) {
      if (node.matches('button,input,[data-slot="chip"],[data-slot="badge"],[role="tab"],[data-slot="tab"],[data-slot="popover-trigger"],[data-slot="notice-strip"]')) return node
    }
    for (let node: Element | null = textElement; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node)
      if ((style.display === 'flex' && style.flexDirection === 'row') || node.matches('[data-slot="row"],[data-slot="strip"],[data-slot="toolbar"],[data-slot="branch-bar"]')) return node
    }
    return textElement
  }
  const descriptor = (element: Element) => {
    const chain: string[] = []
    for (let node: Element | null = element; node && node !== root.parentElement && chain.length < 4; node = node.parentElement) {
      const slot = node.getAttribute('data-slot')
      const classes = [...node.classList].filter(name => /(?:__|_module_)/.test(name)).map(name => name.replace(/^.*module_/, '').replace(/__[a-z0-9_-]{5,}$/i, '').replace(/_[a-z0-9]{6,}$/i, '')).filter(Boolean)
      const part = slot ? `[${slot}]` : classes.length ? `.${classes.slice(0, 2).join('.')}` : node.tagName.toLowerCase()
      if (chain.at(-1) !== part) chain.push(part)
    }
    return chain.reverse().join(' > ')
  }
  const texts: Array<{ element: Element; node: Text; line: DOMRect }> = []
  const lineCount = (element: Element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const tops = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.top).sort((a, b) => a - b)
    return tops.filter((top, index) => index === 0 || Math.abs(top - tops[index - 1]!) >= 1).length
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.textContent?.trim() || !node.parentElement || hidden(node.parentElement) || node.parentElement.closest('textarea,[contenteditable="true"],pre,code,[data-slot="code-block"],[data-slot="code-editor"]')) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
    if (!rects.length) continue
    const tops = rects.map(rect => rect.top).sort((a, b) => a - b)
    if (tops.some((top, index) => index > 0 && Math.abs(top - tops[0]!) >= 1)) continue
    if (clipped(node.parentElement, rects[0]!)) continue
    // A token inside a paragraph/pre that wraps is still inside a multiline
    // block. The leaf token's own range alone would incorrectly admit it.
    let block: Element | null = node.parentElement
    while (block && block !== root && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement
    if (block && block !== root && lineCount(block) > 1) continue
    texts.push({ element: node.parentElement, node, line: rects[0]! })
  }
  const output: Sample[] = []
  const sequence = new Map<string, number>()
  for (const { element: textElement, node: textNode, line } of texts) {
    const text = (textNode.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (!text || textElement.closest('textarea,[contenteditable="true"]')) continue
    const owner = componentFor(textElement)
    if (hidden(owner)) continue
    if (lineCount(owner) > 1) continue
    // Beyond this height the parent is a multiline card/section rather than
    // the one-line row/control edge asked for by this audit.
    if (owner.getBoundingClientRect().height > 64) continue
    const style = getComputedStyle(textElement)
    const ownerStyle = getComputedStyle(owner)
    const ownerRect = owner.getBoundingClientRect()
    const borderTop = parseFloat(ownerStyle.borderTopWidth) || 0
    const borderBottom = parseFloat(ownerStyle.borderBottomWidth) || 0
    const boxed = owner.matches('button,input,[data-slot="chip"],[data-slot="badge"],[role="tab"],[data-slot="tab"],[data-slot="popover-trigger"],[data-slot="notice-strip"]') || ['Top', 'Bottom', 'Left', 'Right'].some(side => parseFloat(ownerStyle[`border${side}Width` as 'borderTopWidth']) > 0 && ownerStyle[`border${side}Style` as 'borderTopStyle'] !== 'none') || (ownerStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && ownerStyle.backgroundColor !== 'transparent')
    const top = ownerRect.top + (boxed ? borderTop : 0)
    const bottom = ownerRect.bottom - (boxed ? borderBottom : 0)
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = font
    const metrics = ctx.measureText(text)
    const cap = ctx.measureText('H')
    const x = ctx.measureText('x')
    const ascent = metrics.fontBoundingBoxAscent
    const descent = metrics.fontBoundingBoxDescent
    const baseline = line.top + (line.height - ascent - descent) / 2 + ascent
    const variants = {
      cap: { upper: cap.actualBoundingBoxAscent, lower: 0 },
      xHeight: { upper: x.actualBoundingBoxAscent, lower: 0 },
      ink: { upper: metrics.actualBoundingBoxAscent, lower: metrics.actualBoundingBoxDescent },
    }
    const gaps = Object.fromEntries(Object.entries(variants).map(([name, variant]) => {
      const inkTop = baseline - variant.upper
      const inkBottom = baseline + variant.lower
      const above = inkTop - top
      const below = bottom - inkBottom
      return [name, { above: round(above), below: round(below) }]
    })) as Sample['gaps']
    const imbalance = Object.fromEntries(Object.entries(gaps).map(([name, gap]) => [name, round(Math.abs(gap.above - gap.below))])) as Sample['imbalance']
    const component = descriptor(owner)
    const base = `${context.page} / ${context.frame} / ${component}`
    const index = sequence.get(base) ?? 0
    sequence.set(base, index + 1)
    output.push({
      key: `${base} / ${index}`,
      page: context.page,
      frame: context.frame,
      title: context.title,
      component,
      text,
      font: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      container: { x: round(ownerRect.x), y: round(top), width: round(ownerRect.width), height: round(bottom - top) },
      line: { top: round(line.top), bottom: round(line.bottom), height: round(line.height) },
      baseline: round(baseline),
      metrics: { fontAscent: round(ascent), fontDescent: round(descent), capHeight: round(cap.actualBoundingBoxAscent), xHeight: round(x.actualBoundingBoxAscent), inkAscent: round(metrics.actualBoundingBoxAscent), inkDescent: round(metrics.actualBoundingBoxDescent) },
      imbalance,
      gaps,
      styles: { display: ownerStyle.display, alignItems: ownerStyle.alignItems, paddingTop: ownerStyle.paddingTop, paddingBottom: ownerStyle.paddingBottom, borderTop: ownerStyle.borderTopWidth, borderBottom: ownerStyle.borderBottomWidth, height: ownerStyle.height, verticalAlign: style.verticalAlign },
      convention: 'cap',
    })
  }
  return output
}, { page: pageName, frame: frameId, title })

const median = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered.length % 2 ? ordered[(ordered.length - 1) / 2]! : round((ordered[ordered.length / 2 - 1]! + ordered[ordered.length / 2]!) / 2)
}
const round = (value: number) => Math.round(value * 100) / 100

test('measure glyph centring across preview frames and design explorer boards', async ({ browser }) => {
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  for (let index = 1; index <= 6; index++) {
    try { unlinkSync(`${OUT}/worst-${String(index).padStart(2, '0')}.png`) } catch { /* no previous capture */ }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const origin = test.info().project.use.baseURL as string
  const all: Sample[] = []

  await page.goto(`${origin}/preview.html`)
  await settle(page)
  const frames = await page.locator('#root > div > section').evaluateAll(nodes => nodes
    .filter(section => section.querySelector(':scope > h2') && section.querySelector(':scope > div'))
    .map(section => ({ id: section.getAttribute('data-frame-id')!, title: section.querySelector(':scope > h2')?.textContent?.trim() || 'Frame', selector: `[data-frame-id="${section.getAttribute('data-frame-id')}"] > div` })))
  expect(frames.length).toBeGreaterThan(10)
  for (const frame of frames) all.push(...await measureRoot(page, frame.selector, 'preview.html', frame.id, frame.title))

  await page.goto(`${origin}/design.html`)
  await settle(page)
  const nav = page.locator('nav button')
  const boardCount = await nav.count()
  expect(boardCount).toBeGreaterThan(10)
  for (let i = 0; i < boardCount; i++) {
    const item = nav.nth(i)
    const title = (await item.innerText()).replace(/\s+/g, ' ').trim()
    await item.click()
    await page.locator('main h1').first().waitFor({ state: 'visible' })
    await settle(page)
    const actualTitle = (await page.locator('main h1').first().innerText()).replace(/\s+/g, ' ').trim()
    await expect(page.getByText('Mounting the screen…')).toBeHidden()
    const root = page.locator('main > div').last()
    const id = await root.getAttribute('data-alignment-board-id')
    expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    all.push(...await measureRoot(page, 'main > div[data-alignment-board-id]', 'design.html', id!, actualTitle))
  }

  const grouped = new Map<string, Sample[]>()
  for (const sample of all) {
    const list = grouped.get(sample.component) ?? []
    list.push(sample)
    grouped.set(sample.component, list)
  }
  const byComponent = [...grouped].map(([component, instances]) => {
    const cap = instances.map(item => item.imbalance.cap)
    const x = instances.map(item => item.imbalance.xHeight)
    const ink = instances.map(item => item.imbalance.ink)
    const worst = [...instances].sort((a, b) => b.imbalance.cap - a.imbalance.cap).slice(0, 10)
    return { component, count: instances.length, imbalance: { cap: { min: Math.min(...cap), median: median(cap), max: Math.max(...cap) }, xHeight: { min: Math.min(...x), median: median(x), max: Math.max(...x) }, ink: { min: Math.min(...ink), median: median(ink), max: Math.max(...ink) } }, worst: worst.map(item => ({ key: item.key, text: item.text, capPx: item.imbalance.cap, xHeightPx: item.imbalance.xHeight, inkPx: item.imbalance.ink })) }
  }).sort((a, b) => b.imbalance.cap.max - a.imbalance.cap.max)
  const stats = (values: number[]) => ({ min: Math.min(...values), median: median(values), max: Math.max(...values) })
  const capOffsetByFace = new Map<string, number[]>()
  for (const sample of all) {
    const key = `${sample.font} / ${sample.fontSize}`
    const offsets = capOffsetByFace.get(key) ?? []
    offsets.push((sample.gaps.cap.below - sample.gaps.cap.above) / 2)
    capOffsetByFace.set(key, offsets)
  }
  const faceOffsets = Object.fromEntries([...capOffsetByFace].map(([face, offsets]) => [face, median(offsets)]))
  const tokenPrediction = all.map(sample => {
    const offset = faceOffsets[`${sample.font} / ${sample.fontSize}`] ?? 0
    return Math.abs((sample.gaps.cap.above + offset) - (sample.gaps.cap.below - offset))
  })
  const cssSupport = await page.evaluate(() => ({
    trim: CSS.supports('text-box-trim', 'trim-both'),
    edge: CSS.supports('text-box-edge', 'cap alphabetic'),
  }))
  const report = {
    meta: { generatedAt: new Date().toISOString(), origin, viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, conventionForHeadline: 'cap', conventions: { cap: 'baseline - capHeight to baseline', xHeight: 'baseline - xHeight to baseline', ink: 'actualBoundingBoxAscent/Descent' }, previewFrames: frames.length, explorerBoards: boardCount, instanceCount: all.length, browserVersion: browser.version(), cssTextBoxSupport: cssSupport },
    candidateFixes: {
      textBoxTrim: { supported: cssSupport.trim && cssSupport.edge, predictedCapImbalance: stats(cssSupport.trim && cssSupport.edge ? all.map(() => 0) : all.map(sample => sample.imbalance.cap)), risks: ['Support is required in the target Chromium; unsupported engines ignore the declarations.', 'Mixed icon and text flex rows may change their intrinsic height differently from text-only rows.', 'Fallback fonts and CJK runs use their own cap metrics; a Latin cap edge does not define those glyphs.'] },
      perFaceOffset: { offsetsPx: faceOffsets, predictedCapImbalance: stats(tokenPrediction), risks: ['A font-family stack can resolve to different fallback faces by glyph and platform.', 'Moving text independently can break icon/text alignment and touch the wrong line in a multi-line control.'] },
      lineHeightToFontBox: { target: 'fontBoundingBoxAscent + fontBoundingBoxDescent', predictedCapImbalance: stats(all.map(sample => sample.imbalance.cap)), risks: ['Changing line-height changes row height and wrapping; fixed-height controls can clip or overflow.', 'It does not remove font fallback metric differences or align a mixed icon/text row.'] },
    },
    summary: byComponent.map(({ component, count, imbalance }) => ({ component, instances: count, imbalance })),
    components: byComponent,
    samples: all,
  }
  writeFileSync(`${OUT}/vertical-centring-report.json`, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(`${OUT}/vertical-centring-report.md`, `# Vertical centring audit\n\nFrames: ${frames.length}; boards: ${boardCount}; instances: ${all.length}. Headline convention: cap-height. Browser Chromium: ${browser.version()}. CSS text-box-trim supported: ${cssSupport.trim && cssSupport.edge}.\n\n| Component | Instances | Cap min / median / max (px) | X-height min / median / max (px) | Ink min / median / max (px) |\n|---|---:|---:|---:|---:|\n${byComponent.map(item => `| \`${item.component}\` | ${item.count} | ${item.imbalance.cap.min} / ${item.imbalance.cap.median} / ${item.imbalance.cap.max} | ${item.imbalance.xHeight.min} / ${item.imbalance.xHeight.median} / ${item.imbalance.xHeight.max} | ${item.imbalance.ink.min} / ${item.imbalance.ink.median} / ${item.imbalance.ink.max} |`).join('\n')}\n\n## Ten worst instances per component\n\n${byComponent.map(item => `### \`${item.component}\`\n\n${item.worst.map(worst => `- ${worst.capPx}px cap, ${worst.xHeightPx}px x-height, ${worst.inkPx}px ink — \`${worst.key}\` — ${worst.text}`).join('\n')}`).join('\n\n')}\n\n## Candidate fix model\n\n- Text box trim: ${report.candidateFixes.textBoxTrim.supported ? 'supported' : 'unsupported'}; cap imbalance ${report.candidateFixes.textBoxTrim.predictedCapImbalance.min}/${report.candidateFixes.textBoxTrim.predictedCapImbalance.median}/${report.candidateFixes.textBoxTrim.predictedCapImbalance.max}px (min/median/max).\n- Per-face metric offset: ${report.candidateFixes.perFaceOffset.predictedCapImbalance.min}/${report.candidateFixes.perFaceOffset.predictedCapImbalance.median}/${report.candidateFixes.perFaceOffset.predictedCapImbalance.max}px (min/median/max).\n- Line-height matched to font box: ${report.candidateFixes.lineHeightToFontBox.predictedCapImbalance.min}/${report.candidateFixes.lineHeightToFontBox.predictedCapImbalance.median}/${report.candidateFixes.lineHeightToFontBox.predictedCapImbalance.max}px (min/median/max); modeled as unchanged for center-aligned text.\n`)

  // One capture per source frame so the images show distinct offenders.
  const captureSamples: Sample[] = []
  for (const sample of [...all].sort((a, b) => b.imbalance.cap - a.imbalance.cap)) {
    if (captureSamples.some(existing => existing.page === sample.page && existing.frame === sample.frame)) continue
    captureSamples.push(sample)
    if (captureSamples.length === 5) break
  }
  for (let i = 0; i < captureSamples.length; i++) {
    const sample = captureSamples[i]!
    await page.goto(`${origin}/${sample.page}`)
    await settle(page)
    if (sample.page === 'preview.html') {
      const locator = page.locator(`[data-frame-id="${sample.frame}"] > div`)
      await locator.scrollIntoViewIfNeeded()
    } else {
      const nav = page.locator('nav button')
      let opened = false
      for (let index = 0; index < await nav.count(); index++) {
        await nav.nth(index).click()
        await page.locator('main h1').first().waitFor({ state: 'visible' })
        await settle(page)
        if (await page.locator(`main > div[data-alignment-board-id="${sample.frame}"]`).count()) { opened = true; break }
      }
      if (!opened) continue
    }
    await settle(page)
    const selector = sample.page === 'preview.html' ? `[data-frame-id="${sample.frame}"] > div` : `main > div[data-alignment-board-id="${sample.frame}"]`
    const target = page.locator(selector).first()
    const marked = await target.evaluate((root, wanted) => {
      const node = [...root.querySelectorAll('*')].find(el => (el.textContent ?? '').trim().replace(/\s+/g, ' ') === wanted && el.getBoundingClientRect().width > 0)
      if (!node) return false
      node.setAttribute('data-vcentre-capture-target', '')
      return true
    }, sample.text)
    if (!marked) continue
    await page.locator('[data-vcentre-capture-target]').first().scrollIntoViewIfNeeded()
    await page.evaluate(({ selector, number }) => {
      const root = document.querySelector(selector)
      if (!root) return
      const node = root.querySelector('[data-vcentre-capture-target]')
      if (!node) return
      const range = document.createRange(); range.selectNodeContents(node)
      const line = [...range.getClientRects()].find(rect => rect.width && rect.height)
      if (!line) return
      let target: Element | null = node.closest('button,input,[data-slot="chip"],[data-slot="badge"],[role="tab"],[data-slot="tab"]')
      for (let current: Element | null = node; !target && current && current !== root; current = current.parentElement) {
        const style = getComputedStyle(current)
        if ((style.display === 'flex' && style.flexDirection === 'row') && current.getBoundingClientRect().height <= 120) target = current
      }
      target ??= node.parentElement
      const box = target.getBoundingClientRect()
      const overlay = document.createElement('div')
      overlay.dataset.auditOverlay = String(number)
      overlay.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;border:2px solid #ff1744;box-sizing:border-box`
      const glyph = document.createElement('div')
      glyph.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${line.left}px;top:${line.top}px;width:${line.width}px;height:${line.height}px;background:rgba(0,180,255,.25);outline:2px solid #00b4ff;box-sizing:border-box`
      document.body.append(overlay, glyph)
    }, { selector, number: i })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await page.screenshot({ path: `${OUT}/worst-${String(i + 1).padStart(2, '0')}.png`, scale: 'css' })
  }
  await context.close()
  console.log(`Vertical centring audit: ${frames.length} preview frames, ${boardCount} boards, ${all.length} single-line text instances; ${byComponent.length} component groups. JSON: ${OUT}/vertical-centring-report.json`)
})

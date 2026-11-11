import { expect, test, type Page } from '@playwright/test'

/**
 * Nothing inside a right-panel card stands on the card's border.
 *
 * A `ToolSection` gives its body no inline padding: its rows bring their own
 * 12px edge, the edge its label stands on. Anything that is not a row — a
 * group's label, a muted line, a bare button, a list of small rows, a nested
 * table — landed flush against the border, or 4px short of the label, until
 * the design layer gave it the row edge (`ToolGroup`, `ToolBodyControls`,
 * `ToolProse variant="note"`, `ListRows surface="panel"`).
 *
 * This reads every open card in the rail previews and fails any visible text
 * or painted box that starts closer to the card's inner edge than the row
 * inset. One pixel of slack: a panel fact's key sits at 11px.
 *
 * A hairline inside a card is held to the row edge on both sides: a rule
 * between rows that runs from border to border is the card's edge reaching
 * in. It is read as a box whose top or bottom border is painted, or a filled
 * box at most 2px tall (a `Separator`), or a row's `::before`/`::after` rule.
 */
const previews = [
  { url: '/preview.html?lead-synthetic=work-ledger', cards: ['Goal', 'Work', 'Recap', 'Spend'] },
  { url: '/preview.html?lead-synthetic=app-shell', cards: ['Recap', 'Goal', 'Plan', 'Workers', 'Spend'] },
  { url: '/preview.html?team-frame=controls', cards: ['Run', 'Seats'] },
  { url: '/preview.html?flows-page=editor', cards: ['Step · fixer', 'Flow settings'] },
  { url: '/preview.html?inapplicable-actions=check', cards: ['#2 · Verify the change'] },
  { url: '/preview.html?inapplicable-actions=review', cards: ['#3 · Review the change'] },
  { url: '/preview.html?frame-wall=conversation&frame-tool=plugin&frame-plugin-blocks=1', cards: ['Recorded work'] },
  { url: '/preview.html?frame-wall=library&frame-detail=skill&frame-name=code-review', cards: ['Update', 'Loaded by', 'Source', 'Files', 'Cost'] },
] as const

type Flush = { card: string | null; kind: string; what: string; offset: number }

const openEveryCard = async (page: Page) => {
  for (let pass = 0; pass < 12; pass++) {
    const folds = page.locator('[data-slot="tool-section-fold"][aria-expanded="false"]:visible')
    const count = await folds.count()
    if (!count) return
    await folds.first().click()
  }
}

const readFlush = (page: Page) => page.evaluate(() => {
  const probe = document.createElement('div')
  probe.style.paddingLeft = 'var(--hd-inset-row)'
  document.body.append(probe)
  const inset = parseFloat(getComputedStyle(probe).paddingLeft)
  probe.remove()
  const clear = (colour: string) => /rgba\(.*, 0\)|transparent/.test(colour)
  const visible = (r: DOMRect) => r.width > 0 && r.height > 0
  const flush: Flush[] = []
  for (const section of document.querySelectorAll<HTMLElement>('[data-slot="tool-section"]')) {
    const body = section.querySelector<HTMLElement>(':scope > [data-slot="tool-section-body"]')
    const box = section.getBoundingClientRect()
    if (!body || body.hidden || !visible(box)) continue
    const edge = box.left + parseFloat(getComputedStyle(section).borderLeftWidth)
    const endEdge = box.right - parseFloat(getComputedStyle(section).borderRightWidth)
    const bodyWidth = body.getBoundingClientRect().width
    const card = section.getAttribute('aria-label')
    // A card nested in this one answers for its own edge.
    const own = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-slot="tool-section"]') === section
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !own(node)) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = [...range.getClientRects()].filter(visible)
      if (!rects.length) continue
      const left = Math.min(...rects.map(r => r.left))
      if (left - edge < inset - 1) flush.push({ card, kind: 'text', what: node.textContent.trim().slice(0, 50), offset: Math.round(left - edge) })
    }
    for (const element of body.querySelectorAll<HTMLElement | SVGElement>('*')) {
      if (!own(element)) continue
      const outerSvg = element.closest('svg')
      if (outerSvg && outerSvg !== element) continue
      const r = element.getBoundingClientRect()
      if (!visible(r) || r.width <= 1 || r.right <= box.left) continue
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue
      const control = element.matches('button, a, input, select, textarea, svg, img, [role="button"]')
      const leftBorder = parseFloat(style.borderLeftWidth) > 0 && !clear(style.borderLeftColor)
      const filled = !clear(style.backgroundColor)
      const rule = (side: 'Top' | 'Bottom') => parseFloat(style[`border${side}Width`]) > 0 && !clear(style[`border${side}Color`]) && style[`border${side}Style`] !== 'none'
      const hairline = !leftBorder && (rule('Top') || rule('Bottom') || (filled && r.height <= 2))
      if (hairline && (r.left - edge < inset - 1 || endEdge - r.right < inset - 1)) {
        const slot = element.getAttribute('data-slot')
        flush.push({ card, kind: `rule:${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}`, what: (element.textContent ?? '').trim().slice(0, 50), offset: Math.round(Math.min(r.left - edge, endEdge - r.right)) })
        continue
      }
      // A row's rule is often its ::after, a 1px box pinned to the row's sides.
      for (const pseudo of ['::before', '::after'] as const) {
        const after = getComputedStyle(element, pseudo)
        if (after.content === 'none' || after.content === 'normal' || after.display === 'none' || after.position !== 'absolute') continue
        const tall = parseFloat(after.height)
        const painted = (!clear(after.backgroundColor) && tall > 0 && tall <= 2) || ((parseFloat(after.borderTopWidth) > 0 || parseFloat(after.borderBottomWidth) > 0) && !clear(after.borderTopColor))
        if (!painted) continue
        const left = after.left === 'auto' ? r.left : r.left + parseFloat(after.left)
        const right = after.right === 'auto' ? r.right : r.right - parseFloat(after.right)
        if (left - edge < inset - 1 || endEdge - right < inset - 1) {
          const slot = element.getAttribute('data-slot')
          flush.push({ card, kind: `rule:${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}${pseudo}`, what: (element.textContent ?? '').trim().slice(0, 50), offset: Math.round(Math.min(left - edge, endEdge - right)) })
        }
      }
      if (!control && !leftBorder && !filled) continue
      // A full-width band with no edge of its own (a row's hover fill, a divider) is the card's, not a flush box.
      if (!leftBorder && r.width >= bodyWidth - 2) continue
      if (r.left - edge < inset - 1) {
        const slot = element.getAttribute('data-slot')
        flush.push({ card, kind: element.tagName.toLowerCase() + (slot ? `[${slot}]` : ''), what: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 50), offset: Math.round(r.left - edge) })
      }
    }
  }
  return flush
})

for (const { url, cards } of previews) {
  test(`every card's content keeps the row edge: ${url}`, async ({ page }) => {
    await page.goto(url)
    for (const card of cards) await expect(page.locator(`[data-slot="tool-section"][aria-label="${card}"]:visible`).first()).toBeVisible()
    await openEveryCard(page)
    for (const card of cards) await expect(page.locator(`[data-slot="tool-section"][aria-label="${card}"]:visible > [data-slot="tool-section-body"]`).first()).toBeVisible()
    expect(await readFlush(page)).toEqual([])
  })
}

import { expect, test } from '@playwright/test'

/**
 * Nothing you can press is under the floor.
 *
 * `--hd-target-min` is 24px and the system names it twice — once as itself and
 * once as `--hd-icon-target` — and then shipped three controls below it. Two
 * were literals: a card's whole menu hung off a 20px square written as
 * `size-5`, and a segmented control's pressable part came out at 22 because
 * its 26px trough was padded by two rather than one. The third was five
 * buttons whose stylesheet had been asked to draw a box and had lost it, so
 * the target was the height of its own words — fifteen pixels.
 *
 * A floor that three shipped controls sit under is a number, not a floor, and
 * nothing in the tree could see them: the audit reads *declared* squares and
 * two of these declared one axis or none. This reads what a person's finger
 * actually gets.
 *
 * Read from the page rather than listed here, so a control added tomorrow is
 * measured by the same rule on the day it is written.
 */
test('every target on the page clears the floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  // The preview mounts its screens as their modules resolve; the floor is
  // about boxes, so wait until the boxes stop appearing.
  await expect
    .poll(async () => page.locator('button, a[href], [role="button"], [role="tab"], [role="radio"]').count(), { timeout: 15_000 })
    .toBeGreaterThan(80)
  await page.waitForTimeout(600)

  const { floor, under, counted } = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--hd-target-min)'
    const floor = Math.round(probe.getBoundingClientRect().height)
    probe.remove()
    const nodes = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="radio"]')]
    const seen = new Map<string, string>()
    for (const node of nodes) {
      const box = node.getBoundingClientRect()
      // A control with no box is hidden, collapsed or not laid out yet; the
      // floor has nothing to say about it.
      if (box.width === 0 || box.height === 0) continue
      if (Math.min(box.width, box.height) >= floor) continue
      // WCAG 2.5.8's inline exception: "the size of the target is determined
      // by the user agent and is not modified by the author" — a link inside
      // a sentence of running text is sized by the line height around it,
      // and a real transcript is full of such links (a message's own prose,
      // rendered as Markdown). Only that shape is exempt: an inline anchor
      // whose block also carries other words, not a link standing alone.
      if (node.tagName === 'A' && node.hasAttribute('href') && getComputedStyle(node).display === 'inline') {
        const block = node.closest('p, li, [data-slot="markdown"]')
        const blockText = block ? (block.textContent ?? '').trim() : ''
        const linkText = (node.textContent ?? '').trim()
        if (block && blockText.length > linkText.length) continue
      }
      const own = (typeof node.className === 'string' ? node.className : '').match(/_([A-Za-z]+)_[a-z0-9]+_\d+/)
      const who = own ? `.${own[1]}` : String(node.className).split(/\s+/).slice(0, 3).join(' ')
      const label = (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 30)
      seen.set(`${who}|${label}`, `${Math.round(box.width)}x${Math.round(box.height)} ${who} "${label}"`)
    }
    return { floor, under: [...seen.values()], counted: nodes.length }
  })

  // The guard on the guard: a page that rendered nothing would pass an empty
  // list, and a floor read as NaN would make every comparison false.
  expect(floor).toBeGreaterThan(0)
  expect(counted).toBeGreaterThan(80)
  expect(under.join('\n') || `every target clears ${floor}px`).toBe(`every target clears ${floor}px`)
})

/**
 * The exception is for a link the reader met mid-sentence, not for any
 * link that happens to sit inside a paragraph — a block-level or
 * inline-block anchor still draws its own box regardless of the words
 * around it, and a short one of those is exactly the miss this file exists
 * to catch. Proven on a probe rather than trusted from reading the rule,
 * because the rule above is the one place that miss would hide again.
 */
test('the inline exception does not cover a block or inline-block link', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })

  const result = await page.evaluate(() => {
    const isInlineTextLink = (node: Element): boolean => {
      if (node.tagName !== 'A' || !node.hasAttribute('href')) return false
      if (getComputedStyle(node).display !== 'inline') return false
      const block = node.closest('p, li, [data-slot="markdown"]')
      if (!block) return false
      const blockText = (block.textContent ?? '').trim()
      const linkText = (node.textContent ?? '').trim()
      return blockText.length > linkText.length
    }

    const p = document.body.appendChild(document.createElement('p'))
    p.textContent = 'Read '
    const inlineLink = p.appendChild(document.createElement('a'))
    inlineLink.href = '#'
    inlineLink.textContent = 'the note'
    p.append(' for the rest of it.')

    const blockLink = document.body.appendChild(document.createElement('a'))
    blockLink.href = '#'
    blockLink.textContent = 'Open'
    blockLink.style.cssText = 'display:block;height:18px;line-height:18px;width:60px'

    const inlineBlockLink = document.body.appendChild(document.createElement('a'))
    inlineBlockLink.href = '#'
    inlineBlockLink.textContent = 'Open'
    inlineBlockLink.style.cssText = 'display:inline-block;height:18px;line-height:18px;width:60px'

    const result = {
      inline: isInlineTextLink(inlineLink),
      block: isInlineTextLink(blockLink),
      inlineBlock: isInlineTextLink(inlineBlockLink),
      blockHeight: Math.round(blockLink.getBoundingClientRect().height),
      inlineBlockHeight: Math.round(inlineBlockLink.getBoundingClientRect().height),
    }
    p.remove()
    blockLink.remove()
    inlineBlockLink.remove()
    return result
  })

  // The genuine case: a link met mid-sentence, its block carrying more words
  // than the link's own — exempt.
  expect(result.inline).toBe(true)
  // Sized like a real control (18px, under the 24px floor) but not inline:
  // the exception must not reach either, so the floor still catches them.
  expect(result.blockHeight).toBeLessThan(24)
  expect(result.inlineBlockHeight).toBeLessThan(24)
  expect(result.block).toBe(false)
  expect(result.inlineBlock).toBe(false)
})

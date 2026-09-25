/**
 * The judgement calls a token cannot hold, measured on every screen.
 *
 * The audit reads source; these read what the engine lays out, across every
 * frame of the preview harness, because each of them is a question about the
 * words a screen happens to hold rather than about a declaration:
 *
 * - A sentence arrives whole. Rule 9: names and paths truncate, sentences
 *   wrap. A description, a note or a dialog's body cut by an ellipsis is a
 *   line that was either not earned or not laid out. The Settings row used to
 *   cut every description by default, and 30 screens opted out one at a time.
 * - A title stays on one line at the width the app is drawn for. A page's
 *   name, a section's label and a dialog's question are names, and a name that
 *   wraps at 1440px is a sentence wearing a title's type.
 * - Nothing read as a sentence ends on a one-word line. "afterwards." used to
 *   stand alone under a confirm's question.
 * - A second line every row of a group repeats belongs to the group, once.
 *   The room roster said "has not used the board" four times.
 */
import { expect, test, type Page } from '@playwright/test'

type Finding = { frame: string; where: string; text: string }

/** Every frame of the preview harness is an h2 caption over its frame. */
const frames = async (page: Page) => {
  await page.goto('/preview.html')
  await expect(page.locator('h2').first()).toBeVisible()
  await page.evaluate(() => {
    for (const heading of document.querySelectorAll('h2')) {
      const frame = heading.nextElementSibling
      if (frame && heading.textContent?.includes('—')) frame.setAttribute('data-taste', heading.textContent.trim())
    }
  })
}

/* Shared in-page helpers, passed as source so each evaluate can use them. */
const HELPERS = `
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const c = getComputedStyle(el)
    return c.visibility !== 'hidden' && c.display !== 'none'
  }
  const words = (el) => (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim()
  const lineTops = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const tops = new Set()
    for (const rect of range.getClientRects()) if (rect.width > 1 && rect.height > 4) tops.add(Math.round(rect.top / 4))
    return tops.size
  }
  const lastLine = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const found = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const m of node.data.matchAll(/\\S+/g)) {
        const r = document.createRange()
        r.setStart(node, m.index)
        r.setEnd(node, m.index + m[0].length)
        const rect = r.getClientRects()[0]
        if (rect) found.push({ word: m[0], top: Math.round(rect.top) })
      }
    }
    if (found.length < 4) return null
    const top = found[found.length - 1].top
    return found.filter((x) => Math.abs(x.top - top) < 3).map((x) => x.word)
  }
  const frameOf = (el) => el.closest('[data-taste]')?.getAttribute('data-taste') ?? 'page'
  const slotOf = (el) => el.getAttribute('data-slot') ?? el.closest('[data-slot]')?.getAttribute('data-slot') ?? el.tagName.toLowerCase()
`

/** What is read as a sentence: descriptions, notes and bodies. */
const SENTENCES = [
  '[data-slot$="-description"]',
  '[data-slot="section-description"]',
  '[class*="rowDesc"]',
  '[class*="pageBlurb"]',
  '[class*="detailBlurb"]',
  '[data-slot="confirm-body"]',
  '[data-slot="channel-body"]',
  '[role="dialog"] p',
  '[role="alertdialog"] p',
].join(', ')

const TITLES = [
  '[data-slot="page-title"]',
  '[data-slot="section-name"]',
  '[data-slot$="dialog-title"]',
].join(', ')

const cutSentences = (page: Page, root: string) =>
  page.evaluate(
    ([helpers, selector, root]) =>
      new Function('selector', 'root', `${helpers}
        const out = []
        for (const el of document.querySelectorAll(root)) for (const text of el.querySelectorAll(selector)) {
          if (!visible(text)) continue
          const c = getComputedStyle(text)
          const clamped = c.webkitLineClamp && c.webkitLineClamp !== 'none'
          const cut = clamped ? text.scrollHeight > text.clientHeight + 1 : c.textOverflow === 'ellipsis' && text.scrollWidth > text.clientWidth + 1
          const said = words(text)
          if (cut && said.split(' ').length >= 5) out.push({ frame: frameOf(text), where: slotOf(text), text: said.slice(0, 90) })
        }
        return out`)(selector, root) as Finding[],
    [HELPERS, SENTENCES, root] as const,
  )

const wrappedTitles = (page: Page, root: string) =>
  page.evaluate(
    ([helpers, selector, root]) =>
      new Function('selector', 'root', `${helpers}
        const out = []
        for (const el of document.querySelectorAll(root)) for (const title of el.querySelectorAll(selector)) {
          if (visible(title) && lineTops(title) > 1) out.push({ frame: frameOf(title), where: slotOf(title), text: words(title).slice(0, 90) })
        }
        return out`)(selector, root) as Finding[],
    [HELPERS, TITLES, root] as const,
  )

const widows = (page: Page, root: string) =>
  page.evaluate(
    ([helpers, selector, root]) =>
      new Function('selector', 'root', `${helpers}
        const out = []
        for (const el of document.querySelectorAll(root)) for (const text of el.querySelectorAll(selector)) {
          if (!visible(text) || lineTops(text) < 2) continue
          const last = lastLine(text)
          if (last && last.length === 1) out.push({ frame: frameOf(text), where: slotOf(text), text: words(text).slice(-60) })
        }
        return out`)(selector, root) as Finding[],
    [HELPERS, SENTENCES, root] as const,
  )

test('no sentence on any screen is cut off by an ellipsis', async ({ page }) => {
  await frames(page)
  expect(await cutSentences(page, '[data-taste]')).toEqual([])
})

test('no page, section or dialog title wraps at the width the app is drawn for', async ({ page }) => {
  await frames(page)
  expect(await wrappedTitles(page, '[data-taste]')).toEqual([])
})

test('nothing read as a sentence ends on a one-word line', async ({ page }) => {
  await frames(page)
  expect(await widows(page, '[data-taste]')).toEqual([])
})

test('a confirm reads whole, on balanced lines, with no word left alone', async ({ page }) => {
  await page.goto('/design.html')
  await page.getByRole('navigation').getByRole('button', { name: 'Dialog · ConfirmDialog', exact: true }).click()
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  const root = '[role="alertdialog"]'
  expect(await cutSentences(page, root)).toEqual([])
  expect(await wrappedTitles(page, root)).toEqual([])
  expect(await widows(page, root)).toEqual([])
})

test('a second line every row of a group repeats is said once, for the group', async ({ page }) => {
  await frames(page)
  const repeated = await page.evaluate((helpers) =>
    new Function(`${helpers}
      const out = []
      const seconds = '[data-wrap], [class*="rowDesc"], [data-slot$="-description"], [class*="memberIdle"]'
      for (const list of document.querySelectorAll('[data-taste] *')) {
        const rows = [...list.children].filter(visible)
        if (rows.length < 3) continue
        const lines = rows.map((row) => {
          const second = row.querySelector(seconds)
          return second && visible(second) ? words(second) : null
        })
        if (lines.some((line) => line === null)) continue
        if (new Set(lines).size === 1) out.push({ frame: frameOf(list), where: slotOf(list), text: lines[0].slice(0, 90) })
      }
      return out`)() as Finding[],
  HELPERS)
  expect(repeated).toEqual([])
})

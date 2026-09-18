import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

/**
 * Every rendered number in the system, in one table.
 *
 * The token snapshot already refuses a changed token value, and the design
 * audit already refuses a literal written where a token belongs. Neither can
 * see the number a person actually looks at: what a control *composes* to once
 * its variant, its size, its density scope and whatever stylesheet the screen
 * around it brought have all been applied. That composed value is where the
 * drift this repository keeps paying for lives — a module sheet adding two
 * pixels of padding to one screen's rows, a wrapper that makes one page's
 * measure disagree with its neighbour's, a size whose height stopped following
 * its own token months ago. Every one of those passes both existing gates.
 *
 * So this reads them, all of them, off the live catalogue, and holds the result
 * against a recorded table. The interesting failure is not "a number moved" —
 * numbers are supposed to move — it is "a number moved and nobody said so".
 * Re-record with `UPDATE_METRICS=1` and the diff on `metrics.json` is then the
 * change, stated in the units a person can argue about.
 *
 * The probe set is declared where the case is rendered, not here: any element
 * carrying `data-catalog-variant` or `data-catalog-size` is measured, which is
 * the same attribute `ui-catalog.mjs` already reads to prove coverage. A new
 * component joins the table by rendering its cases with the attribute it needs
 * anyway.
 */

const TABLE = fileURLToPath(new URL('../../packages/ui/src/design/metrics.json', import.meta.url))
const UPDATE = process.env.UPDATE_METRICS === '1'

/**
 * Wait until the page stops changing shape.
 *
 * Not ceremony. The dev server hands stylesheets over as modules resolve, so a
 * board is briefly painted with some of its CSS: long enough to measure, and
 * the answer is wrong. The first run of this table caught exactly that — an
 * `IconTile` inherits its type rather than setting it, and read 16px (the
 * document default) on one run and 14px (the app's) on the next, with its box
 * already correctly sized both times. A rig that cannot reproduce its own
 * numbers cannot hold anyone else's.
 *
 * On 2026-09-17 the same shape came back on a different component, on a cold
 * GitHub Actions runner only: `Stat`'s outer box, like `IconTile` before it,
 * takes its type size purely by inheritance — nothing on it sets a `text-*`
 * utility — and it read 16px against a recorded 14px, again with its box
 * already the right height. The serving side turned out not to be the
 * culprit here: this rig's dev server (`@tailwindcss/vite` over Vite) hands
 * the whole cascade over as one `<style>` tag per navigation, not patched in
 * place afterward, so `document.styleSheets.length` alone wasn't actually
 * stale — a local cold-restart repro never caught it moving either. What a
 * `body`-shaped fingerprint cannot rule out is a *descendant* lagging its
 * ancestor: proving `body` itself has the right font tells you nothing about
 * whether some already-painted node several inheritance hops away has been
 * recomputed against it yet, which is exactly the gap a busy, CPU-starved
 * runner can open. So the fingerprint below now also samples the actual
 * cases the caller is about to measure — the same elements, the same
 * property — because settling on what you are about to read is the only
 * version of this check that cannot be one frame ahead of itself. The
 * stylesheet signal is kept but strengthened anyway, from a sheet count to
 * each sheet's own rule count, since a sheet whose rules are replaced in
 * place (a CSS-module hot update, elsewhere in this pipeline) would pass the
 * old count-only check without ever having stopped changing.
 */
const settle = async (page: import('@playwright/test').Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const fingerprint = () => {
      const body = getComputedStyle(document.body)
      const sheets = [...document.styleSheets]
        .map(sheet => {
          try {
            return sheet.cssRules.length
          } catch {
            return 'x' // cross-origin sheet: opaque to us, and not one we can wait on anyway
          }
        })
        .join(',')
      // The exact cases the test is about to read, not a proxy for them —
      // see above. `document.body` can be settled while one of these still
      // isn't.
      const cases = [...document.querySelectorAll('[data-catalog-variant], [data-catalog-size]')]
        .map(node => getComputedStyle(node).fontSize)
        .join(',')
      return `${sheets}|${body.fontSize}|${body.fontFamily}|${body.backgroundColor}|${cases}`
    }
    let previous = ''
    // 120, not 60: a wider margin for a slow cold runner, on top of — not
    // instead of — the fingerprint fix above.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = fingerprint()
      if (current === previous) return
      previous = current
      await frame()
    }
    throw new Error(`stylesheets never settled: ${fingerprint()}`)
  })
}

test('every catalogued case composes to the recorded number', async ({ page }, testInfo) => {
  await page.goto('/design.html?view=coverage')
  await settle(page)
  const views = await page.locator('a[href^="?view="]').evaluateAll(nodes =>
    [...new Set(nodes.map(node => new URL((node as HTMLAnchorElement).href).searchParams.get('view')!))].sort())
  expect(views.length).toBeGreaterThan(10)

  const measured: Record<string, unknown> = {}
  const collisions: string[] = []
  for (const view of views) {
    await page.goto(`/design.html?view=${view}`)
    await settle(page)
    // A board that renders nothing measurable is not a failure; a board that
    // fails to render is, and the error surfaces as a missing key below.
    const cases = await page.locator('[data-catalog-variant], [data-catalog-size]').evaluateAll(nodes => {
      // Only what a person can see; colour belongs to the contrast tests.
      const px = (value: string) => Math.round(parseFloat(value) * 100) / 100
      return nodes.map(node => {
        const axis = node.getAttribute('data-catalog-variant') ? 'variant' : 'size'
        const css = getComputedStyle(node)
        /* Which component this case belongs to, not only which axis value it
           carries. Four different controls render `size/default` on one board;
           without the component in the key the last one written wins and the
           other three are unmeasured while the table claims to hold them. */
        const who = node.getAttribute('data-slot') ?? node.tagName.toLowerCase()
        return [`${who}/${axis}/${node.getAttribute(`data-catalog-${axis}`)}`, {
          h: Math.round(node.getBoundingClientRect().height * 100) / 100,
          text: px(css.fontSize),
          weight: css.fontWeight,
          line: css.lineHeight === 'normal' ? 'normal' : px(css.lineHeight),
          pad: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(px).join(' '),
          radius: px(css.borderTopLeftRadius),
        }] as const
      })
    })
    for (const [key, value] of cases) {
      const full = `${view}/${key}`
      /* A collision is not a tie to be broken — it means two cases the table
         claims to hold are really one, and the loser is unmeasured. */
      if (full in measured) collisions.push(full)
      measured[full] = value
    }
  }

  expect(collisions.join('\n') || 'every case has its own key').toBe('every case has its own key')

  expect(Object.keys(measured).length).toBeGreaterThan(20)

  if (UPDATE) {
    const ordered = Object.fromEntries(Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(TABLE, `${JSON.stringify(ordered, null, 2)}\n`)
    testInfo.annotations.push({ type: 'recorded', description: `${Object.keys(ordered).length} cases` })
    return
  }

  const recorded = JSON.parse(readFileSync(TABLE, 'utf8'))
  const drift = Object.entries(measured)
    .filter(([key, value]) => JSON.stringify(recorded[key]) !== JSON.stringify(value))
    .map(([key, value]) => `${key}\n  recorded ${JSON.stringify(recorded[key])}\n  measured ${JSON.stringify(value)}`)
  const gone = Object.keys(recorded).filter(key => !(key in measured))
  await testInfo.attach('metrics', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' })
  expect(
    [...drift, ...gone.map(key => `${key}\n  recorded, no longer rendered`)].join('\n\n') ||
      'the table holds',
  ).toBe('the table holds')
})

/**
 * The two rules the table exists to keep, checked as relations rather than as
 * values — a relation survives a deliberate re-record, which is exactly what a
 * consistency rule has to do.
 */
test('the composed numbers stay on the scale', async ({ page }) => {
  const recorded: Record<string, { text: number; h: number }> = JSON.parse(readFileSync(TABLE, 'utf8'))
  await page.goto('/design.html?view=foundation')
  await settle(page)
  const scale = await page.evaluate(() => {
    const css = getComputedStyle(document.body)
    return Object.fromEntries(['--hd-text-xs', '--hd-text-sm', '--hd-text', '--hd-text-lg', '--hd-heading', '--hd-display']
      .map(name => [name, parseFloat(css.getPropertyValue(name))]))
  })
  // A step that reads back as NaN is a token the page never received, which
  // would quietly turn the check below into one that cannot fail.
  expect(Object.entries(scale).filter(([, size]) => !Number.isFinite(size)).map(([name]) => name)).toEqual([])
  const steps = Object.values(scale)

  const offScale = Object.entries(recorded)
    .filter(([, value]) => Number.isFinite(value.text) && !steps.includes(value.text))
    .map(([key, value]) => `${key} at ${value.text}px`)
  expect(offScale.join('\n') || 'every case is on the scale').toBe('every case is on the scale')
})

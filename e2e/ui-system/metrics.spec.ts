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
 *
 * Review on that fix (PR #767) found the loop below still exited as soon as
 * any two consecutive samples matched, which a richer fingerprint cannot fix
 * on its own: a value that has not changed *yet* is not a value that will
 * not change, and two samples one frame apart only rule out the first kind.
 * The reviewer's own repro made this concrete — a case starting at 16px
 * whose real, 14px stylesheet lands 100ms later read as "settled" at 16px
 * after 18ms, because nothing had changed in the one frame gap the old loop
 * happened to check. So settling is no longer "the last two samples agree";
 * it is "no sample has disagreed for a real stretch of wall-clock time",
 * tracked below by resetting the stability clock on every change and only
 * returning once it has been quiet for `STABLE_MS`. `settle waits out a
 * style update that lands after it looked stable` (below) pins this down
 * with the reviewer's own scenario.
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
    const STABLE_MS = 300 // comfortably past the 100ms delay the review reproduced
    const TIMEOUT_MS = 6000
    const start = performance.now()
    let previous = fingerprint()
    let stableSince = start
    while (true) {
      await frame()
      const now = performance.now()
      const current = fingerprint()
      if (current !== previous) {
        previous = current
        stableSince = now
      } else if (now - stableSince >= STABLE_MS) {
        return
      }
      if (now - start >= TIMEOUT_MS) throw new Error(`stylesheets never settled: ${current}`)
    }
  })
}

/**
 * The exact race a reviewer found in `settle()` (see the comment above it):
 * a case that reads one value, keeps it for a single frame, then changes to
 * its real value 100ms later. A `settle()` that declares victory on the
 * first repeated sample reads the page here as 16px; this only passes
 * against the version that waits out a real stretch of quiet.
 */
test('settle waits out a style update that lands after it looked stable', async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <!-- No inline style: it would out-specificity the stylesheet rule
             below forever, which would make this fixture pass for the wrong
             reason. Starting unstyled means the browser's 16px default is
             the honest stand-in for "before the app's CSS has arrived". -->
        <div data-catalog-size="probe"></div>
        <script>
          setTimeout(() => {
            const style = document.createElement('style')
            style.textContent = '[data-catalog-size] { font-size: 14px }'
            document.head.appendChild(style)
          }, 100)
        </script>
      </body>
    </html>
  `)
  await settle(page)
  const fontSize = await page.locator('[data-catalog-size]').evaluate(node => getComputedStyle(node).fontSize)
  expect(fontSize).toBe('14px')
})

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
